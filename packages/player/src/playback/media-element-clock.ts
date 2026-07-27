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

export interface MediaElementClockOptions {
  readonly now?: PlaybackNow;
}

interface ListenerSubscription {
  active: boolean;
  readonly listener: () => void;
}

const observedEvents = [
  "durationchange",
  "emptied",
  "ended",
  "loadedmetadata",
  "loadstart",
  "pause",
  "play",
  "playing",
  "ratechange",
  "seeked",
  "seeking",
  "timeupdate",
  "waiting",
] as const;

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function mediaPositionMs(media: HTMLMediaElement): number {
  const value = media.currentTime * 1_000;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function mediaDurationMs(media: HTMLMediaElement): number | null {
  const value = media.duration * 1_000;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function mediaRate(media: HTMLMediaElement): number {
  return Number.isFinite(media.playbackRate) && media.playbackRate >= 0
    ? media.playbackRate
    : 0;
}

function mediaSourceKey(media: HTMLMediaElement): string {
  return media.currentSrc || media.src || "";
}

function incrementSequence(sequence: number, increment = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, sequence + Math.max(1, increment));
}

class MediaElementPlaybackClock implements PlaybackClock {
  readonly #media: HTMLMediaElement;
  readonly #now: PlaybackNow;
  readonly #subscriptions = new Set<ListenerSubscription>();
  readonly #handleEvent = (event: Event): void => this.#onMediaEvent(event.type);
  #listenersAttached = false;
  #lastNowMs = 0;
  #anchor: PlaybackPositionAnchor;
  #sourceKey: string;
  #lastObservedMediaPositionMs: number;
  #seekCycleActive: boolean;
  #loadCycleActive = false;
  #suppressNextEmptied = false;
  #sourceEstablished: boolean;
  #waitingForPlayback = false;
  #revision = 0;
  #discontinuitySequence = 0;
  #discontinuity: PlaybackDiscontinuity | null = null;

  constructor(media: HTMLMediaElement, options: MediaElementClockOptions) {
    this.#media = media;
    this.#now = options.now ?? defaultNow;
    this.#waitingForPlayback =
      !media.paused && !media.ended && media.readyState < 3;
    const observedAtMs = this.#readNow();
    const positionMs = mediaPositionMs(media);
    this.#anchor = this.#readAnchor(positionMs, observedAtMs);
    this.#sourceKey = mediaSourceKey(media);
    this.#lastObservedMediaPositionMs = positionMs;
    this.#seekCycleActive = media.seeking;
    this.#sourceEstablished = media.readyState >= 1;
  }

  getSnapshot(): PlaybackSnapshot {
    const nowMs = this.#readNow();
    this.#reconcileUnsignalledState(nowMs);
    const projected = this.#projectAndCommitBoundary(nowMs);
    return {
      positionMs: projected.positionMs,
      playing: this.#anchor.playing && !projected.ended,
      rate: this.#anchor.rate,
      seeking: this.#anchor.seeking,
      revision: this.#revision,
      discontinuity: this.#discontinuity,
    };
  }

  subscribe(listener: () => void): Unsubscribe {
    if (this.#subscriptions.size === 0) this.#attachListeners();
    const subscription: ListenerSubscription = { active: true, listener };
    this.#subscriptions.add(subscription);

    return (): void => {
      if (!subscription.active) return;
      subscription.active = false;
      this.#subscriptions.delete(subscription);
      if (this.#subscriptions.size === 0) this.#detachListeners();
    };
  }

  #attachListeners(): void {
    if (this.#listenersAttached) return;
    const attachedEvents: string[] = [];
    try {
      for (const eventName of observedEvents) {
        this.#media.addEventListener(eventName, this.#handleEvent);
        attachedEvents.push(eventName);
      }
      this.#listenersAttached = true;
      this.#reconcileUnsignalledState(this.#readNow());
    } catch (error) {
      for (const eventName of attachedEvents) {
        this.#media.removeEventListener(eventName, this.#handleEvent);
      }
      this.#listenersAttached = false;
      throw error;
    }
  }

  #detachListeners(): void {
    if (!this.#listenersAttached) return;
    for (const eventName of observedEvents) {
      this.#media.removeEventListener(eventName, this.#handleEvent);
    }
    this.#listenersAttached = false;
  }

  #readNow(): number {
    const candidate = this.#now();
    if (Number.isFinite(candidate) && candidate >= this.#lastNowMs) {
      this.#lastNowMs = Math.max(0, candidate);
    }
    return this.#lastNowMs;
  }

  #readAnchor(
    positionMs: number,
    observedAtMs: number,
  ): PlaybackPositionAnchor {
    return {
      positionMs,
      observedAtMs,
      playing:
        !this.#media.paused &&
        !this.#media.ended &&
        !this.#waitingForPlayback,
      seeking: this.#media.seeking,
      rate: mediaRate(this.#media),
      durationMs: mediaDurationMs(this.#media),
      loop: this.#media.loop,
    };
  }

  #onMediaEvent(eventName: string): void {
    const nowMs = this.#readNow();
    const projectedBeforeEvent = projectPosition(this.#anchor, nowMs);
    const nextSourceKey = mediaSourceKey(this.#media);
    const nextPositionMs = mediaPositionMs(this.#media);
    let reason: PlaybackDiscontinuityReason | undefined;
    let sequenceIncrement = 1;

    if (eventName === "play" || eventName === "waiting") {
      this.#waitingForPlayback = true;
    } else if (eventName === "playing") {
      this.#waitingForPlayback = false;
    } else if (
      eventName === "pause" ||
      eventName === "ended" ||
      eventName === "emptied" ||
      eventName === "loadstart"
    ) {
      this.#waitingForPlayback = false;
    }

    const sourceKeyChanged = nextSourceKey !== this.#sourceKey;
    if (eventName === "emptied") {
      if (this.#suppressNextEmptied) {
        this.#suppressNextEmptied = false;
      } else if (this.#sourceEstablished) {
        reason = "source-change";
      }
    } else if (
      this.#sourceEstablished &&
      !this.#loadCycleActive &&
      (sourceKeyChanged || eventName === "loadstart")
    ) {
      reason = "source-change";
    }
    if (eventName === "emptied" || eventName === "loadstart") {
      this.#loadCycleActive = true;
      if (eventName === "loadstart") this.#suppressNextEmptied = false;
    } else if (eventName === "loadedmetadata") {
      this.#loadCycleActive = false;
      this.#suppressNextEmptied = false;
    }
    if (
      eventName === "loadedmetadata" ||
      eventName === "play" ||
      eventName === "playing" ||
      eventName === "timeupdate"
    ) {
      this.#sourceEstablished = true;
    }

    if (!reason && eventName === "seeking" && !this.#seekCycleActive) {
      reason = "seek";
    }

    if (!reason && projectedBeforeEvent.loopCount > 0) {
      reason = "loop";
      sequenceIncrement = projectedBeforeEvent.loopCount;
    }

    if (
      !reason &&
      eventName === "timeupdate" &&
      nextPositionMs + 1 < this.#lastObservedMediaPositionMs
    ) {
      reason = this.#media.loop ? "loop" : "seek";
    }

    const nextAnchor = this.#readAnchor(nextPositionMs, nowMs);
    const changed =
      !sameAnchor(this.#anchor, nextAnchor) ||
      sourceKeyChanged ||
      reason !== undefined;

    this.#anchor = nextAnchor;
    this.#sourceKey = nextSourceKey;
    this.#lastObservedMediaPositionMs = nextPositionMs;
    this.#seekCycleActive = this.#media.seeking;

    if (!changed) return;
    if (reason) this.#recordDiscontinuity(reason, sequenceIncrement);
    this.#revision += 1;
    this.#notify();
  }

  #reconcileUnsignalledState(nowMs: number): void {
    const nextSourceKey = mediaSourceKey(this.#media);
    const actualPositionMs = mediaPositionMs(this.#media);
    const nextAnchor = this.#readAnchor(actualPositionMs, nowMs);
    const sourceChanged = nextSourceKey !== this.#sourceKey;
    const seekingStarted = nextAnchor.seeking && !this.#seekCycleActive;
    const stateChanged = !sameState(this.#anchor, nextAnchor);
    const backwardJump =
      actualPositionMs + 1 < this.#lastObservedMediaPositionMs;
    const pausedPositionChange =
      !this.#anchor.playing &&
      Math.abs(actualPositionMs - this.#lastObservedMediaPositionMs) > 1;

    if (
      !sourceChanged &&
      !seekingStarted &&
      !stateChanged &&
      !backwardJump &&
      !pausedPositionChange
    ) {
      return;
    }

    const projected = projectPosition(this.#anchor, nowMs);
    let reason: PlaybackDiscontinuityReason | undefined;
    let sequenceIncrement = 1;
    if (sourceChanged && this.#sourceEstablished) {
      reason = "source-change";
      this.#loadCycleActive = true;
      this.#suppressNextEmptied = true;
    } else if (seekingStarted) {
      reason = "seek";
    } else if (projected.loopCount > 0 || (backwardJump && nextAnchor.loop)) {
      reason = "loop";
      sequenceIncrement = Math.max(1, projected.loopCount);
    } else if (backwardJump) {
      reason = "seek";
    } else if (pausedPositionChange) {
      reason = "seek";
    }

    this.#anchor = nextAnchor;
    this.#sourceKey = nextSourceKey;
    this.#lastObservedMediaPositionMs = actualPositionMs;
    this.#seekCycleActive = nextAnchor.seeking;
    if (this.#media.readyState >= 1) this.#sourceEstablished = true;
    if (reason) this.#recordDiscontinuity(reason, sequenceIncrement);
    this.#revision += 1;
  }

  #projectAndCommitBoundary(nowMs: number): ProjectedPlaybackPosition {
    const projected = projectPosition(this.#anchor, nowMs);
    if (projected.loopCount === 0) return projected;

    this.#anchor = {
      ...this.#anchor,
      positionMs: projected.positionMs,
      observedAtMs: nowMs,
    };
    this.#lastObservedMediaPositionMs = projected.positionMs;
    this.#recordDiscontinuity("loop", projected.loopCount);
    this.#revision += 1;
    return projectPosition(this.#anchor, nowMs);
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
    left.positionMs === right.positionMs && sameState(left, right)
  );
}

function sameState(
  left: PlaybackPositionAnchor,
  right: PlaybackPositionAnchor,
): boolean {
  return (
    left.playing === right.playing &&
    left.seeking === right.seeking &&
    left.rate === right.rate &&
    left.durationMs === right.durationMs &&
    left.loop === right.loop
  );
}

export function createMediaElementClock(
  media: HTMLMediaElement,
  options: MediaElementClockOptions = {},
): PlaybackClock {
  return new MediaElementPlaybackClock(media, options);
}
