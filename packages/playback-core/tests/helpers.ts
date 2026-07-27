import type {
  RawPlaybackSignal,
  RawPlaybackEventKind,
  PlaybackState,
  SourceKind,
} from '../src/index.js';

export interface SignalOverrides {
  readonly producerInstanceId?: string;
  readonly producerSequence?: number;
  readonly sessionCandidateId?: string;
  readonly sourceInstanceId?: string;
  readonly sourceKind?: SourceKind;
  readonly capturedAtMs?: number;
  readonly positionMs?: number | null;
  readonly durationMs?: number | null;
  readonly playbackState?: PlaybackState;
  readonly rate?: number;
  readonly seeking?: boolean;
  readonly confidence?: number;
  readonly eventKind?: RawPlaybackEventKind;
}

export function signal(overrides: SignalOverrides = {}): RawPlaybackSignal {
  return {
    producerInstanceId: overrides.producerInstanceId ?? 'producer-1',
    producerSequence: overrides.producerSequence ?? 1,
    sessionCandidateId: overrides.sessionCandidateId ?? 'candidate-1',
    sourceInstanceId: overrides.sourceInstanceId ?? 'media-1',
    sourceKind: overrides.sourceKind ?? 'media-element',
    capturedAtMs: overrides.capturedAtMs ?? 0,
    positionMs: overrides.positionMs === undefined ? 0 : overrides.positionMs,
    durationMs: overrides.durationMs === undefined ? 180_000 : overrides.durationMs,
    playbackState: overrides.playbackState ?? 'playing',
    rate: overrides.rate ?? 1,
    seeking: overrides.seeking ?? false,
    mediaIdentity: {
      platform: 'fixture',
      externalId: 'song-1',
    },
    confidence: overrides.confidence ?? 0.9,
    eventKind: overrides.eventKind ?? 'sample',
  };
}
