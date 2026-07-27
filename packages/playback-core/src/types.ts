export type PlaybackState =
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'unavailable';

export type SourceKind =
  | 'platform-api'
  | 'media-element'
  | 'page-state'
  | 'dom-progress';

export type RawPlaybackEventKind =
  | 'sample'
  | 'play'
  | 'pause'
  | 'buffer-start'
  | 'buffer-end'
  | 'seek-start'
  | 'seek-end'
  | 'ended'
  | 'media-candidate'
  | 'source-lost'
  | 'navigation'
  | 'visibility-hidden'
  | 'visibility-visible'
  | 'rate-change'
  | 'metadata';

export interface MediaIdentity {
  readonly platform: string;
  readonly externalId: string;
  readonly contextId?: string;
}

/**
 * One observation produced by a platform adapter. `capturedAtMs` is only
 * comparable with signals carrying the same `producerInstanceId`.
 */
export interface RawPlaybackSignal {
  readonly producerInstanceId: string;
  readonly producerSequence: number;
  readonly sessionCandidateId: string;
  readonly sourceInstanceId: string;
  readonly sourceKind: SourceKind;
  readonly capturedAtMs: number;
  readonly positionMs: number | null;
  readonly durationMs: number | null;
  readonly playbackState: PlaybackState;
  readonly rate: number;
  readonly seeking: boolean;
  readonly mediaIdentity: MediaIdentity | null;
  readonly confidence: number;
  readonly eventKind: RawPlaybackEventKind;
}

export type DiscontinuityKind =
  | 'seek'
  | 'loop'
  | 'session-change'
  | 'resume-reanchor'
  | 'unknown';

export interface PlaybackDiscontinuity {
  readonly sequence: number;
  readonly kind: DiscontinuityKind;
  readonly fromPositionMs: number;
  readonly toPositionMs: number;
  readonly committedAtMs: number;
}

/** A sparse, locally timestamped anchor consumed by projected surface clocks. */
export interface StablePlaybackAnchor {
  readonly sessionId: string;
  readonly sequence: number;
  readonly positionMs: number;
  readonly anchoredAtMs: number;
  readonly durationMs: number | null;
  readonly playbackState: PlaybackState;
  readonly rate: number;
  readonly projectionRate: number;
  readonly seeking: boolean;
  readonly sourceInstanceId: string;
  readonly sourceKind: SourceKind;
  readonly confidence: number;
  readonly discontinuity: PlaybackDiscontinuity | null;
}

export interface StablePlaybackSnapshot {
  readonly sessionId: string;
  readonly anchorSequence: number;
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly playbackState: PlaybackState;
  readonly rate: number;
  readonly seeking: boolean;
  readonly available: boolean;
  readonly discontinuitySequence: number;
}

export interface SeekRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly targetPositionMs: number;
  readonly requestedBySurfaceId: string;
  readonly issuedAtMs: number;
}

export type SeekOutcome =
  | { readonly status: 'accepted'; readonly requestId: string }
  | { readonly status: 'confirmed'; readonly requestId: string; readonly positionMs: number }
  | { readonly status: 'rejected'; readonly requestId: string; readonly reason: string }
  | { readonly status: 'timed-out'; readonly requestId: string }
  | { readonly status: 'superseded'; readonly requestId: string; readonly byRequestId: string };
