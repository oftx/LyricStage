import type { SparsePlaybackAnchorV1 } from '@lyric-stage/extension-protocol';

export type HeldSparseAnchor = {
  readonly anchor: SparsePlaybackAnchorV1;
  /** Surface-local performance.now() when the anchor was received. */
  readonly receivedAtMs: number;
};

export type ProjectedSparseAnchor = {
  readonly positionMs: number;
  readonly ageMs: number;
  readonly state: SparsePlaybackAnchorV1['state'];
};

/**
 * Project sparse anchors locally. Content owns live time; this surface only
 * coasts from the last accepted anchor using receive-time stamping (content
 * performance.now is not comparable across processes).
 *
 * 'playing' extrapolation is clamped at the anchor's durationMs when known —
 * producers whose clocks pin at the track end (QQ platform-api) must not make
 * the surface coast past the song forever. Reaching the bound projects as
 * 'ended'.
 */
export function projectSparseAnchor(
  heldAnchor: HeldSparseAnchor | null,
  nowMs: number,
): ProjectedSparseAnchor | null {
  if (!heldAnchor) return null;
  const { anchor, receivedAtMs } = heldAnchor;
  const ageMs = Math.max(0, nowMs - receivedAtMs);
  const durationMs = typeof anchor.durationMs === 'number'
    && Number.isFinite(anchor.durationMs)
    && anchor.durationMs > 0
    ? anchor.durationMs
    : null;
  if (anchor.state !== 'playing') {
    const held = durationMs !== null
      ? Math.min(anchor.positionMs, durationMs)
      : anchor.positionMs;
    return { positionMs: held, ageMs, state: anchor.state };
  }
  const rate = Number.isFinite(anchor.rate) ? anchor.rate : 1;
  const projected = Math.max(0, anchor.positionMs + ageMs * rate);
  if (durationMs !== null && projected >= durationMs) {
    return { positionMs: durationMs, ageMs, state: 'ended' };
  }
  return {
    positionMs: projected,
    ageMs,
    state: anchor.state,
  };
}
