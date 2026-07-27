import type { MediaIdentity, RawPlaybackSignal, SourceKind } from './types.js';

export interface SourceArbiterOptions {
  /** How long a healthy authority may remain silent before it becomes stale. */
  readonly sourceTtlMs?: number;
  /** Persistent unhealthy time required before a lower-priority source may win. */
  readonly unhealthyGraceMs?: number;
  /** Coherent observations required for a takeover. */
  readonly takeoverSampleCount?: number;
  /** Maximum candidate phase error between consecutive observations. */
  readonly coherenceToleranceMs?: number;
  /** Minimum evidence accepted as a healthy observation. */
  readonly minimumConfidence?: number;
  /** Prevents immediate handback after a source change. */
  readonly switchCooldownMs?: number;
  readonly priority?: Readonly<Record<SourceKind, number>>;
}

export interface PlaybackSourceAuthority {
  readonly sessionCandidateId: string;
  readonly sourceInstanceId: string;
  readonly sourceKind: SourceKind;
  readonly producerInstanceId: string;
  readonly mediaIdentity: MediaIdentity | null;
  readonly confidence: number;
  readonly selectedAtMs: number;
  readonly lastHealthyAtMs: number;
}

export type AuthorityChangeReason =
  | 'initial-source'
  | 'higher-priority-source'
  | 'media-replacement'
  | 'authority-unhealthy'
  | 'authority-expired';

export interface SourceArbitrationResult {
  readonly accepted: boolean;
  readonly signalIsAuthoritative: boolean;
  readonly authorityHealthy: boolean;
  readonly authority: PlaybackSourceAuthority | null;
  readonly previousAuthority: PlaybackSourceAuthority | null;
  readonly changed: boolean;
  /** True when the selected source reports a different playback session epoch. */
  readonly sessionCandidateChanged: boolean;
  readonly reason: AuthorityChangeReason | null;
}

interface CandidateState {
  signal: RawPlaybackSignal;
  coherentSamples: number;
  lastHealthyAtMs: number;
  unhealthySinceMs: number | null;
  consecutiveUnhealthySamples: number;
}

const DEFAULT_PRIORITY: Readonly<Record<SourceKind, number>> = Object.freeze({
  'platform-api': 4,
  'media-element': 3,
  'page-state': 2,
  'dom-progress': 1,
});

const DEFAULT_SOURCE_TTL_MS = 2_500;
const DEFAULT_UNHEALTHY_GRACE_MS = 900;
const DEFAULT_TAKEOVER_SAMPLE_COUNT = 2;
const DEFAULT_COHERENCE_TOLERANCE_MS = 450;
const DEFAULT_MINIMUM_CONFIDENCE = 0.35;
const DEFAULT_SWITCH_COOLDOWN_MS = 750;

/**
 * Selects one raw source without allowing a single failed read or priority
 * fluctuation to ping-pong the authority.
 *
 * Receive time is supplied by the host because producer timestamps from
 * different execution contexts do not share an epoch.
 */
export class SourceArbiter {
  readonly #sourceTtlMs: number;
  readonly #unhealthyGraceMs: number;
  readonly #takeoverSampleCount: number;
  readonly #coherenceToleranceMs: number;
  readonly #minimumConfidence: number;
  readonly #switchCooldownMs: number;
  readonly #priority: Readonly<Record<SourceKind, number>>;
  readonly #candidates = new Map<string, CandidateState>();
  readonly #lastProducerSequence = new Map<string, number>();
  #authoritySourceId: string | null = null;
  #lastSwitchAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: SourceArbiterOptions = {}) {
    this.#sourceTtlMs = finiteNonNegative(options.sourceTtlMs, DEFAULT_SOURCE_TTL_MS);
    this.#unhealthyGraceMs = finiteNonNegative(
      options.unhealthyGraceMs,
      DEFAULT_UNHEALTHY_GRACE_MS,
    );
    this.#takeoverSampleCount = positiveInteger(
      options.takeoverSampleCount,
      DEFAULT_TAKEOVER_SAMPLE_COUNT,
    );
    this.#coherenceToleranceMs = finiteNonNegative(
      options.coherenceToleranceMs,
      DEFAULT_COHERENCE_TOLERANCE_MS,
    );
    this.#minimumConfidence = finiteRange(
      options.minimumConfidence,
      DEFAULT_MINIMUM_CONFIDENCE,
      0,
      1,
    );
    this.#switchCooldownMs = finiteNonNegative(
      options.switchCooldownMs,
      DEFAULT_SWITCH_COOLDOWN_MS,
    );
    this.#priority = options.priority ?? DEFAULT_PRIORITY;
  }

  public observe(signal: RawPlaybackSignal, receivedAtMs: number): SourceArbitrationResult {
    assertReceiveTime(receivedAtMs);
    const previousAuthority = this.#authority();
    const authorityCandidateBeforeObservation = this.#authorityCandidate();
    if (!this.#acceptSequence(signal)) {
      return this.#result(
        false,
        signal.sourceInstanceId,
        previousAuthority,
        previousAuthority,
        null,
        receivedAtMs,
      );
    }

    if (
      authorityCandidateBeforeObservation
      && signal.sourceInstanceId === this.#authoritySourceId
      && signal.sessionCandidateId !== authorityCandidateBeforeObservation.signal.sessionCandidateId
    ) {
      this.#updateCandidate(signal, receivedAtMs);
      return this.#result(
        true,
        signal.sourceInstanceId,
        previousAuthority,
        this.#authority(),
        null,
        receivedAtMs,
      );
    }

    const candidate = this.#updateCandidate(signal, receivedAtMs);
    const authorityCandidate = authorityCandidateBeforeObservation;

    if (!authorityCandidate) {
      if (!isHealthySignal(signal, this.#minimumConfidence)) {
        return this.#result(
          true,
          signal.sourceInstanceId,
          previousAuthority,
          null,
          null,
          receivedAtMs,
        );
      }
      this.#select(signal.sourceInstanceId, receivedAtMs);
      return this.#result(
        true,
        signal.sourceInstanceId,
        previousAuthority,
        this.#authority(),
        'initial-source',
        receivedAtMs,
      );
    }

    if (signal.sourceInstanceId === this.#authoritySourceId) {
      return this.#result(
        true,
        signal.sourceInstanceId,
        previousAuthority,
        this.#authority(),
        null,
        receivedAtMs,
      );
    }

    if (!isHealthySignal(signal, this.#minimumConfidence)) {
      return this.#result(
        true,
        signal.sourceInstanceId,
        previousAuthority,
        this.#authority(),
        null,
        receivedAtMs,
      );
    }

    const authorityHealthy = this.#isHealthy(authorityCandidate, receivedAtMs);
    const candidateHealthy = this.#isHealthy(candidate, receivedAtMs);
    const candidateConfirmed = candidate.coherentSamples >= this.#takeoverSampleCount;
    const compatible = sourcesDescribeSameMedia(authorityCandidate.signal, candidate.signal);
    const cooldownComplete = receivedAtMs - this.#lastSwitchAtMs >= this.#switchCooldownMs;
    const candidatePriority = this.#priority[candidate.signal.sourceKind];
    const authorityPriority = this.#priority[authorityCandidate.signal.sourceKind];

    if (candidateHealthy && candidateConfirmed && cooldownComplete) {
      // A confirmed source describing different media/session is a track or
      // episode replacement. Waiting for TTL expiry would leave the timeline
      // projecting a dead authority through the whole next song.
      if (!compatible) {
        this.#select(signal.sourceInstanceId, receivedAtMs);
        return this.#result(
          true,
          signal.sourceInstanceId,
          previousAuthority,
          this.#authority(),
          'media-replacement',
          receivedAtMs,
        );
      }

      if (candidatePriority > authorityPriority) {
        this.#select(signal.sourceInstanceId, receivedAtMs);
        return this.#result(
          true,
          signal.sourceInstanceId,
          previousAuthority,
          this.#authority(),
          'higher-priority-source',
          receivedAtMs,
        );
      }

      if (!authorityHealthy && this.#authorityUnhealthyLongEnough(authorityCandidate, receivedAtMs)) {
        this.#select(signal.sourceInstanceId, receivedAtMs);
        return this.#result(
          true,
          signal.sourceInstanceId,
          previousAuthority,
          this.#authority(),
          'authority-unhealthy',
          receivedAtMs,
        );
      }
    }

    return this.#result(
      true,
      signal.sourceInstanceId,
      previousAuthority,
      this.#authority(),
      null,
      receivedAtMs,
    );
  }

  /** Returns whether an adapter observation carries enough evidence for time use. */
  public isSignalHealthy(signal: RawPlaybackSignal): boolean {
    return isHealthySignal(signal, this.#minimumConfidence);
  }

  /** Evaluates TTL expiry even when no source produces another observation. */
  public evaluate(receivedAtMs: number): SourceArbitrationResult {
    assertReceiveTime(receivedAtMs);
    const previousAuthority = this.#authority();
    const authorityCandidate = this.#authorityCandidate();
    if (!authorityCandidate || this.#isHealthy(authorityCandidate, receivedAtMs)) {
      return this.#result(
        true,
        null,
        previousAuthority,
        previousAuthority,
        null,
        receivedAtMs,
      );
    }

    const replacement = [...this.#candidates.values()]
      .filter((candidate) => (
        candidate.signal.sourceInstanceId !== this.#authoritySourceId
        && this.#isHealthy(candidate, receivedAtMs)
        && candidate.coherentSamples >= this.#takeoverSampleCount
      ))
      .sort((left, right) => {
        const leftCompatible = sourcesDescribeSameMedia(
          authorityCandidate.signal,
          left.signal,
        ) ? 1 : 0;
        const rightCompatible = sourcesDescribeSameMedia(
          authorityCandidate.signal,
          right.signal,
        ) ? 1 : 0;
        // Prefer same-media fallbacks when available; otherwise accept a
        // confirmed different-media replacement for track changes.
        return (
          rightCompatible - leftCompatible
          || this.#priority[right.signal.sourceKind] - this.#priority[left.signal.sourceKind]
          || right.lastHealthyAtMs - left.lastHealthyAtMs
        );
      })[0];

    if (
      replacement
      && this.#authorityUnhealthyLongEnough(authorityCandidate, receivedAtMs)
      && receivedAtMs - this.#lastSwitchAtMs >= this.#switchCooldownMs
    ) {
      this.#select(replacement.signal.sourceInstanceId, receivedAtMs);
      const reason = sourcesDescribeSameMedia(
        authorityCandidate.signal,
        replacement.signal,
      ) ? 'authority-unhealthy' : 'media-replacement';
      return this.#result(
        true,
        null,
        previousAuthority,
        this.#authority(),
        reason,
        receivedAtMs,
      );
    }

    if (this.#authorityUnhealthyLongEnough(authorityCandidate, receivedAtMs)) {
      this.#authoritySourceId = null;
      return this.#result(
        true,
        null,
        previousAuthority,
        null,
        'authority-expired',
        receivedAtMs,
      );
    }

    return this.#result(
      true,
      null,
      previousAuthority,
      previousAuthority,
      null,
      receivedAtMs,
    );
  }

  public getAuthority(receivedAtMs: number): PlaybackSourceAuthority | null {
    assertReceiveTime(receivedAtMs);
    return this.#authority();
  }

  public reset(): void {
    this.#candidates.clear();
    this.#lastProducerSequence.clear();
    this.#authoritySourceId = null;
    this.#lastSwitchAtMs = Number.NEGATIVE_INFINITY;
  }

  #acceptSequence(signal: RawPlaybackSignal): boolean {
    const previous = this.#lastProducerSequence.get(signal.producerInstanceId) ?? 0;
    if (signal.producerSequence <= previous) return false;
    this.#lastProducerSequence.set(signal.producerInstanceId, signal.producerSequence);
    return true;
  }

  #updateCandidate(signal: RawPlaybackSignal, receivedAtMs: number): CandidateState {
    const previous = this.#candidates.get(signal.sourceInstanceId);
    const healthy = isHealthySignal(signal, this.#minimumConfidence);
    const coherent = previous ? this.#signalsAreCoherent(previous.signal, signal) : true;
    const sameSession = previous?.signal.sessionCandidateId === signal.sessionCandidateId;
    const sameMedia = previous ? sourcesDescribeSameMedia(previous.signal, signal) : true;
    const coherentSamples = previous && sameSession && sameMedia && coherent
      ? Math.min(Number.MAX_SAFE_INTEGER, previous.coherentSamples + 1)
      : 1;
    const consecutiveUnhealthySamples = healthy
      ? 0
      : (previous?.consecutiveUnhealthySamples ?? 0) + 1;
    const isolatedFailure = signal.eventKind !== 'source-lost'
      && consecutiveUnhealthySamples === 1;
    const lastHealthyAtMs = healthy
      ? receivedAtMs
      : previous?.lastHealthyAtMs ?? receivedAtMs;
    const unhealthySinceMs = healthy
      ? null
      : isolatedFailure
        ? null
        : previous?.unhealthySinceMs ?? receivedAtMs;
    const candidate: CandidateState = {
      signal,
      coherentSamples,
      lastHealthyAtMs,
      unhealthySinceMs,
      consecutiveUnhealthySamples,
    };
    this.#candidates.set(signal.sourceInstanceId, candidate);
    return candidate;
  }

  #signalsAreCoherent(previous: RawPlaybackSignal, next: RawPlaybackSignal): boolean {
    if (
      previous.producerInstanceId === next.producerInstanceId
      && (next.producerSequence <= previous.producerSequence
        || next.capturedAtMs < previous.capturedAtMs)
    ) return false;
    if (previous.positionMs === null || next.positionMs === null) {
      return next.eventKind !== 'source-lost';
    }
    if (isDiscontinuityEvidence(next.eventKind)) return true;
    const elapsedMs = previous.producerInstanceId === next.producerInstanceId
      ? Math.max(0, next.capturedAtMs - previous.capturedAtMs)
      : 0;
    const expectedPositionMs = previous.playbackState === 'playing' && !previous.seeking
      ? previous.positionMs + elapsedMs * previous.rate
      : previous.positionMs;
    return Math.abs(next.positionMs - expectedPositionMs) <= this.#coherenceToleranceMs;
  }

  #isHealthy(candidate: CandidateState, receivedAtMs: number): boolean {
    return candidate.unhealthySinceMs === null
      && receivedAtMs - candidate.lastHealthyAtMs <= this.#sourceTtlMs;
  }

  #authorityUnhealthyLongEnough(candidate: CandidateState, receivedAtMs: number): boolean {
    const unhealthySinceMs = candidate.unhealthySinceMs
      ?? candidate.lastHealthyAtMs + this.#sourceTtlMs;
    return receivedAtMs - unhealthySinceMs >= this.#unhealthyGraceMs;
  }

  #authorityCandidate(): CandidateState | null {
    return this.#authoritySourceId
      ? this.#candidates.get(this.#authoritySourceId) ?? null
      : null;
  }

  #select(sourceInstanceId: string, receivedAtMs: number): void {
    this.#authoritySourceId = sourceInstanceId;
    this.#lastSwitchAtMs = receivedAtMs;
  }

  #authority(): PlaybackSourceAuthority | null {
    const candidate = this.#authorityCandidate();
    if (!candidate) return null;
    return Object.freeze({
      sessionCandidateId: candidate.signal.sessionCandidateId,
      sourceInstanceId: candidate.signal.sourceInstanceId,
      sourceKind: candidate.signal.sourceKind,
      producerInstanceId: candidate.signal.producerInstanceId,
      mediaIdentity: candidate.signal.mediaIdentity,
      confidence: candidate.signal.confidence,
      selectedAtMs: this.#lastSwitchAtMs,
      lastHealthyAtMs: candidate.lastHealthyAtMs,
    });
  }

  #result(
    accepted: boolean,
    observedSourceInstanceId: string | null,
    previousAuthority: PlaybackSourceAuthority | null,
    authority: PlaybackSourceAuthority | null,
    reason: AuthorityChangeReason | null,
    receivedAtMs: number,
  ): SourceArbitrationResult {
    const authorityCandidate = this.#authorityCandidate();
    return Object.freeze({
      accepted,
      signalIsAuthoritative: observedSourceInstanceId !== null
        && authority?.sourceInstanceId === observedSourceInstanceId,
      authorityHealthy: authorityCandidate !== null
        && this.#isHealthy(authorityCandidate, receivedAtMs),
      authority,
      previousAuthority,
      changed: previousAuthority?.sourceInstanceId !== authority?.sourceInstanceId,
      sessionCandidateChanged: previousAuthority !== null
        && authority !== null
        && (
          previousAuthority.sessionCandidateId !== authority.sessionCandidateId
          || !mediaIdentitiesEqual(
            previousAuthority.mediaIdentity,
            authority.mediaIdentity,
          )
        ),
      reason,
    });
  }
}

function isHealthySignal(signal: RawPlaybackSignal, minimumConfidence: number): boolean {
  return signal.eventKind !== 'source-lost'
    && signal.playbackState !== 'unavailable'
    && signal.confidence >= minimumConfidence;
}

function sourcesDescribeSameMedia(left: RawPlaybackSignal, right: RawPlaybackSignal): boolean {
  if (left.sessionCandidateId !== right.sessionCandidateId) return false;
  return mediaIdentitiesEqual(left.mediaIdentity, right.mediaIdentity);
}

function mediaIdentitiesEqual(
  left: MediaIdentity | null,
  right: MediaIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.platform === right.platform
    && left.externalId === right.externalId
    && left.contextId === right.contextId;
}

function isDiscontinuityEvidence(eventKind: RawPlaybackSignal['eventKind']): boolean {
  return eventKind === 'seek-start'
    || eventKind === 'seek-end'
    || eventKind === 'navigation'
    || eventKind === 'media-candidate';
}

function assertReceiveTime(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('receivedAtMs must be a finite non-negative number');
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finiteRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    ? value
    : fallback;
}
