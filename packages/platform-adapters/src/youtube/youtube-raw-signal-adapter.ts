import type { RawPlaybackSignal } from '@lyric-stage/playback-core';
import type { AdapterClock, DocumentPort, RawSignalAdapter, RawSignalListener } from '../types.js';
import { isLikelyYouTubeAdvertisement, parseYouTubeRoute } from './route.js';

const VIDEO_SELECTORS = [
  'video.html5-main-video',
  '#movie_player video',
  '.html5-video-player video',
  '#shorts-player video',
  'ytd-reel-video-renderer[is-active] video',
].join(', ');

const DEFAULT_POLL_MS = 500;

export interface YouTubeRawSignalAdapterOptions {
  readonly document: DocumentPort;
  readonly clock: AdapterClock;
  readonly producerInstanceId?: string;
  readonly pollIntervalMs?: number;
  readonly setIntervalFn?: (handler: () => void, ms: number) => number;
  readonly clearIntervalFn?: (id: number) => void;
}

/**
 * DOM-free-hostable YouTube raw signal producer for Extension content runtimes.
 * Emits playback-core RawPlaybackSignal samples; does not own a lyric renderer.
 */
export class YouTubeRawSignalAdapter implements RawSignalAdapter {
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
  #lastSourceInstanceId: string | null = null;

  constructor(options: YouTubeRawSignalAdapterOptions) {
    this.#document = options.document;
    this.#clock = options.clock;
    this.#producerInstanceId = options.producerInstanceId ?? `youtube-producer:${cryptoRandom()}`;
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
    const route = parseYouTubeRoute(this.#document.location.href);
    const video = this.#findBestVideo();
    const player = video?.closest?.('.html5-video-player')
      ?? video?.closest?.('#movie_player')
      ?? this.#document.querySelector('#movie_player, .html5-video-player');
    const advertising = isLikelyYouTubeAdvertisement(player, video);
    const capturedAtMs = this.#clock.now();
    this.#producerSequence += 1;

    if (!route && !video) {
      return this.#emit({
        capturedAtMs,
        positionMs: null,
        durationMs: null,
        playbackState: 'unavailable',
        rate: 1,
        seeking: false,
        sourceKind: 'media-element',
        sourceInstanceId: 'youtube:none',
        mediaIdentity: null,
        confidence: 0,
        eventKind: 'source-lost',
      });
    }

    if (route && this.#lastSourceInstanceId && this.#lastSourceInstanceId !== `youtube:${route.externalId}`) {
      this.#sessionCandidateId = `session-candidate:${cryptoRandom()}`;
      this.#lastContentPositionMs = 0;
    }
    if (route) this.#lastSourceInstanceId = `youtube:${route.externalId}`;

    if (!video) {
      return this.#emit({
        capturedAtMs,
        positionMs: this.#lastContentPositionMs || null,
        durationMs: null,
        playbackState: 'unavailable',
        rate: 1,
        seeking: false,
        sourceKind: 'media-element',
        sourceInstanceId: route ? `youtube:${route.externalId}:missing-video` : 'youtube:missing-video',
        mediaIdentity: route
          ? { platform: 'youtube', externalId: route.externalId, contextId: route.type }
          : null,
        confidence: 0.2,
        eventKind: 'source-lost',
      });
    }

    const durationMs = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration * 1000
      : null;
    const mediaSourceInstanceId = route
      ? `youtube:${route.externalId}:media`
      : `youtube:media:${video.currentSrc || video.src || 'anonymous'}`;
    const hasMetadata = (video.readyState ?? 0) >= 1;
    const rawPosition = hasMetadata && Number.isFinite(video.currentTime)
      ? Math.max(0, video.currentTime * 1000)
      : null;

    if (advertising) {
      return this.#emit({
        capturedAtMs,
        positionMs: this.#lastContentPositionMs || null,
        durationMs,
        playbackState: 'buffering',
        rate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
        seeking: Boolean(video.seeking),
        sourceKind: 'page-state',
        // Advertisement is a state of the selected media source, not a
        // competing lower-priority authority. Keeping the identity stable lets
        // SourceArbiter freeze the timeline on the first ad observation.
        sourceInstanceId: mediaSourceInstanceId,
        mediaIdentity: route
          ? { platform: 'youtube', externalId: route.externalId, contextId: route.type }
          : null,
        confidence: 0.9,
        eventKind: 'buffer-start',
      });
    }

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
      mediaIdentity: route
        ? { platform: 'youtube', externalId: route.externalId, contextId: route.type }
        : null,
      confidence: hasMetadata ? 1 : 0.45,
      eventKind: video.seeking ? 'seek-start' : 'sample',
    });
  }

  #findBestVideo(): import('../types.js').MediaElementPort | null {
    const nodes = [...this.#document.querySelectorAll(VIDEO_SELECTORS)];
    if (nodes.length === 0) return null;
    let best: import('../types.js').MediaElementPort | null = null;
    let bestScore = -1;
    for (const video of nodes) {
      if (!isVideoLike(video)) continue;
      if (!video.isConnected) continue;
      const score = ((video.clientWidth ?? 0) * (video.clientHeight ?? 0))
        + ((video.readyState ?? 0) >= 1 ? 1_000_000 : 0)
        + (!video.paused && !video.ended ? 500_000 : 0);
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
