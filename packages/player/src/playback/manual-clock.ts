import { projectPosition } from "./project-position.js";
import type {
  PlaybackClock,
  PlaybackDiscontinuity,
  PlaybackDiscontinuityReason,
  PlaybackNow,
  PlaybackPositionAnchor,
  PlaybackSnapshot,
  ProjectedPlaybackPosition,
  Unsubscribe,
} from "./types.js";

export interface ManualClockOptions {
  readonly positionMs?: number;
  readonly durationMs?: number | null;
  readonly playing?: boolean;
  readonly rate?: number;
  readonly seeking?: boolean;
  readonly loop?: boolean;
  readonly now?: PlaybackNow;
}

export interface ManualClockSource {
  readonly positionMs?: number;
  readonly durationMs?: number | null;
  readonly playing?: boolean;
  readonly rate?: number;
  readonly seeking?: boolean;
  readonly loop?: boolean;
}

export interface ManualPlaybackClock extends PlaybackClock {
  play(): void;
  pause(): void;
  seekTo(positionMs: number): void;
  loopTo(positionMs: number): void;
  /**
   * Rewinds and starts playback as one same-source loop transaction.
   *
   * Unlike calling `loopTo()` followed by `play()`, this emits one
   * invalidation so consumers never observe an intermediate paused frame at
   * the media boundary.
   */
  restart(positionMs?: number): void;
  replaceSource(source?: ManualClockSource): void;
  setRate(rate: number): void;
  setSeeking(seeking: boolean): void;
}

interface ListenerSubscription {
  active: boolean;
  readonly listener: () => void;
}

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function position(value: number | undefined, fallback = 0): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function rate(value: number | undefined, fallback = 1): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function duration(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function incrementSequence(sequence: number, increment = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, sequence + Math.max(1, increment));
}

class ManualPlaybackClockImpl implements ManualPlaybackClock {
  readonly #now: PlaybackNow;
  readonly #subscriptions = new Set<ListenerSubscription>();
  #lastNowMs = 0;
  #anchor: PlaybackPositionAnchor;
  #revision = 0;
  #discontinuitySequence = 0;
  #discontinuity: PlaybackDiscontinuity | null = null;

  constructor(options: ManualClockOptions) {
    this.#now = options.now ?? defaultNow;
    const observedAtMs = this.#readNow();
    this.#anchor = {
      positionMs: position(options.positionMs),
      observedAtMs,
      playing: options.playing ?? false,
      seeking: options.seeking ?? false,
      rate: rate(options.rate),
      durationMs: duration(options.durationMs),
      loop: options.loop ?? false,
    };
  }

  getSnapshot(): PlaybackSnapshot {
    const nowMs = this.#readNow();
    const projected = this.#projectAndCommitBoundary(nowMs);
    return this.#createSnapshot(projected);
  }

  subscribe(listener: () => void): Unsubscribe {
    const subscription: ListenerSubscription = { active: true, listener };
    this.#subscriptions.add(subscription);
    return (): void => {
      if (!subscription.active) return;
      subscription.active = false;
      this.#subscriptions.delete(subscription);
    };
  }

  play(): void {
    this.#update((anchor) => ({ ...anchor, playing: true }));
  }

  pause(): void {
    this.#update((anchor) => ({ ...anchor, playing: false }));
  }

  seekTo(positionMs: number): void {
    this.#update(
      (anchor) => ({ ...anchor, positionMs: position(positionMs) }),
      "seek",
      true,
    );
  }

  loopTo(positionMs: number): void {
    this.#update(
      (anchor) => ({ ...anchor, positionMs: position(positionMs) }),
      "loop",
      true,
    );
  }

  restart(positionMs = 0): void {
    this.#update(
      (anchor) => ({
        ...anchor,
        positionMs: position(positionMs),
        playing: true,
        seeking: false,
      }),
      "loop",
      true,
    );
  }

  replaceSource(source: ManualClockSource = {}): void {
    this.#update(
      (anchor) => ({
        positionMs: position(source.positionMs),
        observedAtMs: anchor.observedAtMs,
        playing: source.playing ?? anchor.playing,
        seeking: source.seeking ?? false,
        rate: rate(source.rate, anchor.rate),
        durationMs:
          source.durationMs === undefined
            ? null
            : duration(source.durationMs),
        loop: source.loop ?? false,
      }),
      "source-change",
      true,
    );
  }

  setRate(playbackRate: number): void {
    this.#update((anchor) => ({
      ...anchor,
      rate: rate(playbackRate, anchor.rate),
    }));
  }

  setSeeking(seeking: boolean): void {
    this.#update((anchor) => ({ ...anchor, seeking }));
  }

  #readNow(): number {
    const candidate = this.#now();
    if (Number.isFinite(candidate) && candidate >= this.#lastNowMs) {
      this.#lastNowMs = Math.max(0, candidate);
    }
    return this.#lastNowMs;
  }

  #projectAndCommitBoundary(nowMs: number): ProjectedPlaybackPosition {
    const projected = projectPosition(this.#anchor, nowMs);
    if (projected.loopCount > 0) {
      this.#anchor = {
        ...this.#anchor,
        positionMs: projected.positionMs,
        observedAtMs: nowMs,
      };
      this.#recordDiscontinuity("loop", projected.loopCount);
      this.#revision += 1;
      return projectPosition(this.#anchor, nowMs);
    }
    return projected;
  }

  #commit(nowMs: number): void {
    const projected = this.#projectAndCommitBoundary(nowMs);
    this.#anchor = {
      ...this.#anchor,
      positionMs: projected.positionMs,
      observedAtMs: nowMs,
    };
  }

  #update(
    update: (anchor: PlaybackPositionAnchor) => PlaybackPositionAnchor,
    reason?: PlaybackDiscontinuityReason,
    force = false,
  ): void {
    const nowMs = this.#readNow();
    const revisionBeforeCommit = this.#revision;
    this.#commit(nowMs);
    const previous = this.#anchor;
    const next = { ...update(previous), observedAtMs: nowMs };
    const anchorChanged = force || !sameAnchor(previous, next);
    const boundaryChanged = this.#revision !== revisionBeforeCommit;
    if (!anchorChanged && !boundaryChanged) return;

    if (anchorChanged) {
      this.#anchor = next;
      if (reason) this.#recordDiscontinuity(reason);
      this.#revision += 1;
    }
    this.#notify();
  }

  #recordDiscontinuity(
    reason: PlaybackDiscontinuityReason,
    increment = 1,
  ): void {
    this.#discontinuitySequence = incrementSequence(
      this.#discontinuitySequence,
      increment,
    );
    this.#discontinuity = {
      sequence: this.#discontinuitySequence,
      reason,
    };
  }

  #createSnapshot(projected: ProjectedPlaybackPosition): PlaybackSnapshot {
    return {
      positionMs: projected.positionMs,
      playing: this.#anchor.playing && !projected.ended,
      rate: this.#anchor.rate,
      seeking: this.#anchor.seeking,
      revision: this.#revision,
      discontinuity: this.#discontinuity,
    };
  }

  #notify(): void {
    for (const subscription of [...this.#subscriptions]) {
      if (subscription.active) subscription.listener();
    }
  }
}

function sameAnchor(
  left: PlaybackPositionAnchor,
  right: PlaybackPositionAnchor,
): boolean {
  return (
    left.positionMs === right.positionMs &&
    left.playing === right.playing &&
    left.seeking === right.seeking &&
    left.rate === right.rate &&
    left.durationMs === right.durationMs &&
    left.loop === right.loop
  );
}

export function createManualClock(
  options: ManualClockOptions = {},
): ManualPlaybackClock {
  return new ManualPlaybackClockImpl(options);
}
