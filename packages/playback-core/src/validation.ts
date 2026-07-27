import type {
  MediaIdentity,
  PlaybackState,
  RawPlaybackEventKind,
  RawPlaybackSignal,
  SourceKind,
} from './types.js';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly issues: readonly ValidationIssue[] };

const PLAYBACK_STATES: ReadonlySet<string> = new Set<PlaybackState>([
  'playing',
  'paused',
  'buffering',
  'ended',
  'unavailable',
]);

const SOURCE_KINDS: ReadonlySet<string> = new Set<SourceKind>([
  'platform-api',
  'media-element',
  'page-state',
  'dom-progress',
]);

const EVENT_KINDS: ReadonlySet<string> = new Set<RawPlaybackEventKind>([
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
]);

const SIGNAL_FIELDS: ReadonlySet<string> = new Set([
  'producerInstanceId',
  'producerSequence',
  'sessionCandidateId',
  'sourceInstanceId',
  'sourceKind',
  'capturedAtMs',
  'positionMs',
  'durationMs',
  'playbackState',
  'rate',
  'seeking',
  'mediaIdentity',
  'confidence',
  'eventKind',
]);

const MEDIA_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  'platform',
  'externalId',
  'contextId',
]);

export function parseRawPlaybackSignal(input: unknown): ValidationResult<RawPlaybackSignal> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return invalid('$', 'must be an object');
  }

  rejectUnknownFields(input, SIGNAL_FIELDS, '$', issues);
  const producerInstanceId = readId(input, 'producerInstanceId', issues);
  const producerSequence = readPositiveInteger(input, 'producerSequence', issues);
  const sessionCandidateId = readId(input, 'sessionCandidateId', issues);
  const sourceInstanceId = readId(input, 'sourceInstanceId', issues);
  const sourceKind = readEnum(input, 'sourceKind', SOURCE_KINDS, issues) as SourceKind | null;
  const capturedAtMs = readFinite(input, 'capturedAtMs', 0, Number.POSITIVE_INFINITY, issues);
  const positionMs = readNullableFinite(input, 'positionMs', issues);
  const durationMs = readNullableFinite(input, 'durationMs', issues);
  const playbackState = readEnum(
    input,
    'playbackState',
    PLAYBACK_STATES,
    issues,
  ) as PlaybackState | null;
  const rate = readFinite(input, 'rate', Number.MIN_VALUE, 16, issues);
  const seeking = readBoolean(input, 'seeking', issues);
  const mediaIdentity = readMediaIdentity(input.mediaIdentity, issues);
  const confidence = readFinite(input, 'confidence', 0, 1, issues);
  const eventKind = readEnum(
    input,
    'eventKind',
    EVENT_KINDS,
    issues,
  ) as RawPlaybackEventKind | null;

  if (issues.length > 0) return { success: false, issues };

  return {
    success: true,
    value: {
      producerInstanceId: producerInstanceId!,
      producerSequence: producerSequence!,
      sessionCandidateId: sessionCandidateId!,
      sourceInstanceId: sourceInstanceId!,
      sourceKind: sourceKind!,
      capturedAtMs: capturedAtMs!,
      positionMs,
      durationMs,
      playbackState: playbackState!,
      rate: rate!,
      seeking: seeking!,
      mediaIdentity,
      confidence: confidence!,
      eventKind: eventKind!,
    },
  };
}

export function isRawPlaybackSignal(input: unknown): input is RawPlaybackSignal {
  return parseRawPlaybackSignal(input).success;
}

function readMediaIdentity(
  value: unknown,
  issues: ValidationIssue[],
): MediaIdentity | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    issues.push({ path: '$.mediaIdentity', message: 'must be an object or null' });
    return null;
  }
  rejectUnknownFields(value, MEDIA_IDENTITY_FIELDS, '$.mediaIdentity', issues);
  const platform = readId(value, 'platform', issues, '$.mediaIdentity');
  const externalId = readId(value, 'externalId', issues, '$.mediaIdentity');
  const contextId = value.contextId === undefined
    ? undefined
    : readId(value, 'contextId', issues, '$.mediaIdentity');
  if (!platform || !externalId) return null;
  return contextId
    ? { platform, externalId, contextId }
    : { platform, externalId };
}

function readId(
  record: Readonly<Record<string, unknown>>,
  field: string,
  issues: ValidationIssue[],
  parent = '$',
): string | null {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    issues.push({
      path: `${parent}.${field}`,
      message: 'must be a non-empty string no longer than 256 characters',
    });
    return null;
  }
  return value;
}

function readPositiveInteger(
  record: Readonly<Record<string, unknown>>,
  field: string,
  issues: ValidationIssue[],
): number | null {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    issues.push({ path: `$.${field}`, message: 'must be a positive safe integer' });
    return null;
  }
  return value as number;
}

function readFinite(
  record: Readonly<Record<string, unknown>>,
  field: string,
  minimum: number,
  maximum: number,
  issues: ValidationIssue[],
): number | null {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    issues.push({ path: `$.${field}`, message: `must be finite and in [${minimum}, ${maximum}]` });
    return null;
  }
  return value;
}

function readNullableFinite(
  record: Readonly<Record<string, unknown>>,
  field: string,
  issues: ValidationIssue[],
): number | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    issues.push({ path: `$.${field}`, message: 'must be finite and non-negative, or null' });
    return null;
  }
  return value;
}

function readBoolean(
  record: Readonly<Record<string, unknown>>,
  field: string,
  issues: ValidationIssue[],
): boolean | null {
  const value = record[field];
  if (typeof value !== 'boolean') {
    issues.push({ path: `$.${field}`, message: 'must be a boolean' });
    return null;
  }
  return value;
}

function readEnum(
  record: Readonly<Record<string, unknown>>,
  field: string,
  values: ReadonlySet<string>,
  issues: ValidationIssue[],
): string | null {
  const value = record[field];
  if (typeof value !== 'string' || !values.has(value)) {
    issues.push({ path: `$.${field}`, message: 'contains an unsupported value' });
    return null;
  }
  return value;
}

function rejectUnknownFields(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.push({ path: `${path}.${key}`, message: 'is not allowed' });
    }
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid<T>(path: string, message: string): ValidationResult<T> {
  return { success: false, issues: [{ path, message }] };
}
