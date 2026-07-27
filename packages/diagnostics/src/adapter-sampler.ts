import type {
  RawPlaybackDiagnosticSink,
  RawPlaybackEventKind,
  RawPlaybackSourceKind,
  RawPlaybackState,
} from './recorder.js';

export interface AdapterSignalContext {
  readonly positionMs: number | null;
  readonly durationMs: number | null;
  readonly playbackState: RawPlaybackState;
  readonly rate: number;
  readonly seeking: boolean;
  readonly sourceKind: RawPlaybackSourceKind;
  readonly sourceInstanceKey?: string | null;
  readonly mediaIdentityKey?: string | null;
  readonly confidence: number;
  readonly eventKind?: RawPlaybackEventKind;
  readonly sourceEvent?: string;
}

export interface AdapterDiagnosticSamplerOptions {
  readonly sink?: RawPlaybackDiagnosticSink | null;
  readonly now?: () => number;
  readonly heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 1_000;

/** Compatibility sampler for the reference userscript adapters. */
export class AdapterDiagnosticSampler {
  readonly #sink: RawPlaybackDiagnosticSink | null;
  readonly #now: () => number;
  readonly #heartbeatMs: number;
  #pendingEventKind: RawPlaybackEventKind | null = null;
  #pendingSourceEvent: string | undefined;
  #lastRecordedAtMs = Number.NEGATIVE_INFINITY;
  #recordingEpoch = -1;

  constructor(options: AdapterDiagnosticSamplerOptions = {}) {
    this.#sink = options.sink ?? null;
    this.#now = options.now ?? (() => defaultNow());
    this.#heartbeatMs = Number.isFinite(options.heartbeatMs)
      ? Math.max(100, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
      : DEFAULT_HEARTBEAT_MS;
  }

  public isRecording(): boolean {
    return this.#sink?.isRecording() === true;
  }

  public noteEvent(eventKind: RawPlaybackEventKind, sourceEvent?: string): void {
    if (!this.#sink?.isRecording()) {
      this.#resetPending();
      return;
    }
    this.#pendingEventKind = eventKind;
    this.#pendingSourceEvent = sourceEvent;
  }

  public record(sample: AdapterSignalContext): void {
    const sink = this.#sink;
    if (!sink?.isRecording()) {
      this.#resetPending();
      return;
    }
    const now = this.#readNow();
    const epoch = sink.getRecordingEpoch();
    const firstSinceStart = epoch !== this.#recordingEpoch;
    this.#recordingEpoch = epoch;
    if (
      !firstSinceStart
      && this.#pendingEventKind === null
      && now - this.#lastRecordedAtMs < this.#heartbeatMs
    ) return;

    const eventKind = this.#pendingEventKind ?? sample.eventKind ?? 'sample';
    sink.record({
      ...sample,
      capturedAtMs: now,
      playbackState: stateForEvent(eventKind, sample.playbackState),
      eventKind,
      ...(this.#pendingSourceEvent ?? sample.sourceEvent
        ? { sourceEvent: this.#pendingSourceEvent ?? sample.sourceEvent }
        : {}),
    });
    this.#lastRecordedAtMs = now;
    this.#pendingEventKind = null;
    this.#pendingSourceEvent = undefined;
  }

  #resetPending(): void {
    this.#pendingEventKind = null;
    this.#pendingSourceEvent = undefined;
    this.#recordingEpoch = -1;
  }

  #readNow(): number {
    const value = this.#now();
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }
}

function stateForEvent(
  eventKind: RawPlaybackEventKind | undefined,
  fallback: RawPlaybackState,
): RawPlaybackState {
  if (eventKind === 'play' || eventKind === 'buffer-end') return 'playing';
  if (eventKind === 'pause') return 'paused';
  if (eventKind === 'buffer-start' || eventKind === 'seek-start') return 'buffering';
  if (eventKind === 'ended') return 'ended';
  if (eventKind === 'source-lost') return 'unavailable';
  return fallback;
}

function defaultNow(): number {
  return (globalThis as { performance?: { now(): number } }).performance?.now()
    ?? Date.now();
}
