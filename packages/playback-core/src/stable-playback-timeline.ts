import type {
  DiscontinuityKind,
  PlaybackDiscontinuity,
  RawPlaybackSignal,
  StablePlaybackAnchor,
  StablePlaybackSnapshot,
} from './types.js';

export interface StablePlaybackTimelineOptions {
  readonly deadbandMs?: number;
  readonly discontinuityThresholdMs?: number;
  readonly discontinuityConfirmationSamples?: number;
  readonly discontinuityCoherenceToleranceMs?: number;
  readonly slewHorizonMs?: number;
  readonly maximumSlewRateDelta?: number;
  readonly minimumProjectionRate?: number;
  readonly loopStartWindowMs?: number;
  readonly loopEndWindowMs?: number;
}

export type TimelineSignalStatus =
  | 'committed'
  | 'staged-discontinuity'
  | 'ignored';

export type TimelineSignalReason =
  | 'session-started'
  | 'source-handoff'
  | 'normal-sample'
  | 'state-change'
  | 'confirmed-seek'
  | 'confirmed-loop'
  | 'confirmed-large-jump'
  | 'resume-reanchor'
  | 'large-jump-candidate'
  | 'stale-session'
  | 'stale-source'
  | 'stale-sequence'
  | 'source-unavailable'
  | 'invalid-position';

export interface TimelineSignalResult {
  readonly status: TimelineSignalStatus;
  readonly reason: TimelineSignalReason;
  readonly anchor: StablePlaybackAnchor | null;
  readonly discontinuity: PlaybackDiscontinuity | null;
}

interface LargeJumpCandidate {
  readonly sourceInstanceId: string;
  readonly positionMs: number;
  readonly receivedAtMs: number;
  readonly playbackState: RawPlaybackSignal['playbackState'];
  readonly rate: number;
  readonly samples: number;
}

const DEFAULT_DEADBAND_MS = 90;
const DEFAULT_DISCONTINUITY_THRESHOLD_MS = 1_800;
const DEFAULT_DISCONTINUITY_CONFIRMATION_SAMPLES = 2;
const DEFAULT_DISCONTINUITY_COHERENCE_TOLERANCE_MS = 400;
const DEFAULT_SLEW_HORIZON_MS = 4_000;
const DEFAULT_MAXIMUM_SLEW_RATE_DELTA = 0.16;
const DEFAULT_MINIMUM_PROJECTION_RATE = 0.05;
const DEFAULT_LOOP_START_WINDOW_MS = 2_000;
const DEFAULT_LOOP_END_WINDOW_MS = 3_000;

/**
 * Turns authoritative raw observations into a continuous local timeline.
 * The class never reads a platform or a global clock. `getSnapshot()` only
 * projects immutable internal anchors against its explicit time argument.
 */
export class StablePlaybackTimeline {
  readonly #deadbandMs: number;
  readonly #discontinuityThresholdMs: number;
  readonly #discontinuityConfirmationSamples: number;
  readonly #discontinuityCoherenceToleranceMs: number;
  readonly #slewHorizonMs: number;
  readonly #maximumSlewRateDelta: number;
  readonly #minimumProjectionRate: number;
  readonly #loopStartWindowMs: number;
  readonly #loopEndWindowMs: number;
  readonly #lastProducerSequence = new Map<string, number>();
  #anchor: StablePlaybackAnchor | null = null;
  #sessionCandidateId: string | null = null;
  #largeJumpCandidate: LargeJumpCandidate | null = null;
  #anchorSequence = 0;
  #discontinuitySequence = 0;
  #resumeReanchorArmed = false;

  constructor(options: StablePlaybackTimelineOptions = {}) {
    this.#deadbandMs = finiteNonNegative(options.deadbandMs, DEFAULT_DEADBAND_MS);
    this.#discontinuityThresholdMs = finitePositive(
      options.discontinuityThresholdMs,
      DEFAULT_DISCONTINUITY_THRESHOLD_MS,
    );
    this.#discontinuityConfirmationSamples = positiveInteger(
      options.discontinuityConfirmationSamples,
      DEFAULT_DISCONTINUITY_CONFIRMATION_SAMPLES,
    );
    this.#discontinuityCoherenceToleranceMs = finiteNonNegative(
      options.discontinuityCoherenceToleranceMs,
      DEFAULT_DISCONTINUITY_COHERENCE_TOLERANCE_MS,
    );
    this.#slewHorizonMs = finitePositive(options.slewHorizonMs, DEFAULT_SLEW_HORIZON_MS);
    this.#maximumSlewRateDelta = finiteNonNegative(
      options.maximumSlewRateDelta,
      DEFAULT_MAXIMUM_SLEW_RATE_DELTA,
    );
    this.#minimumProjectionRate = finiteNonNegative(
      options.minimumProjectionRate,
      DEFAULT_MINIMUM_PROJECTION_RATE,
    );
    this.#loopStartWindowMs = finiteNonNegative(
      options.loopStartWindowMs,
      DEFAULT_LOOP_START_WINDOW_MS,
    );
    this.#loopEndWindowMs = finiteNonNegative(
      options.loopEndWindowMs,
      DEFAULT_LOOP_END_WINDOW_MS,
    );
  }

  public startSession(
    sessionId: string,
    signal: RawPlaybackSignal,
    receivedAtMs: number,
  ): TimelineSignalResult {
    assertId(sessionId, 'sessionId');
    assertTime(receivedAtMs, 'receivedAtMs');
    const previousAnchor = this.#anchor;
    const previous = previousAnchor
      ? this.#projectPosition(previousAnchor, receivedAtMs)
      : normalizePosition(signal.positionMs) ?? 0;
    const positionMs = normalizePosition(signal.positionMs) ?? 0;
    const discontinuity = previousAnchor
      ? this.#createDiscontinuity('session-change', previous, positionMs, receivedAtMs)
      : null;

    this.#anchorSequence = 0;
    if (!previousAnchor) this.#discontinuitySequence = 0;
    this.#lastProducerSequence.clear();
    this.#lastProducerSequence.set(signal.producerInstanceId, signal.producerSequence);
    this.#sessionCandidateId = signal.sessionCandidateId;
    this.#largeJumpCandidate = null;
    this.#resumeReanchorArmed = false;
    this.#anchor = this.#createAnchor(
      sessionId,
      signal,
      receivedAtMs,
      positionMs,
      signal.rate,
      discontinuity,
      false,
    );
    return this.#result('committed', 'session-started', discontinuity);
  }

  public handoffSource(
    sessionId: string,
    signal: RawPlaybackSignal,
    receivedAtMs: number,
  ): TimelineSignalResult {
    if (!this.#sessionMatches(sessionId, signal)) {
      return this.#result('ignored', 'stale-session', null);
    }
    if (!this.#acceptSequence(signal)) {
      return this.#result('ignored', 'stale-sequence', null);
    }
    const current = this.#requireAnchor();
    this.#largeJumpCandidate = null;
    const stablePositionMs = this.#projectPosition(current, receivedAtMs);
    const rawPositionMs = normalizePosition(signal.positionMs);
    const phaseErrorMs = rawPositionMs === null ? 0 : rawPositionMs - stablePositionMs;
    this.#anchor = this.#createAnchor(
      sessionId,
      signal,
      receivedAtMs,
      stablePositionMs,
      this.#projectionRateFor(signal, phaseErrorMs),
      null,
    );
    return this.#result('committed', 'source-handoff', null);
  }

  /** Freezes an expired authority while retaining the current session/position. */
  public markUnavailable(sessionId: string, receivedAtMs: number): TimelineSignalResult {
    assertTime(receivedAtMs, 'receivedAtMs');
    const current = this.#anchor;
    if (!current || current.sessionId !== sessionId) {
      return this.#result('ignored', 'stale-session', null);
    }
    const positionMs = this.#projectPosition(current, receivedAtMs);
    this.#largeJumpCandidate = null;
    this.#anchor = Object.freeze({
      ...current,
      sequence: ++this.#anchorSequence,
      positionMs,
      anchoredAtMs: receivedAtMs,
      playbackState: 'unavailable',
      projectionRate: 0,
      seeking: false,
      confidence: 0,
      discontinuity: null,
    });
    return this.#result('committed', 'source-unavailable', null);
  }

  public ingest(
    sessionId: string,
    signal: RawPlaybackSignal,
    receivedAtMs: number,
  ): TimelineSignalResult {
    assertTime(receivedAtMs, 'receivedAtMs');
    if (!this.#sessionMatches(sessionId, signal)) {
      return this.#result('ignored', 'stale-session', null);
    }
    const current = this.#requireAnchor();
    if (signal.sourceInstanceId !== current.sourceInstanceId) {
      return this.#result('ignored', 'stale-source', null);
    }
    if (!this.#acceptSequence(signal)) {
      return this.#result('ignored', 'stale-sequence', null);
    }

    if (signal.eventKind === 'visibility-hidden') {
      this.#resumeReanchorArmed = true;
    }

    const stablePositionMs = this.#projectPosition(current, receivedAtMs);
    const rawPositionMs = normalizePosition(signal.positionMs);
    if (rawPositionMs === null) {
      this.#largeJumpCandidate = null;
      this.#anchor = this.#createAnchor(
        sessionId,
        signal,
        receivedAtMs,
        stablePositionMs,
        this.#projectionRateFor(signal, 0),
        null,
      );
      return this.#result('committed', 'invalid-position', null);
    }

    const phaseErrorMs = rawPositionMs - stablePositionMs;
    const explicitSeek = signal.eventKind === 'seek-end';
    const loop = this.#isLoopEvidence(current, signal, stablePositionMs, rawPositionMs);
    const resumeReanchor = signal.eventKind === 'visibility-visible'
      && this.#resumeReanchorArmed;

    if (signal.eventKind === 'visibility-visible') {
      this.#resumeReanchorArmed = false;
    }

    if (explicitSeek || loop || (resumeReanchor && Math.abs(phaseErrorMs) > this.#deadbandMs)) {
      const kind: DiscontinuityKind = explicitSeek
        ? 'seek'
        : loop
          ? 'loop'
          : 'resume-reanchor';
      const reason: TimelineSignalReason = explicitSeek
        ? 'confirmed-seek'
        : loop
          ? 'confirmed-loop'
          : 'resume-reanchor';
      return this.#commitDiscontinuity(
        sessionId,
        signal,
        receivedAtMs,
        stablePositionMs,
        rawPositionMs,
        kind,
        reason,
      );
    }

    if (Math.abs(phaseErrorMs) >= this.#discontinuityThresholdMs) {
      const candidateSamples = this.#stageLargeJump(signal, rawPositionMs, receivedAtMs);
      if (candidateSamples < this.#discontinuityConfirmationSamples) {
        this.#anchor = this.#createAnchor(
          sessionId,
          signal,
          receivedAtMs,
          stablePositionMs,
          current.projectionRate,
          null,
        );
        return this.#result('staged-discontinuity', 'large-jump-candidate', null);
      }
      return this.#commitDiscontinuity(
        sessionId,
        signal,
        receivedAtMs,
        stablePositionMs,
        rawPositionMs,
        'unknown',
        'confirmed-large-jump',
      );
    }

    this.#largeJumpCandidate = null;
    const stateChanged = current.playbackState !== signal.playbackState
      || current.seeking !== signal.seeking;
    const committedPositionMs = this.#committedPositionFor(
      stablePositionMs,
      rawPositionMs,
      signal,
    );
    this.#anchor = this.#createAnchor(
      sessionId,
      signal,
      receivedAtMs,
      committedPositionMs,
      this.#projectionRateFor(signal, phaseErrorMs),
      null,
    );
    return this.#result(
      'committed',
      stateChanged ? 'state-change' : 'normal-sample',
      null,
    );
  }

  public getSnapshot(atMs: number): StablePlaybackSnapshot | null {
    assertTime(atMs, 'atMs');
    const anchor = this.#anchor;
    if (!anchor) return null;
    return Object.freeze({
      sessionId: anchor.sessionId,
      anchorSequence: anchor.sequence,
      positionMs: this.#projectPosition(anchor, atMs),
      durationMs: anchor.durationMs,
      playbackState: anchor.playbackState,
      rate: anchor.rate,
      seeking: anchor.seeking,
      available: anchor.playbackState !== 'unavailable',
      discontinuitySequence: this.#discontinuitySequence,
    });
  }

  public getAnchor(): StablePlaybackAnchor | null {
    return this.#anchor;
  }

  public reset(): void {
    this.#anchor = null;
    this.#sessionCandidateId = null;
    this.#largeJumpCandidate = null;
    this.#anchorSequence = 0;
    this.#discontinuitySequence = 0;
    this.#resumeReanchorArmed = false;
    this.#lastProducerSequence.clear();
  }

  #commitDiscontinuity(
    sessionId: string,
    signal: RawPlaybackSignal,
    receivedAtMs: number,
    fromPositionMs: number,
    toPositionMs: number,
    kind: DiscontinuityKind,
    reason: TimelineSignalReason,
  ): TimelineSignalResult {
    const discontinuity = this.#createDiscontinuity(
      kind,
      fromPositionMs,
      toPositionMs,
      receivedAtMs,
    );
    this.#largeJumpCandidate = null;
    this.#anchor = this.#createAnchor(
      sessionId,
      signal,
      receivedAtMs,
      toPositionMs,
      signal.rate,
      discontinuity,
    );
    return this.#result('committed', reason, discontinuity);
  }

  #stageLargeJump(
    signal: RawPlaybackSignal,
    rawPositionMs: number,
    receivedAtMs: number,
  ): number {
    const previous = this.#largeJumpCandidate;
    const expectedPositionMs = previous
      ? previous.positionMs + (
        previous.playbackState === 'playing'
          ? Math.max(0, receivedAtMs - previous.receivedAtMs) * previous.rate
          : 0
      )
      : rawPositionMs;
    const coherent = previous !== null
      && previous.sourceInstanceId === signal.sourceInstanceId
      && Math.abs(rawPositionMs - expectedPositionMs) <= this.#discontinuityCoherenceToleranceMs;
    const samples = coherent ? previous.samples + 1 : 1;
    this.#largeJumpCandidate = {
      sourceInstanceId: signal.sourceInstanceId,
      positionMs: rawPositionMs,
      receivedAtMs,
      playbackState: signal.playbackState,
      rate: signal.rate,
      samples,
    };
    return samples;
  }

  #isLoopEvidence(
    current: StablePlaybackAnchor,
    signal: RawPlaybackSignal,
    stablePositionMs: number,
    rawPositionMs: number,
  ): boolean {
    const durationMs = signal.durationMs ?? current.durationMs;
    return current.playbackState === 'ended'
      && signal.playbackState === 'playing'
      && rawPositionMs <= this.#loopStartWindowMs
      && (
        durationMs === null
          ? stablePositionMs - rawPositionMs >= this.#discontinuityThresholdMs
          : stablePositionMs >= Math.max(0, durationMs - this.#loopEndWindowMs)
      );
  }

  #projectionRateFor(signal: RawPlaybackSignal, phaseErrorMs: number): number {
    if (signal.playbackState !== 'playing' || signal.seeking) return signal.rate;
    if (Math.abs(phaseErrorMs) <= this.#deadbandMs) return signal.rate;
    const correction = clamp(
      phaseErrorMs / this.#slewHorizonMs,
      -this.#maximumSlewRateDelta,
      this.#maximumSlewRateDelta,
    );
    return Math.max(this.#minimumProjectionRate, signal.rate + correction);
  }

  #committedPositionFor(
    stablePositionMs: number,
    rawPositionMs: number,
    signal: RawPlaybackSignal,
  ): number {
    if (signal.playbackState === 'playing' && !signal.seeking) return stablePositionMs;
    return Math.max(stablePositionMs, rawPositionMs);
  }

  #projectPosition(anchor: StablePlaybackAnchor, atMs: number): number {
    const elapsedMs = Math.max(0, atMs - anchor.anchoredAtMs);
    const projected = anchor.playbackState === 'playing' && !anchor.seeking
      ? anchor.positionMs + elapsedMs * anchor.projectionRate
      : anchor.positionMs;
    return Math.max(0, projected);
  }

  #createAnchor(
    sessionId: string,
    signal: RawPlaybackSignal,
    receivedAtMs: number,
    positionMs: number,
    projectionRate: number,
    discontinuity: PlaybackDiscontinuity | null,
    preservePreviousDuration = true,
  ): StablePlaybackAnchor {
    const previousDurationMs = preservePreviousDuration
      && this.#anchor?.sessionId === sessionId
      ? this.#anchor.durationMs
      : null;
    return Object.freeze({
      sessionId,
      sequence: ++this.#anchorSequence,
      positionMs,
      anchoredAtMs: receivedAtMs,
      durationMs: normalizeDuration(signal.durationMs) ?? previousDurationMs,
      playbackState: signal.playbackState,
      rate: signal.rate,
      projectionRate,
      seeking: signal.seeking,
      sourceInstanceId: signal.sourceInstanceId,
      sourceKind: signal.sourceKind,
      confidence: signal.confidence,
      discontinuity,
    });
  }

  #createDiscontinuity(
    kind: DiscontinuityKind,
    fromPositionMs: number,
    toPositionMs: number,
    committedAtMs: number,
  ): PlaybackDiscontinuity {
    return Object.freeze({
      sequence: ++this.#discontinuitySequence,
      kind,
      fromPositionMs,
      toPositionMs,
      committedAtMs,
    });
  }

  #sessionMatches(sessionId: string, signal: RawPlaybackSignal): boolean {
    return this.#anchor?.sessionId === sessionId
      && this.#sessionCandidateId === signal.sessionCandidateId;
  }

  #acceptSequence(signal: RawPlaybackSignal): boolean {
    const previous = this.#lastProducerSequence.get(signal.producerInstanceId) ?? 0;
    if (signal.producerSequence <= previous) return false;
    this.#lastProducerSequence.set(signal.producerInstanceId, signal.producerSequence);
    return true;
  }

  #requireAnchor(): StablePlaybackAnchor {
    if (!this.#anchor) throw new Error('playback session has not been started');
    return this.#anchor;
  }

  #result(
    status: TimelineSignalStatus,
    reason: TimelineSignalReason,
    discontinuity: PlaybackDiscontinuity | null,
  ): TimelineSignalResult {
    return Object.freeze({ status, reason, anchor: this.#anchor, discontinuity });
  }
}

function normalizePosition(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeDuration(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertId(value: string, label: string): void {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
}

function assertTime(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
