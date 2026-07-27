export type RawPlaybackSourceKind =
  | 'platform-api'
  | 'media-element'
  | 'page-state'
  | 'dom-progress'
  | 'unknown';

export type RawPlaybackState =
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'unavailable';

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
  | 'metadata'
  | 'other';

export interface RawPlaybackDiagnosticInput {
  readonly capturedAtMs: number;
  readonly positionMs: number | null;
  readonly durationMs: number | null;
  readonly playbackState: RawPlaybackState;
  readonly rate: number;
  readonly seeking: boolean;
  readonly sourceKind: RawPlaybackSourceKind;
  readonly confidence: number;
  readonly eventKind: RawPlaybackEventKind;
  /** Tokenized before retention; never exported verbatim. */
  readonly sourceInstanceKey?: string | null;
  /** Tokenized before retention; never exported verbatim. */
  readonly mediaIdentityKey?: string | null;
  /** A short code-owned label, never page text or a URL. */
  readonly sourceEvent?: string;
}

export interface RecordedRawPlaybackSignal {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly positionMs: number | null;
  readonly durationMs: number | null;
  readonly playbackState: RawPlaybackState;
  readonly rate: number;
  readonly seeking: boolean;
  readonly sourceKind: RawPlaybackSourceKind;
  readonly confidence: number;
  readonly eventKind: RawPlaybackEventKind;
  readonly sourceInstanceId: string | null;
  readonly mediaInstanceId: string | null;
  readonly sourceEvent?: string;
}

export interface RawPlaybackSignalFixture {
  readonly schema: 'lyric-stage-raw-playback-signals';
  readonly schemaVersion: 1;
  readonly platformId: string;
  readonly producerInstanceId: string;
  readonly captureStartedAt: string;
  readonly exportedAt: string;
  readonly recording: boolean;
  readonly droppedEntries: number;
  readonly approximateBytes: number;
  readonly limits: {
    readonly maxEntries: number;
    readonly maxDurationMs: number;
    readonly maxBytes: number;
  };
  readonly signals: readonly RecordedRawPlaybackSignal[];
}

export interface RawPlaybackSignalRecorderOptions {
  readonly maxEntries?: number;
  readonly maxDurationMs?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly wallNow?: () => Date;
  readonly producerInstanceId?: string;
}

export interface RawPlaybackSignalRecorderSummary {
  readonly recording: boolean;
  readonly signalCount: number;
  readonly droppedEntries: number;
  readonly approximateBytes: number;
  readonly durationMs: number;
}

export interface RawPlaybackDiagnosticSink {
  isRecording(): boolean;
  getRecordingEpoch(): number;
  record(input: RawPlaybackDiagnosticInput): boolean;
}

const DEFAULT_MAX_ENTRIES = 8_000;
const DEFAULT_MAX_DURATION_MS = 15 * 60_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_EVENT_LENGTH = 48;

const SOURCE_KINDS = new Set<RawPlaybackSourceKind>([
  'platform-api', 'media-element', 'page-state', 'dom-progress', 'unknown',
]);
const PLAYBACK_STATES = new Set<RawPlaybackState>([
  'playing', 'paused', 'buffering', 'ended', 'unavailable',
]);
const EVENT_KINDS = new Set<RawPlaybackEventKind>([
  'sample', 'play', 'pause', 'buffer-start', 'buffer-end', 'seek-start',
  'seek-end', 'ended', 'media-candidate', 'source-lost', 'navigation',
  'visibility-hidden', 'visibility-visible', 'rate-change', 'metadata', 'other',
]);

interface RuntimeCrypto {
  randomUUID?(): string;
  getRandomValues?<T extends ArrayBufferView>(values: T): T;
}

function runtimeCrypto(): RuntimeCrypto | undefined {
  return (globalThis as { crypto?: RuntimeCrypto }).crypto;
}

function defaultNow(): number {
  const performancePort = (globalThis as {
    performance?: { now(): number };
  }).performance;
  const value = performancePort?.now() ?? Date.now();
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function defaultProducerInstanceId(): string {
  const uuid = runtimeCrypto()?.randomUUID?.();
  return uuid
    ? `producer-${uuid}`
    : `producer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function randomTokenSalt(): string {
  const values = new Uint32Array(4);
  const cryptoPort = runtimeCrypto();
  if (cryptoPort?.getRandomValues) {
    cryptoPort.getRandomValues(values);
    return [...values].map((value) => value.toString(36)).join('-');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function tokenDigest(salt: string, value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  const input = `${salt}\u0000${value}`;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${left.toString(36)}${right.toString(36)}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function finiteNonNegativeOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizePlatformId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return normalized.slice(0, 48) || 'unknown';
}

function normalizeSourceEvent(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized
    && normalized.length <= MAX_SOURCE_EVENT_LENGTH
    && /^[a-z0-9][a-z0-9:_-]*$/.test(normalized)
    ? normalized
    : undefined;
}

function approximateJsonBytes(value: unknown): number {
  return JSON.stringify(value).length * 2;
}

function isoDate(date: Date): string {
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

/** Development-only bounded recorder. Raw source/media keys are never retained. */
export class RawPlaybackSignalRecorder implements RawPlaybackDiagnosticSink {
  readonly #platformId: string;
  readonly #maxEntries: number;
  readonly #maxDurationMs: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #wallNow: () => Date;
  readonly #producerInstanceId: string;
  readonly #tokenSalt = randomTokenSalt();
  #signals: RecordedRawPlaybackSignal[] = [];
  #signalBytes: number[] = [];
  #approximateBytes = 0;
  #droppedEntries = 0;
  #sequence = 0;
  #recording = false;
  #recordingEpoch = 0;
  #captureStartedAtMs = 0;
  #captureStartedAtIso: string;
  #lastElapsedMs = 0;

  constructor(platformId: string, options: RawPlaybackSignalRecorderOptions = {}) {
    this.#platformId = normalizePlatformId(platformId);
    this.#maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.#maxDurationMs = positiveInteger(options.maxDurationMs, DEFAULT_MAX_DURATION_MS);
    this.#maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.#now = options.now ?? defaultNow;
    this.#wallNow = options.wallNow ?? (() => new Date());
    this.#producerInstanceId = options.producerInstanceId?.trim()
      || defaultProducerInstanceId();
    this.#captureStartedAtIso = isoDate(this.#wallNow());
  }

  public start(clearExisting = true): void {
    if (this.#recording && !clearExisting) return;
    if (clearExisting) this.clear();
    this.#captureStartedAtMs = this.#readNow();
    this.#captureStartedAtIso = isoDate(this.#wallNow());
    this.#lastElapsedMs = 0;
    this.#recording = true;
    this.#recordingEpoch = Math.min(Number.MAX_SAFE_INTEGER, this.#recordingEpoch + 1);
  }

  public stop(): void {
    this.#recording = false;
  }

  public clear(): void {
    this.#signals = [];
    this.#signalBytes = [];
    this.#approximateBytes = 0;
    this.#droppedEntries = 0;
    this.#sequence = 0;
    this.#lastElapsedMs = 0;
    if (this.#recording) {
      this.#captureStartedAtMs = this.#readNow();
      this.#captureStartedAtIso = isoDate(this.#wallNow());
      this.#recordingEpoch = Math.min(Number.MAX_SAFE_INTEGER, this.#recordingEpoch + 1);
    }
  }

  public isRecording(): boolean {
    return this.#recording;
  }

  public getRecordingEpoch(): number {
    return this.#recordingEpoch;
  }

  public record(input: RawPlaybackDiagnosticInput): boolean {
    if (!this.#recording) return false;
    const capturedAtMs = finiteNonNegative(input.capturedAtMs, this.#readNow());
    const elapsedMs = Math.max(this.#lastElapsedMs, capturedAtMs - this.#captureStartedAtMs, 0);
    this.#lastElapsedMs = elapsedMs;
    const sourceEvent = normalizeSourceEvent(input.sourceEvent);
    const signal: RecordedRawPlaybackSignal = Object.freeze({
      sequence: ++this.#sequence,
      elapsedMs,
      positionMs: finiteNonNegativeOrNull(input.positionMs),
      durationMs: finiteNonNegativeOrNull(input.durationMs),
      playbackState: PLAYBACK_STATES.has(input.playbackState)
        ? input.playbackState : 'unavailable',
      rate: finiteNonNegative(input.rate, 1),
      seeking: Boolean(input.seeking),
      sourceKind: SOURCE_KINDS.has(input.sourceKind) ? input.sourceKind : 'unknown',
      confidence: Math.min(1, finiteNonNegative(input.confidence, 0)),
      eventKind: EVENT_KINDS.has(input.eventKind) ? input.eventKind : 'other',
      sourceInstanceId: this.#tokenize(input.sourceInstanceKey, 'source'),
      mediaInstanceId: this.#tokenize(input.mediaIdentityKey, 'media'),
      ...(sourceEvent ? { sourceEvent } : {}),
    });
    const bytes = approximateJsonBytes(signal);
    this.#signals.push(signal);
    this.#signalBytes.push(bytes);
    this.#approximateBytes += bytes;
    this.#evictOverflow(elapsedMs);
    return true;
  }

  public createFixture(): RawPlaybackSignalFixture {
    return Object.freeze({
      schema: 'lyric-stage-raw-playback-signals',
      schemaVersion: 1,
      platformId: this.#platformId,
      producerInstanceId: this.#producerInstanceId,
      captureStartedAt: this.#captureStartedAtIso,
      exportedAt: isoDate(this.#wallNow()),
      recording: this.#recording,
      droppedEntries: this.#droppedEntries,
      approximateBytes: this.#approximateBytes,
      limits: Object.freeze({
        maxEntries: this.#maxEntries,
        maxDurationMs: this.#maxDurationMs,
        maxBytes: this.#maxBytes,
      }),
      signals: Object.freeze([...this.#signals]),
    });
  }

  public getSummary(): RawPlaybackSignalRecorderSummary {
    const first = this.#signals[0];
    const last = this.#signals[this.#signals.length - 1];
    return Object.freeze({
      recording: this.#recording,
      signalCount: this.#signals.length,
      droppedEntries: this.#droppedEntries,
      approximateBytes: this.#approximateBytes,
      durationMs: first && last ? Math.max(0, last.elapsedMs - first.elapsedMs) : 0,
    });
  }

  #tokenize(rawKey: string | null | undefined, prefix: string): string | null {
    const key = rawKey?.trim();
    return key ? `${prefix}-${tokenDigest(this.#tokenSalt, key)}` : null;
  }

  #evictOverflow(latestElapsedMs: number): void {
    const oldestAllowed = Math.max(0, latestElapsedMs - this.#maxDurationMs);
    while (
      this.#signals.length > this.#maxEntries
      || this.#approximateBytes > this.#maxBytes
      || (this.#signals[0]?.elapsedMs ?? latestElapsedMs) < oldestAllowed
    ) {
      this.#signals.shift();
      this.#approximateBytes -= this.#signalBytes.shift() ?? 0;
      this.#droppedEntries += 1;
    }
    this.#approximateBytes = Math.max(0, this.#approximateBytes);
  }

  #readNow(): number {
    return finiteNonNegative(this.#now(), 0);
  }
}
