import type { RawPlaybackSignal } from '@lyric-stage/playback-core';
import type {
  AdapterClock,
  DocumentPort,
  PageClockPort,
  RawSignalAdapter,
  RawSignalListener,
} from '../types.js';
import {
  extractNeteaseSongId,
  findNeteaseSongIdFromDocument,
  pickTrustedAudio,
} from './route.js';

export interface NeteaseRawSignalAdapterOptions {
  readonly document: DocumentPort;
  readonly clock: AdapterClock;
  /** Trusted MAIN-world / page media clock. Not DOM progress scraping. */
  readonly pageClock?: PageClockPort | null;
  readonly producerInstanceId?: string;
  readonly pollIntervalMs?: number;
  readonly setIntervalFn?: (handler: () => void, ms: number) => number;
  readonly clearIntervalFn?: (id: number) => void;
}

/**
 * NetEase Cloud Music raw signal producer.
 *
 * Priority:
 * 1. Trusted HTMLAudioElement visible to isolated content
 * 2. Trusted pageClock (MAIN-world media tracker / platform API)
 * 3. source-lost (never scrape `.m-pbar` / clock labels for timeline)
 */
export class NeteaseRawSignalAdapter implements RawSignalAdapter {
  readonly #document: DocumentPort;
  readonly #clock: AdapterClock;
  readonly #pageClock: PageClockPort | null;
  readonly #producerInstanceId: string;
  readonly #pollIntervalMs: number;
  readonly #setIntervalFn: (handler: () => void, ms: number) => number;
  readonly #clearIntervalFn: (id: number) => void;
  #listener: RawSignalListener | null = null;
  #timer: number | null = null;
  #producerSequence = 0;
  #sessionCandidateId: string;
  #lastSongId: string | null = null;
  #lastContentPositionMs: number | null = null;
  #lastDurationMs: number | null = null;

  constructor(options: NeteaseRawSignalAdapterOptions) {
    this.#document = options.document;
    this.#clock = options.clock;
    this.#pageClock = options.pageClock ?? null;
    this.#producerInstanceId = options.producerInstanceId ?? `netease-producer:${id()}`;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.#setIntervalFn = options.setIntervalFn
      ?? ((handler, ms) => globalThis.setInterval(handler, ms) as unknown as number);
    this.#clearIntervalFn = options.clearIntervalFn
      ?? ((handle) => globalThis.clearInterval(handle));
    this.#sessionCandidateId = `session-candidate:${id()}`;
  }

  public start(listener: RawSignalListener): void {
    this.stop();
    this.#listener = listener;
    const first = this.sample();
    if (first) listener(first);
    this.#timer = this.#setIntervalFn(() => {
      const signal = this.sample();
      if (signal && this.#listener) this.#listener(signal);
    }, this.#pollIntervalMs);
  }

  public stop(): void {
    if (this.#timer !== null) this.#clearIntervalFn(this.#timer);
    this.#timer = null;
    this.#listener = null;
  }

  public sample(): RawPlaybackSignal | null {
    const songId = findNeteaseSongIdFromDocument(this.#document)
      ?? extractNeteaseSongId(this.#document.location.href);
    if (songId && this.#lastSongId && songId !== this.#lastSongId) {
      this.#sessionCandidateId = `session-candidate:${id()}`;
      this.#lastContentPositionMs = null;
      this.#lastDurationMs = null;
    }
    if (songId) this.#lastSongId = songId;
    const resolvedSongId = songId ?? this.#lastSongId;

    const audio = pickTrustedAudio(this.#document.querySelectorAll('audio'));
    const capturedAtMs = this.#clock.now();
    this.#producerSequence += 1;

    // Prefer pageClock even when a dead/empty DOM audio is visible — NetEase
    // isolated world often sees no real media node while MAIN has the clock.
    const pageClock = this.#pageClock?.getLatestSample() ?? null;
    const audioPositionMs = audio && Number.isFinite(audio.currentTime)
      ? Math.max(0, audio.currentTime * 1000)
      : null;
    const pagePositionMs = pageClock
      && pageClock.positionMs !== null
      && Number.isFinite(pageClock.positionMs)
      ? pageClock.positionMs
      : null;
    const preferPageClock = pagePositionMs !== null && (
      !audio
      || pageClock!.confidence >= 0.7
      || audio.paused
      // Isolated shell stuck near 0 while MAIN reports real progress.
      || (
        (audioPositionMs === null || audioPositionMs < 500)
        && pagePositionMs > 500
      )
      || (
        audioPositionMs !== null
        && pagePositionMs > audioPositionMs + 1_500
      )
    );
    if (preferPageClock && pageClock && pagePositionMs !== null) {
      // The page-clock poller and this adapter poll on independent 250ms
      // cadences: the sample can be a full poll interval old here, and
      // re-stamping it with our own capturedAtMs claimed it was fresh —
      // a 0-250ms systematic lag the surface clock could never see or
      // compensate. Project the position by the sample's true age instead.
      const sampleAgeMs = Math.max(0, capturedAtMs - pageClock.capturedAtMs);
      const agedPositionMs = pageClock.playbackState === 'playing' && !pageClock.seeking
        ? pagePositionMs + sampleAgeMs * (Number.isFinite(pageClock.rate) ? pageClock.rate : 1)
        : pagePositionMs;
      this.#lastContentPositionMs = agedPositionMs;
      if (pageClock.durationMs !== null) {
        this.#lastDurationMs = pageClock.durationMs;
      }
      const mediaId = resolvedSongId
        ?? pageClock.mediaExternalIdHint
        ?? null;
      return this.#emit({
        capturedAtMs,
        positionMs: agedPositionMs,
        durationMs: pageClock.durationMs ?? this.#lastDurationMs,
        playbackState: pageClock.playbackState,
        rate: Number.isFinite(pageClock.rate) ? pageClock.rate : 1,
        seeking: Boolean(pageClock.seeking),
        sourceKind: pageClock.sourceKind,
        sourceInstanceId: sourceInstanceId(mediaId),
        mediaIdentity: mediaId
          ? { platform: 'netease', externalId: mediaId }
          : null,
        confidence: mediaId
          ? pageClock.confidence
          : Math.max(0, pageClock.confidence - 0.25),
        eventKind: pageClock.seeking ? 'seek-start' : 'sample',
      });
    }

    if (!audio) {
      return this.#emit({
        capturedAtMs,
        positionMs: this.#lastContentPositionMs,
        durationMs: this.#lastDurationMs,
        playbackState: 'unavailable',
        rate: 1,
        seeking: false,
        sourceKind: 'page-state',
        sourceInstanceId: sourceInstanceId(resolvedSongId),
        mediaIdentity: resolvedSongId
          ? { platform: 'netease', externalId: resolvedSongId }
          : null,
        confidence: resolvedSongId ? 0.25 : 0,
        eventKind: 'source-lost',
      });
    }

    const durationMs = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration * 1000
      : null;
    const positionMs = Number.isFinite(audio.currentTime)
      ? Math.max(0, audio.currentTime * 1000)
      : null;
    if (positionMs !== null) this.#lastContentPositionMs = positionMs;
    if (durationMs !== null) this.#lastDurationMs = durationMs;
    const playbackState = audio.ended
      ? 'ended'
      : audio.seeking
        ? 'buffering'
        : audio.paused
          ? 'paused'
          : 'playing';

    return this.#emit({
      capturedAtMs,
      positionMs: positionMs ?? this.#lastContentPositionMs,
      durationMs: durationMs ?? this.#lastDurationMs,
      playbackState,
      rate: Number.isFinite(audio.playbackRate) ? audio.playbackRate : 1,
      seeking: Boolean(audio.seeking),
      sourceKind: 'media-element',
      sourceInstanceId: sourceInstanceId(resolvedSongId),
      mediaIdentity: resolvedSongId
        ? { platform: 'netease', externalId: resolvedSongId }
        : null,
      confidence: resolvedSongId ? 1 : 0.6,
      eventKind: audio.seeking ? 'seek-start' : 'sample',
    });
  }

  #emit(partial: Omit<
    RawPlaybackSignal,
    'producerInstanceId' | 'producerSequence' | 'sessionCandidateId'
  >): RawPlaybackSignal {
    return {
      producerInstanceId: this.#producerInstanceId,
      producerSequence: this.#producerSequence,
      sessionCandidateId: this.#sessionCandidateId,
      ...partial,
    };
  }
}

function sourceInstanceId(songId: string | null): string {
  return songId ? `netease:${songId}:playback` : 'netease:unknown:playback';
}

function id(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(16).slice(2)}`;
}
