export type PlaybackDiscontinuityReason =
  | "seek"
  | "loop"
  | "source-change"
  | "unknown";

export interface PlaybackDiscontinuity {
  readonly sequence: number;
  readonly reason: PlaybackDiscontinuityReason;
}

export interface PlaybackSnapshot {
  readonly positionMs: number;
  readonly playing: boolean;
  readonly rate: number;
  readonly seeking: boolean;
  readonly revision: number;
  readonly discontinuity: PlaybackDiscontinuity | null;
}

export type PlaybackNow = () => number;

export interface PlaybackPositionAnchor {
  readonly positionMs: number;
  readonly observedAtMs: number;
  readonly playing: boolean;
  readonly seeking: boolean;
  readonly rate: number;
  readonly durationMs: number | null;
  readonly loop: boolean;
}

export interface ProjectedPlaybackPosition {
  readonly positionMs: number;
  readonly ended: boolean;
  /** Number of complete loop boundaries crossed since the anchor. */
  readonly loopCount: number;
}

export type Unsubscribe = () => void;

export interface PlaybackClock {
  /** Returns the current projected playback position at call time. */
  getSnapshot(): PlaybackSnapshot;
  /** Signals state invalidation; animation-frame ticks remain renderer-owned. */
  subscribe(onInvalidate: () => void): Unsubscribe;
}
