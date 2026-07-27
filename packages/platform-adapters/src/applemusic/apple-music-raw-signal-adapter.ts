import type { RawPlaybackSignal } from '@lyric-stage/playback-core';
import type {
  AdapterClock,
  DocumentPort,
  ElementPort,
  MediaElementPort,
  PageClockPort,
  RawSignalAdapter,
  RawSignalListener,
} from '../types.js';
import {
  extractAppleMusicCatalogId,
  findAppleMusicCatalogIdFromDocument,
  isAppleMusicHost,
} from './route.js';

export interface AppleMusicRawSignalAdapterOptions {
  readonly document: DocumentPort;
  readonly clock: AdapterClock;
  /** Trusted MAIN-world MusicKit / media clock. */
  readonly pageClock?: PageClockPort | null;
  readonly producerInstanceId?: string;
  readonly pollIntervalMs?: number;
  readonly setIntervalFn?: (handler: () => void, ms: number) => number;
  readonly clearIntervalFn?: (id: number) => void;
}

/**
 * Apple Music web raw signal producer.
 *
 * Priority:
 * 1. Trusted pageClock (MAIN MusicKit currentPlaybackTime)
 * 2. Visible HTMLMediaElement fallback
 * 3. source-lost with last known identity
 */
export class AppleMusicRawSignalAdapter implements RawSignalAdapter {
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
  #lastCatalogId: string | null = null;
  #lastContentPositionMs: number | null = null;
  #lastDurationMs: number | null = null;

  constructor(options: AppleMusicRawSignalAdapterOptions) {
    this.#document = options.document;
    this.#clock = options.clock;
    this.#pageClock = options.pageClock ?? null;
    this.#producerInstanceId = options.producerInstanceId ?? `applemusic-producer:${id()}`;
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
    if (
      !isAppleMusicHost(this.#document.location.href)
      && !this.#looksLikeApplePath()
    ) {
      return null;
    }

    const capturedAtMs = this.#clock.now();
    this.#producerSequence += 1;

    const pageClock = this.#pageClock?.getLatestSample() ?? null;
    const pagePositionMs = pageClock
      && pageClock.positionMs !== null
      && Number.isFinite(pageClock.positionMs)
      ? pageClock.positionMs
      : null;

    // Identity priority (critical after track 1):
    // 1) MAIN nowPlaying hint from page-clock
    // 2) sticky last good id
    // 3) LCD / URL only as cold-start fallback
    // Never prefer browse-page URL over nowPlaying — that thrashes mediaId.
    const pageHint = pageClock?.mediaExternalIdHint
      && isStableAppleMediaId(pageClock.mediaExternalIdHint)
      ? pageClock.mediaExternalIdHint
      : null;
    const docId = findAppleMusicCatalogIdFromDocument(this.#document)
      ?? extractAppleMusicCatalogId(this.#document.location.href);
    const nextId = pageHint
      ?? this.#lastCatalogId
      ?? (docId && isStableAppleMediaId(docId) ? docId : null);

    if (nextId && this.#lastCatalogId && nextId !== this.#lastCatalogId) {
      // Only treat as session change when page-clock confirms a new id
      // (or we had no page hint and doc id is the sole source).
      if (pageHint || !pageClock) {
        this.#sessionCandidateId = `session-candidate:${id()}`;
        this.#lastContentPositionMs = null;
        this.#lastDurationMs = null;
        this.#lastCatalogId = nextId;
      }
      // If pageHint is null but doc disagrees with sticky last — ignore doc.
    } else if (nextId) {
      this.#lastCatalogId = nextId;
    }

    const resolvedId = this.#lastCatalogId;

    if (pageClock && pagePositionMs !== null) {
      // Project by the sample's true age — the poller and this adapter run on
      // independent cadences, and re-stamping hid up to a poll interval of lag.
      const sampleAgeMs = Math.max(0, capturedAtMs - pageClock.capturedAtMs);
      const agedPositionMs = pageClock.playbackState === 'playing' && !pageClock.seeking
        ? pagePositionMs + sampleAgeMs * (Number.isFinite(pageClock.rate) ? pageClock.rate : 1)
        : pagePositionMs;
      this.#lastContentPositionMs = agedPositionMs;
      if (pageClock.durationMs !== null) {
        this.#lastDurationMs = pageClock.durationMs;
      }
      const mediaId = pageHint ?? resolvedId ?? null;
      if (mediaId && isStableAppleMediaId(mediaId)) {
        this.#lastCatalogId = mediaId;
      }
      return this.#emit({
        capturedAtMs,
        positionMs: agedPositionMs,
        durationMs: pageClock.durationMs ?? this.#lastDurationMs,
        playbackState: pageClock.playbackState,
        rate: Number.isFinite(pageClock.rate) ? pageClock.rate : 1,
        seeking: Boolean(pageClock.seeking),
        sourceKind: pageClock.sourceKind,
        sourceInstanceId: sourceInstanceId(mediaId),
        // Prefer a real catalog id; fall back to "listening" so content can
        // still promote the tab into the popup source list.
        mediaIdentity: mediaId
          ? { platform: 'applemusic', externalId: mediaId }
          : { platform: 'applemusic', externalId: 'listening' },
        confidence: mediaId
          ? pageClock.confidence
          : Math.max(0.2, pageClock.confidence),
        eventKind: pageClock.seeking ? 'seek-start' : 'sample',
      });
    }

    // Fallback: isolated-visible media (rare on music.apple.com).
    const media = pickBestMedia(this.#document.querySelectorAll('audio, video'));
    if (media) {
      const durationMs = Number.isFinite(media.duration) && media.duration > 0
        ? media.duration * 1000
        : null;
      const positionMs = Number.isFinite(media.currentTime)
        ? Math.max(0, media.currentTime * 1000)
        : null;
      if (positionMs !== null) this.#lastContentPositionMs = positionMs;
      if (durationMs !== null) this.#lastDurationMs = durationMs;
      const playbackState = media.ended
        ? 'ended'
        : media.seeking
          ? 'buffering'
          : media.paused
            ? 'paused'
            : 'playing';
      return this.#emit({
        capturedAtMs,
        positionMs: positionMs ?? this.#lastContentPositionMs,
        durationMs: durationMs ?? this.#lastDurationMs,
        playbackState,
        rate: Number.isFinite(media.playbackRate) ? media.playbackRate : 1,
        seeking: Boolean(media.seeking),
        sourceKind: 'media-element',
        sourceInstanceId: sourceInstanceId(resolvedId),
        mediaIdentity: resolvedId
          ? { platform: 'applemusic', externalId: resolvedId }
          : null,
        confidence: resolvedId ? 0.85 : 0.5,
        eventKind: media.seeking ? 'seek-start' : 'sample',
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
      sourceInstanceId: sourceInstanceId(resolvedId),
      mediaIdentity: {
        platform: 'applemusic',
        externalId: resolvedId ?? 'listening',
      },
      confidence: resolvedId ? 0.25 : 0.15,
      eventKind: 'source-lost',
    });
  }

  #looksLikeApplePath(): boolean {
    const path = this.#document.location.pathname ?? '';
    return /\/(song|album|playlist|library)\//i.test(path);
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

function isMediaElement(
  value: ElementPort | MediaElementPort,
): value is MediaElementPort {
  return typeof (value as MediaElementPort).currentTime === 'number'
    && typeof (value as MediaElementPort).paused === 'boolean';
}

function pickBestMedia(
  elements: Iterable<ElementPort | MediaElementPort>,
): MediaElementPort | null {
  const list = [...elements].filter(isMediaElement);
  if (list.length === 0) return null;
  const playing = list.find((m) => !m.paused && !m.ended && m.currentTime > 0);
  return playing ?? list.find((m) => m.currentTime > 0) ?? list[0] ?? null;
}

function sourceInstanceId(catalogId: string | null): string {
  return catalogId
    ? `applemusic:${catalogId}:playback`
    : 'applemusic:unknown:playback';
}

/** Prefer numeric catalog ids; allow library ids but not placeholders. */
function isStableAppleMediaId(value: string): boolean {
  if (!value || value === 'listening' || value === 'unknown' || value === 'current') {
    return false;
  }
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value);
}

function id(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(16).slice(2)}`;
}
