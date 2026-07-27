import type { SparsePlaybackAnchorV1 } from '@lyric-stage/extension-protocol';
import type {
  PlaybackClock,
  PlaybackDiscontinuity,
  PlaybackSnapshot,
  Unsubscribe,
} from '@lyric-stage/player';
import {
  projectSparseAnchor,
  type HeldSparseAnchor,
} from './project-sparse-anchor.js';

export interface SparseAnchorClock extends PlaybackClock {
  /** Accept a new content sparse anchor (or clear). */
  applyAnchor(anchor: SparsePlaybackAnchorV1 | null): void;
  /** Latest held receive-time anchor, for UI diagnostics. */
  getHeld(): HeldSparseAnchor | null;
}

/**
 * Content publishes sparse anchors at ~4 Hz. Karaoke paints every rAF from this
 * clock. Hard-snapping every tick causes sawtooth ("seek every few hundred ms").
 * Ignoring heartbeats entirely lets IPC lag accumulate so line fade/fill runs
 * late vs audio (previous line stays bright, next line is up but still dim).
 *
 * Policy:
 * - Coast locally between anchors (no hard snaps)
 * - On first bind / seek: compensate wall-clock transport lag
 * - On playing heartbeats: micro-slew toward lag-compensated content time
 *   (≤18ms/step) so phase stays aligned without visible jumps
 * - Discontinuity is one-shot (cleared after first getSnapshot)
 */
const HARD_SEEK_BACKWARD_MS = 1_500;
const HARD_SEEK_FORWARD_MS = 2_500;
/**
 * Max one-way lag we apply on hard accept (ms).
 * Keep this modest: over-compensating makes the lyric clock run ahead of
 * audio, so pre-anchor / line handoff feel early ("previous line not done").
 */
const MAX_TRANSPORT_LAG_MS = 220;
/** Per-heartbeat position correction cap — below perceptual karaoke jitter. */
const MICRO_SLEW_MAX_MS = 12;
/** Ignore residual under this (clock noise). */
const MICRO_SLEW_DEADBAND_MS = 16;
/** Date.now() is ~1.7e12; performance.now() is session-relative. */
const WALL_CLOCK_MS_MIN = 1e12;

function isWallClockMs(value: number): boolean {
  return Number.isFinite(value) && value >= WALL_CLOCK_MS_MIN;
}

function lagCompensatedPositionMs(
  anchor: SparsePlaybackAnchorV1,
  wallNowMs: number,
): number {
  const rate = Number.isFinite(anchor.rate) && anchor.rate > 0 ? anchor.rate : 1;
  if (!isWallClockMs(anchor.producedAtMs) || anchor.state !== 'playing') {
    return Math.max(0, anchor.positionMs);
  }
  const lagMs = Math.min(
    MAX_TRANSPORT_LAG_MS,
    Math.max(0, wallNowMs - anchor.producedAtMs),
  );
  return Math.max(0, anchor.positionMs + lagMs * rate);
}

/**
 * PlaybackClock driven only by sparse anchors from content.
 * Projection uses surface-local receive time (not content performance.now).
 */
export function createSparseAnchorClock(
  now: () => number = () => performance.now(),
  wallNow: () => number = () => Date.now(),
): SparseAnchorClock {
  let held: HeldSparseAnchor | null = null;
  let revision = 0;
  let discontinuity: PlaybackDiscontinuity | null = null;
  let discontinuitySequence = 0;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // surface listeners must not throw across the bus
      }
    }
  }

  return {
    applyAnchor(anchor: SparsePlaybackAnchorV1 | null): void {
      if (!anchor) {
        if (held === null) return;
        held = null;
        revision += 1;
        discontinuity = null;
        notify();
        return;
      }
      if (
        held
        && held.anchor.sessionId === anchor.sessionId
        && held.anchor.generation === anchor.generation
        && held.anchor.sequence === anchor.sequence
      ) {
        return;
      }

      const receivedAtMs = now();
      const wallNowMs = wallNow();
      const contentMs = lagCompensatedPositionMs(anchor, wallNowMs);
      const previous = held?.anchor ?? null;
      const sameSession = previous
        && previous.sessionId === anchor.sessionId
        && previous.generation === anchor.generation;

      if (sameSession && previous && held) {
        const projected = projectSparseAnchor(held, receivedAtMs);
        const projectedMs = projected?.positionMs ?? previous.positionMs;
        const deltaFromProjected = contentMs - projectedMs;
        const bothPlaying = previous.state === 'playing' && anchor.state === 'playing';
        const stateChanged = previous.state !== anchor.state;
        const rateChanged = Math.abs(previous.rate - anchor.rate) > 0.02;
        const mediaChanged = previous.mediaId !== anchor.mediaId;
        const hardSeek = deltaFromProjected < -HARD_SEEK_BACKWARD_MS
          || deltaFromProjected > HARD_SEEK_FORWARD_MS;

        // Media change always hard-accepts content time (never carry coast from
        // the previous track — that left next-song lyrics ~1s early).
        if (mediaChanged) {
          discontinuitySequence += 1;
          discontinuity = {
            sequence: discontinuitySequence,
            reason: 'source-change',
          };
          held = {
            anchor: { ...anchor, positionMs: contentMs },
            receivedAtMs,
          };
          revision += 1;
          notify();
          return;
        }

        if (hardSeek) {
          discontinuitySequence += 1;
          discontinuity = {
            sequence: discontinuitySequence,
            reason: 'seek',
          };
          held = {
            anchor: { ...anchor, positionMs: contentMs },
            receivedAtMs,
          };
          revision += 1;
          notify();
          return;
        }

        if (bothPlaying && !stateChanged && !rateChanged) {
          // Micro-slew phase toward content without a visible jump.
          const error = contentMs - projectedMs;
          let nextPositionMs = projectedMs;
          if (Math.abs(error) > MICRO_SLEW_DEADBAND_MS) {
            const step = Math.max(
              -MICRO_SLEW_MAX_MS,
              Math.min(MICRO_SLEW_MAX_MS, error),
            );
            nextPositionMs = Math.max(0, projectedMs + step);
          }
          // Re-base timebase at the continuous (slew-corrected) phase so rAF
          // coast stays smooth. Sequence only advances for ordering.
          held = {
            anchor: {
              ...held.anchor,
              sequence: anchor.sequence,
              producedAtMs: anchor.producedAtMs,
              mediaId: anchor.mediaId,
              rate: anchor.rate,
              positionMs: nextPositionMs,
              state: anchor.state,
            },
            receivedAtMs,
          };
          // No notify — frame scheduler rAF already samples continuously.
          return;
        }

        // Pause/play/rate: re-base at continuous phase so coast stays smooth.
        const baseMs = bothPlaying || anchor.state === 'playing'
          ? Math.max(0, projectedMs)
          : contentMs;
        held = {
          anchor: { ...anchor, positionMs: baseMs },
          receivedAtMs,
        };
        discontinuity = null;
        revision += 1;
        notify();
        return;
      }

      if (previous && previous.sessionId !== anchor.sessionId) {
        discontinuitySequence += 1;
        discontinuity = {
          sequence: discontinuitySequence,
          reason: 'source-change',
        };
      } else {
        discontinuity = null;
      }

      // First anchor / generation change: accept lag-compensated position.
      held = {
        anchor: { ...anchor, positionMs: contentMs },
        receivedAtMs,
      };
      revision += 1;
      notify();
    },

    getHeld(): HeldSparseAnchor | null {
      return held;
    },

    getSnapshot(): PlaybackSnapshot {
      const projected = projectSparseAnchor(held, now());
      if (!projected || !held) {
        return {
          positionMs: 0,
          playing: false,
          rate: 1,
          seeking: false,
          revision,
          discontinuity: null,
        };
      }
      const once = discontinuity;
      discontinuity = null;
      return {
        positionMs: projected.positionMs,
        playing: projected.state === 'playing',
        rate: held.anchor.rate,
        seeking: projected.state === 'buffering',
        revision,
        discontinuity: once,
      };
    },

    subscribe(onInvalidate: () => void): Unsubscribe {
      listeners.add(onInvalidate);
      return () => {
        listeners.delete(onInvalidate);
      };
    },
  };
}
