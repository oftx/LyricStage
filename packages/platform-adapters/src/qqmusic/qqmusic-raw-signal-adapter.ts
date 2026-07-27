import type { RawPlaybackSignal } from '@lyric-stage/playback-core';
import type {
  AdapterClock,
  DocumentPort,
  PageClockPort,
  RawSignalAdapter,
  RawSignalListener,
} from '../types.js';
import {
  extractQqSongMid,
  findQqSongMidFromDocument,
  isQqMusicHost,
  isQqPlayerPage,
  pickBestMediaElement,
} from './route.js';

export interface QqMusicRawSignalAdapterOptions {
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
 * QQ Music raw signal producer for Extension content.
 *
 * Priority:
 * 1. HTMLMediaElement visible to isolated content
 * 2. Trusted pageClock (MAIN-world media tracker / platform API)
 * 3. source-lost (never scrape progress bars or time labels)
 */
export class QqMusicRawSignalAdapter implements RawSignalAdapter {
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
  #lastSongmid: string | null = null;
  #lastContentPositionMs: number | null = null;
  #lastDurationMs: number | null = null;

  constructor(options: QqMusicRawSignalAdapterOptions) {
    this.#document = options.document;
    this.#clock = options.clock;
    this.#pageClock = options.pageClock ?? null;
    this.#producerInstanceId = options.producerInstanceId ?? `qqmusic-producer:${id()}`;
    this.#pollIntervalMs = options.pollIntervalMs ?? 400;
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
    if (!isQqMusicHost(this.#document.location.href) && !this.#looksLikeQqPath()) {
      return null;
    }
    // Off-player pages (homepage, search, songDetail) must not derive media
    // identity from links or the URL — the first /songDetail/ anchor there is
    // an arbitrary recommended song, which previously announced fake sources.
    const onPlayerPage = isQqPlayerPage(this.#document.location.href);
    const songmid = onPlayerPage
      ? findQqSongMidFromDocument(this.#document, {
        includeDocumentWideFallback: true,
      }) ?? extractQqSongMid(this.#document.location.href)
      : findQqSongMidFromDocument(this.#document);
    if (songmid && this.#lastSongmid && songmid !== this.#lastSongmid) {
      this.#sessionCandidateId = `session-candidate:${id()}`;
      this.#lastContentPositionMs = null;
      this.#lastDurationMs = null;
    }
    if (songmid) this.#lastSongmid = songmid;
    const resolvedMid = songmid ?? this.#lastSongmid;

    const media = pickBestMediaElement(
      this.#document.querySelectorAll('audio, video'),
      songmid,
    );
    const capturedAtMs = this.#clock.now();
    this.#producerSequence += 1;

    if (!media) {
      const pageClock = this.#pageClock?.getLatestSample() ?? null;
      if (pageClock && pageClock.positionMs !== null) {
        // Aliasing between the page-clock poller and this adapter's cadence:
        // project by the sample's true age instead of re-stamping as fresh.
        const sampleAgeMs = Math.max(0, capturedAtMs - pageClock.capturedAtMs);
        const agedPositionMs = pageClock.playbackState === 'playing' && !pageClock.seeking
          ? pageClock.positionMs
            + sampleAgeMs * (Number.isFinite(pageClock.rate) ? pageClock.rate : 1)
          : pageClock.positionMs;
        this.#lastContentPositionMs = agedPositionMs;
        if (pageClock.durationMs !== null) {
          this.#lastDurationMs = pageClock.durationMs;
        }
        const mediaMid = resolvedMid
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
          sourceInstanceId: sourceInstanceId(mediaMid),
          mediaIdentity: mediaMid
            ? { platform: 'qqmusic', externalId: mediaMid }
            : null,
          confidence: mediaMid
            ? pageClock.confidence
            : Math.max(0, pageClock.confidence - 0.25),
          eventKind: pageClock.seeking ? 'seek-start' : 'sample',
        });
      }

      return this.#emit({
        capturedAtMs,
        positionMs: this.#lastContentPositionMs,
        durationMs: this.#lastDurationMs,
        playbackState: 'unavailable',
        rate: 1,
        seeking: false,
        sourceKind: 'page-state',
        sourceInstanceId: sourceInstanceId(resolvedMid),
        mediaIdentity: resolvedMid
          ? { platform: 'qqmusic', externalId: resolvedMid }
          : null,
        confidence: resolvedMid ? 0.25 : 0,
        eventKind: 'source-lost',
      });
    }

    const durationMs = Number.isFinite(media.duration) && media.duration > 0
      ? media.duration * 1000
      : null;
    const positionMs = Number.isFinite(media.currentTime)
      ? Math.max(0, media.currentTime * 1000)
      : null;
    if (positionMs !== null && (!media.paused || positionMs > 0)) {
      this.#lastContentPositionMs = positionMs;
    }
    if (durationMs !== null) this.#lastDurationMs = durationMs;
    const playbackState = media.ended
      ? 'ended'
      : media.seeking
        ? 'buffering'
        : media.paused
          ? 'paused'
          : 'playing';
    const mediaMid = resolvedMid
      ?? extractQqSongMid(media.currentSrc || media.src);

    return this.#emit({
      capturedAtMs,
      positionMs: positionMs ?? this.#lastContentPositionMs,
      durationMs: durationMs ?? this.#lastDurationMs,
      playbackState,
      rate: Number.isFinite(media.playbackRate) ? media.playbackRate : 1,
      seeking: Boolean(media.seeking),
      sourceKind: 'media-element',
      sourceInstanceId: sourceInstanceId(mediaMid),
      mediaIdentity: mediaMid
        ? { platform: 'qqmusic', externalId: mediaMid }
        : null,
      confidence: mediaMid ? 1 : 0.6,
      eventKind: media.seeking ? 'seek-start' : 'sample',
    });
  }

  #looksLikeQqPath(): boolean {
    return this.#document.location.href.includes('y.qq.com');
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

function sourceInstanceId(songmid: string | null): string {
  return songmid ? `qqmusic:${songmid}:playback` : 'qqmusic:unknown:playback';
}

function id(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(16).slice(2)}`;
}
