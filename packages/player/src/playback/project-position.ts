import type {
  PlaybackPositionAnchor,
  ProjectedPlaybackPosition,
} from "./types.js";

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizedDuration(durationMs: number | null): number | null {
  if (durationMs === null) return null;
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}

function euclideanModulo(value: number, divisor: number): number {
  const remainder = value % divisor;
  return remainder < 0 ? remainder + divisor : remainder;
}

/**
 * Projects an observed playback position without reading ambient time.
 * Callers own the monotonic `nowMs` source and all discontinuity handling.
 */
export function projectPosition(
  anchor: PlaybackPositionAnchor,
  nowMs: number,
): ProjectedPlaybackPosition {
  const positionMs = finiteNonNegative(anchor.positionMs, 0);
  const observedAtMs = finiteNonNegative(anchor.observedAtMs, 0);
  const currentTimeMs = finiteNonNegative(nowMs, observedAtMs);
  const rate = finiteNonNegative(anchor.rate, 0);
  const durationMs = normalizedDuration(anchor.durationMs);
  const elapsedMs = Math.max(0, currentTimeMs - observedAtMs);
  const shouldProject = anchor.playing && !anchor.seeking;
  if (!shouldProject) {
    const clampedPositionMs =
      durationMs === null ? positionMs : Math.min(positionMs, durationMs);
    return {
      positionMs: clampedPositionMs,
      ended:
        !anchor.loop &&
        durationMs !== null &&
        positionMs >= durationMs,
      loopCount: 0,
    };
  }

  const deltaMs = elapsedMs * rate;
  const rawPositionMs = Number.isFinite(deltaMs)
    ? positionMs + deltaMs
    : Number.POSITIVE_INFINITY;

  if (durationMs === null) {
    return {
      positionMs: Number.isFinite(rawPositionMs)
        ? Math.max(0, rawPositionMs)
        : positionMs,
      ended: false,
      loopCount: 0,
    };
  }

  if (anchor.loop) {
    if (durationMs === 0) {
      return { positionMs: 0, ended: false, loopCount: 0 };
    }

    if (!Number.isFinite(rawPositionMs)) {
      return {
        positionMs: euclideanModulo(positionMs, durationMs),
        ended: false,
        loopCount: Number.MAX_SAFE_INTEGER,
      };
    }

    const loopCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(0, Math.floor(rawPositionMs / durationMs)),
    );
    return {
      // Using modulo intentionally maps an exact duration boundary to zero.
      positionMs: euclideanModulo(rawPositionMs, durationMs),
      ended: false,
      loopCount,
    };
  }

  if (durationMs === 0) {
    return { positionMs: 0, ended: true, loopCount: 0 };
  }

  return {
    positionMs: Math.min(rawPositionMs, durationMs),
    ended: rawPositionMs >= durationMs,
    loopCount: 0,
  };
}
