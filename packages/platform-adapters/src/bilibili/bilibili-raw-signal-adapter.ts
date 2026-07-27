import type { RawPlaybackSignal } from '@lyric-stage/playback-core';
import type { AdapterClock, DocumentPort, RawSignalAdapter, RawSignalListener } from '../types.js';
import {
  parseBilibiliRoute,
  readBilibiliPageNumber,
  resolveBilibiliEpisodeId,
} from './route.js';

/**
 * Player containers first, bare <video> last: bilibili pages embed preview
 * players in recommendation cards; scoring keeps the real player on top.
 */
const VIDEO_SELECTORS = [
  '#bilibili-player video',
  '.bpx-player-container video',
  '.bpx-player-video-wrap video',
  'video.bpx-player-video',
  'video',
].join(', ');

const DEFAULT_POLL_MS = 500;

export interface BilibiliRawSignalAdapterOptions {
  readonly document: DocumentPort;
  readonly clock: AdapterClock;
  readonly producerInstanceId?: string;
  readonly pollIntervalMs?: number;
  readonly setIntervalFn?: (handler: () => void, ms: number) => number;
  readonly clearIntervalFn?: (id: number) => void;
}

/**
 * Bilibili raw signal producer for Extension content runtimes, following the
 * YouTube adapter's structure with the userscript's platform knowledge:
 * URL re-parse per poll covers SPA navigation, multi-part videos carry the
 * part number in contextId, and bangumi ss routes upgrade to the episode id
 * when the document exposes it. Plain media elements only — bilibili has no
 * in-stream ad streams on normal videos and needs no MAIN-world page clock.
 */
export class BilibiliRawSignalAdapter implements RawSignalAdapter {
  readonly #document: DocumentPort;
  readonly #clock: AdapterClock;
  readonly #producerInstanceId: string;
  readonly #pollIntervalMs: number;
  readonly #setIntervalFn: (handler: () => void, ms: number) => number;
  readonly #clearIntervalFn: (id: number) => void;
  #listener: RawSignalListener | null = null;
  #timer: number | null = null;
  #producerSequence = 0;
  #sessionCandidateId: string;
  #lastContentPositionMs = 0;
  #lastIdentityKey: string | null = null;

  constructor(options: BilibiliRawSignalAdapterOptions) {
    this.#document = options.document;
    this.#clock = options.clock;
    this.#producerInstanceId = options.producerInstanceId ?? `bilibili-producer:${cryptoRandom()}`;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.#setIntervalFn = options.setIntervalFn
      ?? ((handler, ms) => globalThis.setInterval(handler, ms) as unknown as number);
    this.#clearIntervalFn = options.clearIntervalFn
      ?? ((id) => globalThis.clearInterval(id));
    this.#sessionCandidateId = `session-candidate:${cryptoRandom()}`;
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
    if (this.#timer !== null) {
      this.#clearIntervalFn(this.#timer);
      this.#timer = null;
    }
    this.#listener = null;
  }

  public sample(): RawPlaybackSignal | null {
    const identity = this.#resolveIdentity();
    const video = this.#findBestVideo();
    const capturedAtMs = this.#clock.now();
    this.#producerSequence += 1;

    if (!identity && !video) {
      return this.#emit({
        capturedAtMs,
        positionMs: null,
        durationMs: null,
        playbackState: 'unavailable',
        rate: 1,
        seeking: false,
        sourceKind: 'media-element',
        sourceInstanceId: 'bilibili:none',
        mediaIdentity: null,
        confidence: 0,
        eventKind: 'source-lost',
      });
    }

    // SPA navigation and part switches rotate the session so downstream
    // arbitration never splices two parts into one timeline.
    const identityKey = identity
      ? `bilibili:${identity.externalId}:${identity.contextId ?? ''}`
      : null;
    if (identityKey && this.#lastIdentityKey && this.#lastIdentityKey !== identityKey) {
      this.#sessionCandidateId = `session-candidate:${cryptoRandom()}`;
      this.#lastContentPositionMs = 0;
    }
    if (identityKey) this.#lastIdentityKey = identityKey;

    if (!video) {
      return this.#emit({
        capturedAtMs,
        positionMs: this.#lastContentPositionMs || null,
        durationMs: null,
        playbackState: 'unavailable',
        rate: 1,
        seeking: false,
        sourceKind: 'media-element',
        sourceInstanceId: identity
          ? `bilibili:${identity.externalId}:missing-video`
          : 'bilibili:missing-video',
        mediaIdentity: identity,
        confidence: 0.2,
        eventKind: 'source-lost',
      });
    }

    const durationMs = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration * 1000
      : null;
    const mediaSourceInstanceId = identity
      ? `bilibili:${identity.externalId}:media`
      : `bilibili:media:${video.currentSrc || video.src || 'anonymous'}`;
    const hasMetadata = (video.readyState ?? 0) >= 1;
    const rawPosition = hasMetadata && Number.isFinite(video.currentTime)
      ? Math.max(0, video.currentTime * 1000)
      : null;

    if (rawPosition !== null) this.#lastContentPositionMs = rawPosition;
    const playbackState = video.ended
      ? 'ended'
      : video.seeking
        ? 'buffering'
        : video.paused
          ? 'paused'
          : 'playing';

    return this.#emit({
      capturedAtMs,
      positionMs: rawPosition,
      durationMs,
      playbackState,
      rate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
      seeking: Boolean(video.seeking),
      sourceKind: 'media-element',
      sourceInstanceId: mediaSourceInstanceId,
      mediaIdentity: identity,
      confidence: hasMetadata ? 1 : 0.45,
      eventKind: video.seeking ? 'seek-start' : 'sample',
    });
  }

  #resolveIdentity(): {
    readonly platform: 'bilibili';
    readonly externalId: string;
    readonly contextId?: string;
  } | null {
    const route = parseBilibiliRoute(this.#document.location.href);
    if (!route) return null;
    if (route.type === 'video') {
      const page = readBilibiliPageNumber(
        this.#document.location.href,
        this.#document,
      );
      return {
        platform: 'bilibili',
        externalId: route.externalId,
        contextId: `p:${page}`,
      };
    }
    // Bangumi: prefer the concrete episode over a season-level ss id.
    const externalId = route.externalId.startsWith('ss')
      ? resolveBilibiliEpisodeId(this.#document) ?? route.externalId
      : route.externalId;
    return { platform: 'bilibili', externalId };
  }

  #findBestVideo(): import('../types.js').MediaElementPort | null {
    const nodes = [...this.#document.querySelectorAll(VIDEO_SELECTORS)];
    if (nodes.length === 0) return null;
    let best: import('../types.js').MediaElementPort | null = null;
    let bestScore = -1;
    for (const video of nodes) {
      if (!isVideoLike(video)) continue;
      if (!video.isConnected) continue;
      // Userscript scoring: playing beats everything, then metadata-ready,
      // then rendered size — recommendation-card previews lose on all three.
      const score = ((video.clientWidth ?? 0) * (video.clientHeight ?? 0))
        + (!video.paused && !video.ended ? 10_000_000 : 0)
        + ((video.readyState ?? 0) >= 1 ? 1_000_000 : 0);
      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }
    return best;
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

function cryptoRandom(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(16).slice(2)}`;
}

function isVideoLike(value: unknown): value is import('../types.js').MediaElementPort {
  if (typeof value !== 'object' || value === null) return false;
  const video = value as Partial<import('../types.js').MediaElementPort>;
  return typeof video.readyState === 'number'
    || (
      typeof video.paused === 'boolean'
      && typeof video.ended === 'boolean'
      && typeof video.currentTime === 'number'
    );
}
