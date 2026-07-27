import type {
  PlaybackFixture,
  PlaybackFixtureEntry,
} from './fixture-replay.js';
import type {
  PlaybackState,
  RawPlaybackEventKind,
  RawPlaybackSignal,
  SourceKind,
} from './types.js';
import { parseRawPlaybackSignal, type ValidationIssue, type ValidationResult } from './validation.js';

export interface RecordedFixtureImport {
  readonly platformId: string;
  readonly producerInstanceId: string;
  readonly droppedEntries: number;
  readonly sourceInstanceCount: number;
  readonly mediaInstanceCount: number;
  readonly fixture: PlaybackFixture;
}

interface RecordedFixtureEnvelope {
  readonly schema: 'lyric-stage-raw-playback-signals';
  readonly schemaVersion: 1;
  readonly platformId: string;
  readonly producerInstanceId: string;
  readonly droppedEntries: number;
  readonly signals: readonly RecordedFixtureSignal[];
}

interface RecordedFixtureSignal {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly positionMs: number | null;
  readonly durationMs: number | null;
  readonly playbackState: PlaybackState;
  readonly rate: number;
  readonly seeking: boolean;
  readonly sourceKind: SourceKind | 'unknown';
  readonly confidence: number;
  readonly eventKind: RawPlaybackEventKind | 'other';
  readonly sourceInstanceId: string | null;
  readonly mediaInstanceId: string | null;
}

const RECORDED_SOURCE_KINDS: ReadonlySet<string> = new Set([
  'platform-api',
  'media-element',
  'page-state',
  'dom-progress',
  'unknown',
]);

const RECORDED_PLAYBACK_STATES: ReadonlySet<string> = new Set([
  'playing',
  'paused',
  'buffering',
  'ended',
  'unavailable',
]);

const RECORDED_EVENT_KINDS: ReadonlySet<string> = new Set([
  'sample',
  'play',
  'pause',
  'buffer-start',
  'buffer-end',
  'seek-start',
  'seek-end',
  'ended',
  'media-candidate',
  'source-lost',
  'navigation',
  'visibility-hidden',
  'visibility-visible',
  'rate-change',
  'metadata',
  'other',
]);

/**
 * Strictly imports the existing bounded recorder schema into core replay data.
 * This compatibility adapter is intentionally kept out of platform/runtime
 * code. Recorder v1 lacks true session IDs, so stable candidate IDs are derived
 * from its already-tokenized media identity changes within one capture.
 */
export function parseRecordedPlaybackFixture(
  input: unknown,
): ValidationResult<RecordedFixtureImport> {
  const envelopeResult = parseEnvelope(input);
  if (!envelopeResult.success) return envelopeResult;
  const envelope = envelopeResult.value;
  const issues: ValidationIssue[] = [];
  const entries: PlaybackFixtureEntry[] = [];
  const sourceInstanceIds = new Set<string>();
  const mediaInstanceIds = new Set<string>();
  let lastElapsedMs = Number.NEGATIVE_INFINITY;
  let lastSequence = 0;
  let anonymousMediaGeneration = 0;
  let previousMediaInstanceId: string | null = null;

  envelope.signals.forEach((recorded, index) => {
    const path = `$.signals[${index}]`;
    if (recorded.sequence <= lastSequence) {
      issues.push({ path: `${path}.sequence`, message: 'must be strictly increasing' });
    }
    if (recorded.elapsedMs < lastElapsedMs) {
      issues.push({ path: `${path}.elapsedMs`, message: 'must not move backwards' });
    }
    lastSequence = recorded.sequence;
    lastElapsedMs = recorded.elapsedMs;

    if (
      recorded.mediaInstanceId === null
      && previousMediaInstanceId !== null
      && (recorded.eventKind === 'navigation' || recorded.eventKind === 'media-candidate')
    ) {
      anonymousMediaGeneration += 1;
    }
    if (recorded.mediaInstanceId !== null) {
      previousMediaInstanceId = recorded.mediaInstanceId;
      mediaInstanceIds.add(recorded.mediaInstanceId);
    }

    const sourceKind = recorded.sourceKind === 'unknown'
      ? fallbackSourceKind(recorded)
      : recorded.sourceKind;
    const sourceInstanceId = recorded.sourceInstanceId
      ?? `recorder-source:${sourceKind}`;
    sourceInstanceIds.add(sourceInstanceId);
    const mediaToken = recorded.mediaInstanceId
      ?? previousMediaInstanceId
      ?? `anonymous-${anonymousMediaGeneration}`;
    const sessionCandidateId = `recorded:${envelope.platformId}:${mediaToken}`;
    const coreSignal: RawPlaybackSignal = {
      producerInstanceId: envelope.producerInstanceId,
      producerSequence: recorded.sequence,
      sessionCandidateId,
      sourceInstanceId,
      sourceKind,
      capturedAtMs: recorded.elapsedMs,
      positionMs: recorded.positionMs,
      durationMs: recorded.durationMs,
      playbackState: recorded.playbackState,
      rate: recorded.rate > 0 ? recorded.rate : 1,
      seeking: recorded.seeking,
      mediaIdentity: recorded.mediaInstanceId
        ? { platform: envelope.platformId, externalId: recorded.mediaInstanceId }
        : null,
      confidence: recorded.confidence,
      eventKind: recorded.eventKind === 'other'
        ? fallbackEventKind(recorded)
        : recorded.eventKind,
    };
    const signalResult = parseRawPlaybackSignal(coreSignal);
    if (!signalResult.success) {
      issues.push(...signalResult.issues.map((issue) => ({
        path: `${path}${issue.path.slice(1)}`,
        message: issue.message,
      })));
      return;
    }
    entries.push(Object.freeze({
      receivedAtMs: recorded.elapsedMs,
      signal: Object.freeze(signalResult.value),
    }));
  });

  if (issues.length > 0) return { success: false, issues };
  return {
    success: true,
    value: Object.freeze({
      platformId: envelope.platformId,
      producerInstanceId: envelope.producerInstanceId,
      droppedEntries: envelope.droppedEntries,
      sourceInstanceCount: sourceInstanceIds.size,
      mediaInstanceCount: mediaInstanceIds.size,
      fixture: Object.freeze({
        sessionId: `recorded-session:${envelope.producerInstanceId}`,
        entries: Object.freeze(entries),
      }),
    }),
  };
}

function parseEnvelope(input: unknown): ValidationResult<RecordedFixtureEnvelope> {
  if (!isRecord(input)) return invalid('$', 'must be an object');
  const issues: ValidationIssue[] = [];
  if (input.schema !== 'lyric-stage-raw-playback-signals') {
    issues.push({ path: '$.schema', message: 'is not a supported recorder fixture' });
  }
  if (input.schemaVersion !== 1) {
    issues.push({ path: '$.schemaVersion', message: 'must equal 1' });
  }
  const platformId = readId(input.platformId, '$.platformId', issues);
  const producerInstanceId = readId(
    input.producerInstanceId,
    '$.producerInstanceId',
    issues,
  );
  const droppedEntries = readInteger(input.droppedEntries, '$.droppedEntries', 0, issues);
  if (!Array.isArray(input.signals)) {
    issues.push({ path: '$.signals', message: 'must be an array' });
  }
  const signals = Array.isArray(input.signals)
    ? input.signals.map((entry, index) => parseRecordedSignal(entry, index, issues))
      .filter((entry): entry is RecordedFixtureSignal => entry !== null)
    : [];
  if (issues.length > 0 || !platformId || !producerInstanceId || droppedEntries === null) {
    return { success: false, issues };
  }
  return {
    success: true,
    value: {
      schema: 'lyric-stage-raw-playback-signals',
      schemaVersion: 1,
      platformId,
      producerInstanceId,
      droppedEntries,
      signals,
    },
  };
}

function parseRecordedSignal(
  input: unknown,
  index: number,
  issues: ValidationIssue[],
): RecordedFixtureSignal | null {
  const path = `$.signals[${index}]`;
  if (!isRecord(input)) {
    issues.push({ path, message: 'must be an object' });
    return null;
  }
  const sequence = readInteger(input.sequence, `${path}.sequence`, 1, issues);
  const elapsedMs = readNumber(input.elapsedMs, `${path}.elapsedMs`, 0, issues);
  const positionMs = readNullableNumber(input.positionMs, `${path}.positionMs`, issues);
  const durationMs = readNullableNumber(input.durationMs, `${path}.durationMs`, issues);
  const playbackState = readEnum(
    input.playbackState,
    `${path}.playbackState`,
    RECORDED_PLAYBACK_STATES,
    issues,
  ) as PlaybackState | null;
  const rate = readNumber(input.rate, `${path}.rate`, 0, issues);
  const seeking = typeof input.seeking === 'boolean' ? input.seeking : null;
  if (seeking === null) issues.push({ path: `${path}.seeking`, message: 'must be a boolean' });
  const sourceKind = readEnum(
    input.sourceKind,
    `${path}.sourceKind`,
    RECORDED_SOURCE_KINDS,
    issues,
  ) as SourceKind | 'unknown' | null;
  const confidence = readBoundedNumber(input.confidence, `${path}.confidence`, 0, 1, issues);
  const eventKind = readEnum(
    input.eventKind,
    `${path}.eventKind`,
    RECORDED_EVENT_KINDS,
    issues,
  ) as RawPlaybackEventKind | 'other' | null;
  const sourceInstanceId = readNullableId(
    input.sourceInstanceId,
    `${path}.sourceInstanceId`,
    issues,
  );
  const mediaInstanceId = readNullableId(
    input.mediaInstanceId,
    `${path}.mediaInstanceId`,
    issues,
  );
  if (
    sequence === null
    || elapsedMs === null
    || playbackState === null
    || rate === null
    || seeking === null
    || sourceKind === null
    || confidence === null
    || eventKind === null
  ) return null;
  return {
    sequence,
    elapsedMs,
    positionMs,
    durationMs,
    playbackState,
    rate,
    seeking,
    sourceKind,
    confidence,
    eventKind,
    sourceInstanceId,
    mediaInstanceId,
  };
}

function fallbackSourceKind(signal: RecordedFixtureSignal): SourceKind {
  void signal;
  return 'page-state';
}

function fallbackEventKind(signal: RecordedFixtureSignal): RawPlaybackEventKind {
  if (signal.playbackState === 'unavailable') return 'source-lost';
  if (signal.playbackState === 'buffering') return 'buffer-start';
  return 'sample';
}

function readId(value: unknown, path: string, issues: ValidationIssue[]): string | null {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    issues.push({ path, message: 'must be a non-empty string no longer than 256 characters' });
    return null;
  }
  return value;
}

function readNullableId(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string | null {
  if (value === null) return null;
  return readId(value, path, issues);
}

function readInteger(
  value: unknown,
  path: string,
  minimum: number,
  issues: ValidationIssue[],
): number | null {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    issues.push({ path, message: `must be a safe integer >= ${minimum}` });
    return null;
  }
  return value as number;
}

function readNumber(
  value: unknown,
  path: string,
  minimum: number,
  issues: ValidationIssue[],
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    issues.push({ path, message: `must be a finite number >= ${minimum}` });
    return null;
  }
  return value;
}

function readNullableNumber(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): number | null {
  if (value === null) return null;
  return readNumber(value, path, 0, issues);
}

function readBoundedNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  issues: ValidationIssue[],
): number | null {
  const number = readNumber(value, path, minimum, issues);
  if (number !== null && number > maximum) {
    issues.push({ path, message: `must be <= ${maximum}` });
    return null;
  }
  return number;
}

function readEnum(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
  issues: ValidationIssue[],
): string | null {
  if (typeof value !== 'string' || !allowed.has(value)) {
    issues.push({ path, message: 'contains an unsupported value' });
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid<T>(path: string, message: string): ValidationResult<T> {
  return { success: false, issues: [{ path, message }] };
}
