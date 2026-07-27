export type SyncedDisplayMode = "line" | "karaoke";

export interface DisplayModeTransitionState {
  readonly sourceMode: SyncedDisplayMode;
  readonly targetMode: SyncedDisplayMode;
  /** `0` is karaoke sweep; `1` is whole-line fill. */
  readonly lineMix: number;
  readonly fromMix: number;
  readonly toMix: number;
  readonly elapsedMs: number;
  readonly durationMs: number;
  readonly running: boolean;
  readonly runId: number;
}

export interface DisplayModeTransitionRequest {
  readonly animate: boolean;
  readonly durationMs?: number;
}

export const DISPLAY_MODE_MORPH_DURATION_MS = 360;

function modeMix(mode: SyncedDisplayMode): number {
  return mode === "line" ? 1 : 0;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function cubicCoordinate(
  t: number,
  firstControl: number,
  secondControl: number,
): number {
  const inverse = 1 - t;
  return (
    3 * inverse * inverse * t * firstControl +
    3 * inverse * t * t * secondControl +
    t * t * t
  );
}

/** Samples cubic-bezier(0.4, 0.1, 0, 1) by solving its x coordinate. */
function displayModeProgress(linearProgress: number): number {
  const x = clamp(linearProgress);
  if (x === 0 || x === 1) return x;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 14; iteration += 1) {
    const midpoint = (low + high) * 0.5;
    if (cubicCoordinate(midpoint, 0.4, 0) < x) low = midpoint;
    else high = midpoint;
  }
  return cubicCoordinate((low + high) * 0.5, 0.1, 1);
}

export function createDisplayModeTransitionState(
  mode: SyncedDisplayMode = "karaoke",
): DisplayModeTransitionState {
  const mix = modeMix(mode);
  return Object.freeze({
    sourceMode: mode,
    targetMode: mode,
    lineMix: mix,
    fromMix: mix,
    toMix: mix,
    elapsedMs: 0,
    durationMs: 0,
    running: false,
    runId: 0,
  });
}

export function requestDisplayModeTransition(
  state: DisplayModeTransitionState,
  targetMode: SyncedDisplayMode,
  request: DisplayModeTransitionRequest,
): DisplayModeTransitionState {
  const toMix = modeMix(targetMode);
  if (!request.animate || Math.abs(state.lineMix - toMix) < 0.0001) {
    return Object.freeze({
      sourceMode: targetMode,
      targetMode,
      lineMix: toMix,
      fromMix: toMix,
      toMix,
      elapsedMs: 0,
      durationMs: 0,
      running: false,
      runId: Math.min(Number.MAX_SAFE_INTEGER, state.runId + 1),
    });
  }
  const requestedDuration =
    request.durationMs !== undefined && Number.isFinite(request.durationMs)
      ? Math.max(0, request.durationMs)
      : DISPLAY_MODE_MORPH_DURATION_MS;
  const durationMs = requestedDuration * Math.abs(toMix - state.lineMix);
  if (durationMs <= 0) {
    return Object.freeze({
      sourceMode: targetMode,
      targetMode,
      lineMix: toMix,
      fromMix: toMix,
      toMix,
      elapsedMs: 0,
      durationMs: 0,
      running: false,
      runId: Math.min(Number.MAX_SAFE_INTEGER, state.runId + 1),
    });
  }
  return Object.freeze({
    sourceMode: state.targetMode,
    targetMode,
    lineMix: state.lineMix,
    fromMix: state.lineMix,
    toMix,
    elapsedMs: 0,
    durationMs,
    running: durationMs > 0,
    runId: Math.min(Number.MAX_SAFE_INTEGER, state.runId + 1),
  });
}

export function advanceDisplayModeTransition(
  state: DisplayModeTransitionState,
  deltaMs: number,
): DisplayModeTransitionState {
  if (!state.running) return state;
  const elapsedMs = Math.min(
    state.durationMs,
    state.elapsedMs + (Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0),
  );
  const linearProgress =
    state.durationMs <= 0 ? 1 : clamp(elapsedMs / state.durationMs);
  const progress = displayModeProgress(linearProgress);
  const lineMix = state.fromMix + (state.toMix - state.fromMix) * progress;
  const running = linearProgress < 1;
  return Object.freeze({
    ...state,
    sourceMode: running ? state.sourceMode : state.targetMode,
    lineMix: running ? lineMix : state.toMix,
    elapsedMs,
    running,
  });
}
