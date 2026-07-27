/** Accepted Web click-seek scroll window (legacy MOTION.clickSeekScrollDurationMs). */
export const CLICK_SEEK_SCROLL_DURATION_MS = 650;

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function cubicBezierY(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x: number,
): number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let low = 0;
  let high = 1;
  let t = clampUnit(x);
  // Match the frozen Web oracle's bounded bisection. The x component is
  // inverted first; the resulting parameter is then evaluated on y.
  for (let index = 0; index < 12; index += 1) {
    const estimate = ((ax * t + bx) * t + cx) * t;
    if (estimate < x) low = t;
    else high = t;
    t = (low + high) / 2;
  }
  return ((ay * t + by) * t + cy) * t;
}

/**
 * Accepted lyric move curve from the frozen legacy implementation.
 */
export function clickSeekScrollEase(progress: number): number {
  return cubicBezierY(0.4, 0.1, 0, 1, clampUnit(progress));
}

export interface SmoothScrollTickInput {
  readonly startTop: number;
  readonly targetTop: number;
  readonly progress: number;
}

export function sampleSmoothScrollTop(input: SmoothScrollTickInput): number {
  const eased = clickSeekScrollEase(input.progress);
  return input.startTop + (input.targetTop - input.startTop) * eased;
}
