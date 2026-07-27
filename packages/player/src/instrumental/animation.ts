import {
  INSTRUMENTAL_EXIT_COLLAPSE_DURATION_MS,
  INSTRUMENTAL_EXIT_EXPAND_DURATION_MS,
  type InstrumentalSessionState,
} from "./session.js";
import {
  INSTRUMENTAL_END_BUFFER_MS,
  type InstrumentalTiming,
} from "./timing.js";

export const INSTRUMENTAL_DOT_COUNT = 3;
export const INSTRUMENTAL_DOT_ENTRANCE_DURATION_MS = 750;
export const INSTRUMENTAL_DOT_ENTRANCE_STAGGER_MS = 50;
export const INSTRUMENTAL_BREATHING_TARGET_SCALE = 1.2;
export const INSTRUMENTAL_BREATHING_BASE_CYCLE_MS = 4_000;
export const INSTRUMENTAL_EXIT_TARGET_SCALE = 0.5;
export const INSTRUMENTAL_DOT_FINAL_TINT_MS = 750;
/** @deprecated Native tint uses source-derived windows, not fixed segments. */
export const INSTRUMENTAL_PROGRESS_SEGMENT_COUNT = 4;
export const INSTRUMENTAL_DOT_SIZE_PX = 10;
export const INSTRUMENTAL_DOT_MARGIN_X_PX = 6;
// Web contains the 1000ms removal animation inside the raw gap, while native's
// tint tracker reserves 800ms. The 200ms phase bridge makes the main tint end
// exactly when the stored third-dot tail and exit-expand begin.
const INSTRUMENTAL_TRACKER_PHASE_LEAD_MS = Math.max(
  0,
  INSTRUMENTAL_EXIT_EXPAND_DURATION_MS +
    INSTRUMENTAL_EXIT_COLLAPSE_DURATION_MS -
    INSTRUMENTAL_END_BUFFER_MS,
);
/** Distance from three-dot geometric center to the outer content edge. */
export const INSTRUMENTAL_CHAIN_CENTER_TO_OUTER_EDGE_PX =
  INSTRUMENTAL_DOT_SIZE_PX +
  INSTRUMENTAL_DOT_MARGIN_X_PX +
  INSTRUMENTAL_DOT_SIZE_PX / 2;
/**
 * Rest layout inset so pure center-scale peak leaves the outer edge flush with
 * the lyric content edge: firstLeft(peak) = contentEdge.
 */
export const INSTRUMENTAL_REST_OUTER_INSET_PX =
  INSTRUMENTAL_CHAIN_CENTER_TO_OUTER_EDGE_PX *
  Math.max(0, INSTRUMENTAL_BREATHING_TARGET_SCALE - 1);

/**
 * Compact copy of the accepted legacy MOTION.breathingLut. Used only to shape
 * the 1→1.2→1 instrumental breathing wave.
 */
const BREATHING_LUT = Object.freeze([
  0, 0.0005, 0.002, 0.004, 0.007, 0.01, 0.0138, 0.02, 0.026, 0.032, 0.039,
  0.048, 0.058, 0.071, 0.086, 0.102, 0.119, 0.135, 0.153, 0.172, 0.194, 0.215,
  0.234, 0.257, 0.279, 0.299, 0.32, 0.34, 0.358, 0.373, 0.389, 0.404, 0.418,
  0.43, 0.44, 0.45, 0.458, 0.466, 0.473, 0.479, 0.483, 0.4875, 0.491, 0.494,
  0.496, 0.498, 0.499, 0.4995, 0.5, 0.5005, 0.502, 0.504, 0.507, 0.51, 0.5138,
  0.52, 0.526, 0.532, 0.539, 0.548, 0.558, 0.571, 0.586, 0.602, 0.619, 0.635,
  0.653, 0.672, 0.694, 0.715, 0.734, 0.757, 0.779, 0.799, 0.82, 0.84, 0.858,
  0.873, 0.889, 0.904, 0.918, 0.93, 0.94, 0.95, 0.958, 0.966, 0.973, 0.979,
  0.983, 0.9875, 0.991, 0.994, 0.996, 0.998, 0.999, 0.9995, 1,
]);

export type InstrumentalAnimationPhase =
  | "hidden"
  | "entering"
  | "breathing"
  | "exit-expand"
  | "exit-collapse"
  | "paused-folded"
  | "paused-frozen";

export interface InstrumentalAnimationOptions {
  readonly reducedMotion?: boolean;
}

export interface InstrumentalAnimationState {
  readonly lineId: string | null;
  readonly phase: InstrumentalAnimationPhase;
  readonly visible: boolean;
  readonly animationRunning: boolean;
  readonly rootScale: number;
  readonly rootAlpha: number;
  readonly dotOpacity: readonly [number, number, number];
  /** Whole-dot tint interpolation in reading order, not a geometric mask. */
  readonly dotTintProgress: readonly [number, number, number];
  readonly breathingCycleMs: number | null;
  readonly breathingProgress: number;
  readonly exitProgress: number;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * clampUnit(progress);
}

function cubicCoordinate(
  progress: number,
  firstControl: number,
  secondControl: number,
): number {
  const inverse = 1 - progress;
  return (
    3 * inverse * inverse * progress * firstControl +
    3 * inverse * progress * progress * secondControl +
    progress * progress * progress
  );
}

function cubicBezierProgress(
  linearProgress: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const x = clampUnit(linearProgress);
  if (x === 0 || x === 1) return x;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 14; iteration += 1) {
    const midpoint = (low + high) * 0.5;
    if (cubicCoordinate(midpoint, x1, x2) < x) low = midpoint;
    else high = midpoint;
  }
  return cubicCoordinate((low + high) * 0.5, y1, y2);
}

function frozenTriple(
  values: readonly [number, number, number],
): readonly [number, number, number] {
  return Object.freeze([...values]) as unknown as readonly [
    number,
    number,
    number,
  ];
}

function hiddenState(): InstrumentalAnimationState {
  return Object.freeze({
    lineId: null,
    phase: "hidden",
    visible: false,
    animationRunning: false,
    rootScale: 1,
    rootAlpha: 0,
    dotOpacity: frozenTriple([0, 0, 0]),
    dotTintProgress: frozenTriple([0, 0, 0]),
    breathingCycleMs: null,
    breathingProgress: 0,
    exitProgress: 0,
  });
}

function resolveEntryOffsetMs(
  session: InstrumentalSessionState,
  timing: InstrumentalTiming,
): number {
  const remainingAtEntryMs = Number.isFinite(session.remainingAtEntryMs)
    ? Math.max(0, Math.min(timing.durationMs, session.remainingAtEntryMs))
    : timing.durationMs;
  return Math.max(0, timing.durationMs - remainingAtEntryMs);
}

function resolveBreathingRunDurationMs(
  session: InstrumentalSessionState,
  timing: InstrumentalTiming,
): number {
  return Math.max(
    0,
    timing.internalDurationMs -
      (resolveEntryOffsetMs(session, timing) +
        INSTRUMENTAL_TRACKER_PHASE_LEAD_MS),
  );
}

/** Native starts only complete breaths, then stretches them to fill the run. */
function resolveBreathingCycleMs(runDurationMs: number): number | null {
  if (!Number.isFinite(runDurationMs) || runDurationMs <= 0) {
    return null;
  }
  const cycleCount = Math.floor(
    runDurationMs / INSTRUMENTAL_BREATHING_BASE_CYCLE_MS,
  );
  return cycleCount > 0 ? runDurationMs / cycleCount : null;
}

function breathingEase(local: number): number {
  const t = clampUnit(local);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const step = 1 / (BREATHING_LUT.length - 1);
  const index = Math.min(
    Math.floor(t * (BREATHING_LUT.length - 1)),
    BREATHING_LUT.length - 2,
  );
  const localStep = (t - index * step) / step;
  const left = BREATHING_LUT[index] ?? 0;
  const right = BREATHING_LUT[index + 1] ?? 1;
  return left + (right - left) * localStep;
}

/**
 * Absolute 1 -> 1.2 -> 1 wave driven by the holder-like run clock. Native
 * pauses this clock with playback and rebuilds complete cycles after rebind.
 */
function breathingSample(
  runElapsedMs: number,
  runDurationMs: number,
  cycleMs: number | null,
  fallbackScale = 1,
): { readonly progress: number; readonly scale: number } {
  if (
    cycleMs === null ||
    cycleMs <= 0 ||
    runDurationMs <= 0 ||
    !Number.isFinite(runElapsedMs)
  ) {
    return {
      progress: 0,
      scale:
        Number.isFinite(fallbackScale) && fallbackScale > 0 ? fallbackScale : 1,
    };
  }
  const elapsedMs = Math.max(0, Math.min(runDurationMs, runElapsedMs));
  if (elapsedMs >= runDurationMs) {
    return { progress: 1, scale: 1 };
  }
  const progress = ((elapsedMs % cycleMs) + cycleMs) % cycleMs;
  const normalized = progress / cycleMs;
  const eased = breathingEase(normalized);
  const scale =
    eased <= 0.5
      ? lerp(1, INSTRUMENTAL_BREATHING_TARGET_SCALE, eased / 0.5)
      : lerp(INSTRUMENTAL_BREATHING_TARGET_SCALE, 1, (eased - 0.5) / 0.5);
  return { progress: normalized, scale };
}

function sampleDotOpacity(
  runElapsedMs: number,
): readonly [number, number, number] {
  const accelerate = (elapsedMs: number): number => {
    const progress = clampUnit(
      elapsedMs / INSTRUMENTAL_DOT_ENTRANCE_DURATION_MS,
    );
    return progress * progress;
  };
  return frozenTriple([
    accelerate(runElapsedMs),
    accelerate(runElapsedMs - INSTRUMENTAL_DOT_ENTRANCE_STAGGER_MS),
    accelerate(runElapsedMs - INSTRUMENTAL_DOT_ENTRANCE_STAGGER_MS * 2),
  ]);
}

function resolveDotTintWindowMs(runDurationMs: number): number {
  return Math.max(
    1,
    Math.round((runDurationMs + INSTRUMENTAL_DOT_FINAL_TINT_MS) / 3),
  );
}

function resolveTintClock(
  session: InstrumentalSessionState,
  timing: InstrumentalTiming,
): { readonly elapsedMs: number; readonly durationMs: number } {
  const durationMs = timing.internalDurationMs;
  const elapsedMs =
    session.presence === "exiting"
      ? durationMs
      : resolveEntryOffsetMs(session, timing) +
        session.runElapsedMs +
        INSTRUMENTAL_TRACKER_PHASE_LEAD_MS;
  return {
    elapsedMs: Math.max(0, Math.min(durationMs, elapsedMs)),
    durationMs,
  };
}

/**
 * Native S0.Y uses three main windows. The shortened third window reaches a
 * partial target; S0.R finishes it linearly while exit-expand runs in parallel.
 */
function sampleActiveTint(
  session: InstrumentalSessionState,
  timing: InstrumentalTiming,
): readonly [number, number, number] {
  const tintClock = resolveTintClock(session, timing);
  if (tintClock.durationMs <= 0) return frozenTriple([0, 0, 0]);

  const windowMs = resolveDotTintWindowMs(tintClock.durationMs);
  const progress: [number, number, number] = [0, 0, 0];
  let thirdMainTarget = 0;

  for (let index = 0; index < INSTRUMENTAL_DOT_COUNT; index += 1) {
    const startMs = windowMs * index;
    const durationMs =
      index === INSTRUMENTAL_DOT_COUNT - 1
        ? Math.max(1, tintClock.durationMs - windowMs * 2)
        : windowMs;
    const target = clampUnit(durationMs / windowMs);
    if (index === INSTRUMENTAL_DOT_COUNT - 1) thirdMainTarget = target;

    const localProgress = (tintClock.elapsedMs - startMs) / durationMs;
    progress[index] =
      tintClock.elapsedMs <= startMs
        ? 0
        : tintClock.elapsedMs >= startMs + durationMs
          ? target
          : cubicBezierProgress(localProgress, 0, 0.25, 1, 0.58) * target;
  }

  if (session.presence === "exiting") {
    progress[2] = lerp(
      thirdMainTarget,
      1,
      session.exitElapsedMs / INSTRUMENTAL_DOT_FINAL_TINT_MS,
    );
  }

  return frozenTriple(progress);
}

/**
 * Samples instrumental-only visuals. It intentionally has no dependency on
 * karaoke sweep, lift, line movement, DOM geometry, or ambient time.
 */
export function sampleInstrumentalAnimation(
  session: InstrumentalSessionState,
  timing: InstrumentalTiming | null,
  options: InstrumentalAnimationOptions = {},
): InstrumentalAnimationState {
  if (
    session.presence === "absent" ||
    session.lineId === null ||
    timing === null ||
    timing.lineId !== session.lineId
  ) {
    return hiddenState();
  }

  const reducedMotion = options.reducedMotion === true;
  const paused = session.playbackState === "paused";
  const breathingRunDurationMs = resolveBreathingRunDurationMs(session, timing);
  const breathingCycleMs = resolveBreathingCycleMs(breathingRunDurationMs);
  // Session run time stops advancing once removal starts, matching R(holder)'s
  // capture of the live scale before the 750ms expand.
  const breathing = breathingSample(
    session.runElapsedMs,
    breathingRunDurationMs,
    breathingCycleMs,
    1,
  );
  const activeTint = sampleActiveTint(session, timing);
  const dotOpacity = reducedMotion
    ? frozenTriple([1, 1, 1])
    : sampleDotOpacity(session.runElapsedMs);

  if (session.presence === "present") {
    const entranceComplete = dotOpacity.every((opacity) => opacity >= 1);
    const phase: InstrumentalAnimationPhase = paused
      ? session.runElapsedMs <= 0
        ? "paused-folded"
        : "paused-frozen"
      : entranceComplete
        ? "breathing"
        : "entering";
    return Object.freeze({
      lineId: session.lineId,
      phase,
      visible: true,
      animationRunning: !paused && !reducedMotion,
      rootScale: reducedMotion ? 1 : breathing.scale,
      rootAlpha: 1,
      dotOpacity:
        paused && session.runElapsedMs <= 0
          ? frozenTriple([0, 0, 0])
          : dotOpacity,
      dotTintProgress: activeTint,
      breathingCycleMs,
      breathingProgress: breathing.progress,
      exitProgress: 0,
    });
  }

  if (reducedMotion) {
    return Object.freeze({
      lineId: session.lineId,
      phase: "exit-collapse",
      visible: false,
      animationRunning: false,
      rootScale: 1,
      rootAlpha: 0,
      dotOpacity: frozenTriple([1, 1, 1]),
      dotTintProgress: frozenTriple([1, 1, 1]),
      breathingCycleMs,
      breathingProgress: breathing.progress,
      exitProgress: 1,
    });
  }

  const exitElapsedMs = Math.max(0, session.exitElapsedMs);
  if (exitElapsedMs < INSTRUMENTAL_EXIT_EXPAND_DURATION_MS) {
    const progress = clampUnit(
      exitElapsedMs / INSTRUMENTAL_EXIT_EXPAND_DURATION_MS,
    );
    const eased = cubicBezierProgress(progress, 0.25, 0.1, 0.25, 1);
    return Object.freeze({
      lineId: session.lineId,
      phase: "exit-expand",
      visible: true,
      animationRunning: !paused,
      rootScale: lerp(
        breathing.scale,
        INSTRUMENTAL_BREATHING_TARGET_SCALE,
        eased,
      ),
      rootAlpha: 1,
      dotOpacity: frozenTriple([1, 1, 1]),
      // The third dot's 750ms tail runs with exit-expand.
      dotTintProgress: activeTint,
      breathingCycleMs,
      breathingProgress: breathing.progress,
      exitProgress:
        exitElapsedMs /
        (INSTRUMENTAL_EXIT_EXPAND_DURATION_MS +
          INSTRUMENTAL_EXIT_COLLAPSE_DURATION_MS),
    });
  }

  const collapseProgress = clampUnit(
    (exitElapsedMs - INSTRUMENTAL_EXIT_EXPAND_DURATION_MS) /
      INSTRUMENTAL_EXIT_COLLAPSE_DURATION_MS,
  );
  const eased = cubicBezierProgress(collapseProgress, 0.25, 0, 1, 0.2);
  return Object.freeze({
    lineId: session.lineId,
    phase: "exit-collapse",
    visible: collapseProgress < 1,
    animationRunning: !paused && collapseProgress < 1,
    rootScale: lerp(
      INSTRUMENTAL_BREATHING_TARGET_SCALE,
      INSTRUMENTAL_EXIT_TARGET_SCALE,
      eased,
    ),
    rootAlpha: 1 - eased,
    dotOpacity: frozenTriple([1, 1, 1]),
    dotTintProgress: frozenTriple([1, 1, 1]),
    breathingCycleMs,
    breathingProgress: breathing.progress,
    exitProgress: clampUnit(
      exitElapsedMs /
        (INSTRUMENTAL_EXIT_EXPAND_DURATION_MS +
          INSTRUMENTAL_EXIT_COLLAPSE_DURATION_MS),
    ),
  });
}
