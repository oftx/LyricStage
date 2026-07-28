/**
 * Lyric refresh state machine, extracted from the content runtime.
 *
 * Guards (P0-6):
 * - success dedup: after a lyric binds for a media id, non-forced refreshes
 *   are free;
 * - single-flight: one request per media id at a time — every publishSnapshot
 *   used to void-launch a concurrent fetch during the warm-up window;
 * - failure backoff: a failed/empty fetch for a media id blocks re-fetch for
 *   an exponentially growing window (2s → 60s cap) instead of retrying at the
 *   400ms snapshot cadence for the whole track;
 * - latest-wins generation guard for slow stale responses.
 * Media change (resetBinding) clears the backoff so a new track fetches
 * immediately.
 */
import type { LyricTrackMeta, PortableLyricText } from '@lyric-stage/platform-adapters';

const FAILURE_BACKOFF_BASE_MS = 2_000;
const FAILURE_BACKOFF_MAX_MS = 60_000;

export interface LyricRefreshEnvironment {
  /** Current platform of this tab. */
  readonly platform: () => string;
  /** Current bound media id. */
  readonly mediaId: () => string;
  /** Whether the worker port is currently open. */
  readonly portOpen: () => boolean;
  /** Monotonic clock; injected for deterministic tests. */
  readonly now?: () => number;
  readonly parseMediaId: (mediaId: string) => {
    readonly platform: string;
    readonly externalId: string;
  } | null;
  readonly loadAppleMusicLyricText: (requestId: string) => Promise<
    | {
      readonly ok: true;
      readonly lyric: PortableLyricText;
      readonly resolvedExternalId?: string | null;
    }
    | { readonly ok: false; readonly reason?: string }
  >;
  readonly loadPlatformLyricText: (input: {
    readonly platform: 'netease' | 'qqmusic';
    readonly externalId: string;
  }) => Promise<
    | {
      readonly ok: true;
      readonly lyric: PortableLyricText;
      readonly track?: LyricTrackMeta;
    }
    | { readonly ok: false; readonly reason?: string }
  >;
  /**
   * Fires exactly once per successful platform fetch+publish — the library
   * auto-save hook. Never on failures, backoff skips, or stale generations.
   */
  readonly onLyricResolved?: (input: {
    readonly platform: string;
    readonly externalId: string;
    readonly lyric: PortableLyricText;
    readonly track?: LyricTrackMeta;
  }) => void;
  /**
   * Library lookup for platforms without a lyric source (video sites):
   * explicit per-media preference first, then title matching. Returns the
   * lyric to publish, or null when nothing applies (ignored / no match).
   */
  readonly lookupLibraryLyric?: (mediaId: string) => Promise<
    | { readonly lyric: PortableLyricText; readonly libraryId: string }
    | null
  >;
  /** Apple Music may resolve a live catalog id mid-request. */
  readonly applyMediaIdentity: (mediaId: string) => void;
  /** Publish a bound lyric document at the given revision. */
  readonly publishLyric: (
    mediaId: string,
    revision: number,
    lyric: PortableLyricText,
  ) => void;
  /**
   * A fetch/lookup definitively resolved to "no lyrics" for this media
   * (instrumental track, failed fetch, no library match). Surfaces showing a
   * previous track's document need this to clear — without it there is no
   * message in the protocol that can ever un-render stale lyrics.
   */
  readonly publishLyricClear?: (mediaId: string) => void;
  /** Publish a playback snapshot (or held position) after a lyric binds. */
  readonly publishSnapshotOrHold: () => void;
}

interface FailureRecord {
  failures: number;
  blockedUntilMs: number;
}

export class LyricRefreshController {
  #revision = 0;
  #lastPublishedMediaId: string | null = null;
  #loadGeneration = 0;
  /** Media id with a request currently in flight, or null. */
  #inFlightMediaId: string | null = null;
  #failureByMediaId = new Map<string, FailureRecord>();

  constructor(private readonly env: LyricRefreshEnvironment) {}

  get revision(): number {
    return this.#revision;
  }

  get lastPublishedMediaId(): string | null {
    return this.#lastPublishedMediaId;
  }

  /** Media changed or a forced republish is wanted — drop the success dedup. */
  resetBinding(): void {
    this.#lastPublishedMediaId = null;
    // A new track (or explicit republish) starts with a clean failure slate.
    this.#failureByMediaId.clear();
  }

  /** Full reset on teardown. */
  reset(): void {
    this.#revision = 0;
    this.#lastPublishedMediaId = null;
    this.#loadGeneration += 1;
    this.#inFlightMediaId = null;
    this.#failureByMediaId.clear();
  }

  #now(): number {
    return this.env.now?.() ?? Date.now();
  }

  #failureBlocked(mediaId: string): boolean {
    const record = this.#failureByMediaId.get(mediaId);
    return record !== undefined && this.#now() < record.blockedUntilMs;
  }

  #recordFailure(mediaId: string): void {
    const record = this.#failureByMediaId.get(mediaId)
      ?? { failures: 0, blockedUntilMs: 0 };
    record.failures += 1;
    const delayMs = Math.min(
      FAILURE_BACKOFF_MAX_MS,
      FAILURE_BACKOFF_BASE_MS * (2 ** (record.failures - 1)),
    );
    record.blockedUntilMs = this.#now() + delayMs;
    this.#failureByMediaId.set(mediaId, record);
  }

  #recordSuccess(mediaId: string): void {
    this.#failureByMediaId.delete(mediaId);
  }

  async refresh(force = false): Promise<void> {
    const env = this.env;
    if (!env.portOpen()) return;
    const forMedia = env.mediaId();
    if (
      !force
      && this.#lastPublishedMediaId === forMedia
      && this.#revision > 0
    ) return;
    // Single-flight per media id: snapshots arrive at 400ms; concurrent
    // fetches for the same media only waste network and thrash generations.
    // A forced refresh for a DIFFERENT media id still proceeds (latest-wins
    // generation guard invalidates the older request).
    if (this.#inFlightMediaId === forMedia) return;
    // Failure backoff: forced refreshes (media change, explicit republish,
    // Apple warm-up) bypass so user intent is never delayed.
    if (!force && this.#failureBlocked(forMedia)) return;

    const loadId = ++this.#loadGeneration;
    const parsed = env.parseMediaId(forMedia);

    // Apple Music: even while mediaId is still applemusic:listening, ask MAIN
    // to resolve the live nowPlaying item.
    if (env.platform() === 'applemusic') {
      const requestId = parsed
        && parsed.platform === 'applemusic'
        && parsed.externalId
        && parsed.externalId !== 'listening'
        && parsed.externalId !== 'unknown'
        && !parsed.externalId.includes('unbound')
        ? parsed.externalId
        : 'current';
      this.#inFlightMediaId = forMedia;
      let result: Awaited<ReturnType<LyricRefreshEnvironment['loadAppleMusicLyricText']>>;
      try {
        result = await env.loadAppleMusicLyricText(requestId);
      } finally {
        if (this.#inFlightMediaId === forMedia) this.#inFlightMediaId = null;
      }
      if (loadId !== this.#loadGeneration || !env.portOpen()) return;
      // Identity may change while the request is in flight — only drop if we
      // left Apple Music entirely (should not happen in this tab).
      if (env.platform() !== 'applemusic') return;
      if (result.ok && result.lyric.text.trim()) {
        if (result.resolvedExternalId) {
          env.applyMediaIdentity(`applemusic:${result.resolvedExternalId}`);
        }
        const bindMedia = env.mediaId().startsWith('applemusic:')
          ? env.mediaId()
          : (result.resolvedExternalId
            ? `applemusic:${result.resolvedExternalId}`
            : forMedia);
        this.#revision += 1;
        this.#lastPublishedMediaId = bindMedia;
        this.#recordSuccess(forMedia);
        env.publishLyric(bindMedia, this.#revision, result.lyric);
        env.publishSnapshotOrHold();
        const appleExternalId = bindMedia.startsWith('applemusic:')
          ? bindMedia.slice('applemusic:'.length)
          : requestId;
        env.onLyricResolved?.({
          platform: 'applemusic',
          externalId: appleExternalId,
          lyric: result.lyric,
        });
      } else {
        this.#recordFailure(forMedia);
        env.publishLyricClear?.(forMedia);
      }
      return;
    }

    const canFetch = parsed
      && (parsed.platform === 'netease' || parsed.platform === 'qqmusic')
      && parsed.externalId.length > 0
      && !parsed.externalId.includes('unbound')
      && parsed.externalId !== 'demo';

    if (!canFetch || !parsed) {
      // Video platforms (youtube/bilibili) have no lyric source; consult the
      // local library — explicit preference only.
      const lookup = env.lookupLibraryLyric;
      if (!lookup || !parsed) return;
      this.#inFlightMediaId = forMedia;
      let match: Awaited<ReturnType<NonNullable<LyricRefreshEnvironment['lookupLibraryLyric']>>>;
      try {
        match = await lookup(forMedia);
      } catch {
        match = null;
      } finally {
        if (this.#inFlightMediaId === forMedia) this.#inFlightMediaId = null;
      }
      if (
        loadId !== this.#loadGeneration
        || forMedia !== env.mediaId()
        || !env.portOpen()
      ) return;
      if (match && match.lyric.text.trim()) {
        this.#revision += 1;
        this.#lastPublishedMediaId = forMedia;
        this.#recordSuccess(forMedia);
        env.publishLyric(forMedia, this.#revision, match.lyric);
        env.publishSnapshotOrHold();
      } else {
        this.#recordFailure(forMedia);
        env.publishLyricClear?.(forMedia);
      }
      return;
    }

    this.#inFlightMediaId = forMedia;
    let result: Awaited<ReturnType<LyricRefreshEnvironment['loadPlatformLyricText']>>;
    try {
      result = await env.loadPlatformLyricText({
        platform: parsed.platform as 'netease' | 'qqmusic',
        externalId: parsed.externalId,
      });
    } finally {
      if (this.#inFlightMediaId === forMedia) this.#inFlightMediaId = null;
    }
    if (
      loadId !== this.#loadGeneration
      || forMedia !== env.mediaId()
      || !env.portOpen()
    ) return;
    if (result.ok && result.lyric.text.trim()) {
      this.#revision += 1;
      this.#lastPublishedMediaId = env.mediaId();
      this.#recordSuccess(forMedia);
      env.publishLyric(env.mediaId(), this.#revision, result.lyric);
      // Never stamp position=0 after lyrics bind — that freezes the lyric
      // window at 0 even when the timeline later has real progress.
      env.publishSnapshotOrHold();
      env.onLyricResolved?.({
        platform: parsed.platform,
        externalId: parsed.externalId,
        lyric: result.lyric,
        ...(result.track ? { track: result.track } : {}),
      });
    } else {
      // Failed or empty (e.g. instrumental track): back off instead of
      // re-fetching on every snapshot for the whole duration of playback.
      this.#recordFailure(forMedia);
      env.publishLyricClear?.(forMedia);
    }
  }
}
