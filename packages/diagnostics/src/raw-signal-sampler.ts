import type { RawPlaybackSignal } from '@lyric-stage/playback-core';
import type { RawPlaybackSignalRecorder } from './recorder.js';

export interface RawSignalDiagnosticSamplerOptions {
  readonly heartbeatMs?: number;
  /**
   * A position that deviates from dead-reckoned continuation by more than
   * this is a discontinuity (seek/backjump) and always records, even between
   * heartbeats. The fingerprint deliberately excludes positionMs, so without
   * this, sub-heartbeat seeks alias into silence.
   */
  readonly positionJumpThresholdMs?: number;
}

/** Coalesces Extension adapter polling into state changes plus a 1 Hz heartbeat. */
export class RawSignalDiagnosticSampler {
  readonly #heartbeatMs: number;
  readonly #positionJumpThresholdMs: number;
  #recordingEpoch = -1;
  #lastRecordedAtMs = Number.NEGATIVE_INFINITY;
  #lastFingerprint = '';
  #lastPositionMs: number | null = null;
  #lastRate = 1;
  #lastPlaying = false;

  constructor(
    private readonly recorder: RawPlaybackSignalRecorder,
    options: RawSignalDiagnosticSamplerOptions = {},
  ) {
    this.#heartbeatMs = Number.isFinite(options.heartbeatMs)
      ? Math.max(100, options.heartbeatMs ?? 1_000)
      : 1_000;
    this.#positionJumpThresholdMs = Number.isFinite(options.positionJumpThresholdMs)
      ? Math.max(50, options.positionJumpThresholdMs ?? 750)
      : 750;
  }

  public record(signal: RawPlaybackSignal): boolean {
    if (!this.recorder.isRecording()) {
      this.#recordingEpoch = -1;
      this.#lastFingerprint = '';
      this.#lastPositionMs = null;
      return false;
    }
    const epoch = this.recorder.getRecordingEpoch();
    const fingerprint = signalFingerprint(signal);
    const firstSinceStart = epoch !== this.#recordingEpoch;
    const stateChanged = fingerprint !== this.#lastFingerprint;
    const positionJumped = this.#positionJumped(signal);
    if (
      !firstSinceStart
      && !stateChanged
      && !positionJumped
      && signal.capturedAtMs - this.#lastRecordedAtMs < this.#heartbeatMs
    ) return false;

    this.#recordingEpoch = epoch;
    this.#lastFingerprint = fingerprint;
    this.#lastRecordedAtMs = signal.capturedAtMs;
    this.#lastPositionMs = signal.positionMs;
    this.#lastRate = signal.rate;
    this.#lastPlaying = signal.playbackState === 'playing';
    return this.recorder.record({
      capturedAtMs: signal.capturedAtMs,
      positionMs: signal.positionMs,
      durationMs: signal.durationMs,
      playbackState: signal.playbackState,
      rate: signal.rate,
      seeking: signal.seeking,
      sourceKind: signal.sourceKind,
      confidence: signal.confidence,
      eventKind: signal.eventKind,
      sourceInstanceKey: signal.sourceInstanceId,
      mediaIdentityKey: mediaIdentityKey(signal),
    });
  }

  #positionJumped(signal: RawPlaybackSignal): boolean {
    if (this.#lastPositionMs === null || signal.positionMs === null) {
      return this.#lastPositionMs !== (signal.positionMs ?? null)
        && this.#lastRecordedAtMs !== Number.NEGATIVE_INFINITY;
    }
    const elapsedMs = Math.max(0, signal.capturedAtMs - this.#lastRecordedAtMs);
    const expectedMs = this.#lastPlaying
      ? this.#lastPositionMs + elapsedMs * this.#lastRate
      : this.#lastPositionMs;
    return Math.abs(signal.positionMs - expectedMs) > this.#positionJumpThresholdMs;
  }
}

function signalFingerprint(signal: RawPlaybackSignal): string {
  return [
    signal.producerInstanceId,
    signal.sessionCandidateId,
    signal.sourceInstanceId,
    mediaIdentityKey(signal) ?? '',
    signal.sourceKind,
    signal.playbackState,
    signal.seeking ? '1' : '0',
    signal.rate.toString(),
    signal.eventKind,
  ].join('\u0000');
}

function mediaIdentityKey(signal: RawPlaybackSignal): string | null {
  const identity = signal.mediaIdentity;
  return identity
    ? [identity.platform, identity.externalId, identity.contextId ?? ''].join('\u0000')
    : null;
}
