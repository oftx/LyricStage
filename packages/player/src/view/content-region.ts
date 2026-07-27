export interface LyricsContentRegion {
  readonly left: number;
  readonly right: number;
}

export type LyricsContentRegionHandle = "left" | "right";

export const DEFAULT_LYRICS_CONTENT_REGION: LyricsContentRegion = Object.freeze({
  left: 0,
  right: 1,
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedMinimumSpan(minSpanRatio: number): number {
  return Number.isFinite(minSpanRatio) ? clamp(minSpanRatio, 0, 1) : 0;
}

function finiteRatio(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, 0, 1)
    : fallback;
}

function freezeRegion(left: number, right: number): LyricsContentRegion {
  return Object.freeze({ left, right });
}

function regionValues(value: unknown): {
  readonly left: unknown;
  readonly right: unknown;
} {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_LYRICS_CONTENT_REGION;
  }
  const candidate = value as Partial<Record<keyof LyricsContentRegion, unknown>>;
  return { left: candidate.left, right: candidate.right };
}

export function isLyricsContentRegion(
  value: unknown,
): value is LyricsContentRegion {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LyricsContentRegion>;
  return (
    typeof candidate.left === "number" &&
    Number.isFinite(candidate.left) &&
    candidate.left >= 0 &&
    candidate.left <= 1 &&
    typeof candidate.right === "number" &&
    Number.isFinite(candidate.right) &&
    candidate.right >= 0 &&
    candidate.right <= 1 &&
    candidate.left <= candidate.right
  );
}

/** Normalizes physical boundaries while preserving their midpoint when possible. */
export function normalizeLyricsContentRegion(
  value: unknown,
  minSpanRatio = 0,
): LyricsContentRegion {
  const values = regionValues(value);
  const first = finiteRatio(values.left, DEFAULT_LYRICS_CONTENT_REGION.left);
  const second = finiteRatio(values.right, DEFAULT_LYRICS_CONTENT_REGION.right);
  let left = Math.min(first, second);
  let right = Math.max(first, second);
  const minimumSpan = normalizedMinimumSpan(minSpanRatio);
  if (right - left >= minimumSpan) return freezeRegion(left, right);

  const midpoint = (left + right) / 2;
  left = midpoint - minimumSpan / 2;
  right = midpoint + minimumSpan / 2;
  if (left < 0) {
    right -= left;
    left = 0;
  }
  if (right > 1) {
    left -= right - 1;
    right = 1;
  }
  return freezeRegion(clamp(left, 0, 1), clamp(right, 0, 1));
}

/** Moves one handle and mirrors the other around the baseline midpoint. */
export function moveLinkedLyricsContentRegionHandle(
  region: LyricsContentRegion,
  handle: LyricsContentRegionHandle,
  positionRatio: number,
  minSpanRatio = 0,
): LyricsContentRegion {
  const baseline = normalizeLyricsContentRegion(region, minSpanRatio);
  const midpoint = (baseline.left + baseline.right) / 2;
  const minimumHalfSpan = normalizedMinimumSpan(minSpanRatio) / 2;
  const maximumHalfSpan = Math.min(midpoint, 1 - midpoint);
  const position = finiteRatio(positionRatio, baseline[handle]);
  const requestedHalfSpan =
    handle === "left" ? midpoint - position : position - midpoint;
  const halfSpan = clamp(
    requestedHalfSpan,
    Math.min(minimumHalfSpan, maximumHalfSpan),
    maximumHalfSpan,
  );
  return freezeRegion(midpoint - halfSpan, midpoint + halfSpan);
}

/** Moves one physical handle while keeping the opposite handle fixed. */
export function moveIndependentLyricsContentRegionHandle(
  region: LyricsContentRegion,
  handle: LyricsContentRegionHandle,
  positionRatio: number,
  minSpanRatio = 0,
): LyricsContentRegion {
  const baseline = normalizeLyricsContentRegion(region, minSpanRatio);
  const minimumSpan = normalizedMinimumSpan(minSpanRatio);
  const position = finiteRatio(positionRatio, baseline[handle]);
  if (handle === "left") {
    return freezeRegion(
      clamp(position, 0, baseline.right - minimumSpan),
      baseline.right,
    );
  }
  return freezeRegion(
    baseline.left,
    clamp(position, baseline.left + minimumSpan, 1),
  );
}

/** Translates the complete span without changing its normalized width. */
export function translateLyricsContentRegion(
  region: LyricsContentRegion,
  deltaRatio: number,
  minSpanRatio = 0,
): LyricsContentRegion {
  const baseline = normalizeLyricsContentRegion(region, minSpanRatio);
  const requestedDelta = Number.isFinite(deltaRatio) ? deltaRatio : 0;
  const delta = clamp(requestedDelta, -baseline.left, 1 - baseline.right);
  return freezeRegion(baseline.left + delta, baseline.right + delta);
}
