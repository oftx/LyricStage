/**
 * Per-media timing offset for the lyric window, following the userscript's
 * OffsetPlaybackBinding: positive offset advances lyrics, click-seek maps the
 * lyric position back to source time, and the offset is persisted per media
 * id so每个视频/歌曲各自记住校准。
 */
import type { PlaybackClock, PlaybackCommands, PlaybackSnapshot, Unsubscribe } from '@lyric-stage/player';

export const TIMING_OFFSET_LIMIT_MS = 60_000;
const OFFSET_PREFIX = 'lyric-library:timing:';

function clampOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-TIMING_OFFSET_LIMIT_MS, Math.min(TIMING_OFFSET_LIMIT_MS, Math.round(value)));
}

export interface TimingOffsetStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export async function loadTimingOffset(
  storage: TimingOffsetStorageArea,
  mediaId: string,
): Promise<number> {
  return (await loadStoredTimingOffset(storage, mediaId)) ?? 0;
}

/**
 * Null-aware read: with a site-global offset in play, "never calibrated"
 * (ride the global) and "explicitly calibrated to 0" (opt out of the global)
 * are different states — the plain 0 fallback cannot represent both.
 */
export async function loadStoredTimingOffset(
  storage: TimingOffsetStorageArea,
  mediaId: string,
): Promise<number | null> {
  const key = OFFSET_PREFIX + mediaId;
  const raw = (await storage.get(key))[key];
  return typeof raw === 'number' ? clampOffset(raw) : null;
}

export async function saveTimingOffset(
  storage: TimingOffsetStorageArea,
  mediaId: string,
  offsetMs: number,
  options?: { readonly keepZero?: boolean },
): Promise<void> {
  const key = OFFSET_PREFIX + mediaId;
  const clamped = clampOffset(offsetMs);
  // keepZero: an explicit 0 while the site global is active is a real
  // override (this track opts out of the global), not "no calibration".
  if (clamped === 0 && options?.keepZero !== true) {
    await storage.remove(key);
    return;
  }
  await storage.set({ [key]: clamped });
}

export async function clearTimingOffset(
  storage: TimingOffsetStorageArea,
  mediaId: string,
): Promise<void> {
  await storage.remove(OFFSET_PREFIX + mediaId);
}

/**
 * Site-wide (per platform) global offset. null = 全局 disabled for the site.
 * Per-media offsets always win over it; it never writes into per-media keys.
 * Storing 0 is meaningful: the ACTIVE state itself persists.
 */
const GLOBAL_OFFSET_PREFIX = 'lyric-library:global-timing:';

export async function loadGlobalTimingOffset(
  storage: TimingOffsetStorageArea,
  platform: string,
): Promise<number | null> {
  const key = GLOBAL_OFFSET_PREFIX + platform;
  const raw = (await storage.get(key))[key];
  return typeof raw === 'number' ? clampOffset(raw) : null;
}

export async function saveGlobalTimingOffset(
  storage: TimingOffsetStorageArea,
  platform: string,
  offsetMs: number | null,
): Promise<void> {
  const key = GLOBAL_OFFSET_PREFIX + platform;
  if (offsetMs === null) {
    await storage.remove(key);
    return;
  }
  await storage.set({ [key]: clampOffset(offsetMs) });
}

/**
 * Wraps the sparse-anchor clock and seek commands with a mutable offset.
 * Positive offsetMs advances lyrics (lyric time = source time + offset);
 * seeks translate lyric targets back to source time.
 */
export class OffsetLyricBinding {
  readonly clock: PlaybackClock;
  #offsetMs = 0;
  #timingRevision = 0;
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly sourceClock: PlaybackClock,
    private readonly sourceSeek: (positionMs: number) => void,
  ) {
    this.clock = Object.freeze({
      getSnapshot: (): PlaybackSnapshot => this.#getSnapshot(),
      subscribe: (listener: () => void): Unsubscribe => this.#subscribe(listener),
    });
  }

  get offsetMs(): number {
    return this.#offsetMs;
  }

  setOffsetMs(offsetMs: number): void {
    const clamped = clampOffset(offsetMs);
    if (clamped === this.#offsetMs) return;
    this.#offsetMs = clamped;
    // Bump revision so the player treats the shift as a discontinuity-free
    // timing change rather than replaying stale frame state.
    this.#timingRevision += 1;
    for (const listener of [...this.#listeners]) listener();
  }

  commands(): PlaybackCommands {
    return Object.freeze({
      seekTo: (positionMs: number): void => {
        const sourceTarget = Math.max(0, positionMs - this.#offsetMs);
        this.sourceSeek(sourceTarget);
      },
      play: (): void => {},
    });
  }

  #getSnapshot(): PlaybackSnapshot {
    const snapshot = this.sourceClock.getSnapshot();
    return {
      ...snapshot,
      positionMs: Math.max(0, snapshot.positionMs + this.#offsetMs),
      revision: Math.min(
        Number.MAX_SAFE_INTEGER,
        snapshot.revision + this.#timingRevision,
      ),
    };
  }

  #subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    const unsubscribeSource = this.sourceClock.subscribe(listener);
    let subscribed = true;
    return (): void => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
      unsubscribeSource();
    };
  }
}
