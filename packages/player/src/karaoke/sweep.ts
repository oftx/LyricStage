import type { KaraokeBindingMaskGeometry } from "./mask-layout.js";

export const DEFAULT_SWEEP_FEATHER_PX = 30;
export const DEFAULT_SWEEP_MAX_FEATHER_RATIO = 0.26;
export const HAN_KANA_SWEEP_MAX_FEATHER_GLYPH_RATIO = 0.5;
export const HAN_KANA_SWEEP_MAX_VISUAL_DURATION_MS = 2_000;
export const HAN_KANA_TERMINAL_CONTINUATION_MS = 500;

export type KaraokeSweepDirection = "forward" | "reverse";
export type KaraokeSweepLane = "top" | "bottom";
export type KaraokeSweepCharacterClass = "han-kana" | "other";
export type KaraokeSweepPhase =
  | "empty"
  | "future"
  | "active"
  | "gap"
  | "sung";
export type KaraokeSweepStops = readonly [number, number, number, number];
export type KaraokeSweepMaskAlphas = readonly [number, number, number, number];
export type KaraokeSweepCursorBounds = readonly [number, number];
export type KaraokeSweepContinuationStatus =
  | "none"
  | "pending"
  | "active"
  | "settled";

export interface KaraokeSweepBindingInput
  extends Pick<
    KaraokeBindingMaskGeometry,
    "bindingId" | "offset" | "width"
  > {
  readonly beginMs: number;
  readonly endMs: number;
  readonly characterClass?: KaraokeSweepCharacterClass;
  /** Visible letter/number graphemes represented by this binding. */
  readonly graphemeCount?: number;
  /**
   * Extra feather travel, expressed as a fraction of the shared feather.
   * This is group-local so a short Latin word can finish its final glyph
   * without advancing the next word's mask.
   */
  readonly featherAdjustment?: number;
}

export interface KaraokeSweepVisualLineInput {
  readonly lineId: string;
  readonly width: number;
  readonly lane: KaraokeSweepLane;
  readonly bindings: readonly KaraokeSweepBindingInput[];
}

export interface CreateKaraokeSweepStateInput {
  readonly visualLine: KaraokeSweepVisualLineInput;
  readonly positionMs: number;
  readonly direction: KaraokeSweepDirection;
  readonly featherPx?: number;
  readonly featherReferenceWidth?: number;
  readonly maxFeatherRatio?: number;
}

export interface CreateKaraokeBindingCompletionSweepStateInput {
  readonly lineId: string;
  readonly lane: KaraokeSweepLane;
  readonly lineWidth: number;
  readonly binding: KaraokeSweepBindingInput;
  readonly positionMs: number;
  readonly direction: KaraokeSweepDirection;
  readonly featherPx: number;
  readonly maxVisualDurationMs?: number;
  readonly maxFeatherGlyphRatio?: number;
}

export interface KaraokeSweepContinuation {
  readonly eligible: boolean;
  readonly status: KaraokeSweepContinuationStatus;
  readonly durationMs: number;
  readonly progress: number;
  readonly fromCursor: number;
  readonly targetCursor: number;
}

export interface KaraokeSweepState {
  readonly lineId: string;
  readonly lane: KaraokeSweepLane;
  readonly direction: KaraokeSweepDirection;
  readonly phase: KaraokeSweepPhase;
  readonly bindingId: string | null;
  /** Binding-local authored timing progress. */
  readonly progress: number;
  /** Shared physical cursor in layout pixels. Continuation may use its feather envelope. */
  readonly cursor: number;
  readonly cursorRatio: number;
  readonly cursorBounds: KaraokeSweepCursorBounds;
  readonly featherPx: number;
  readonly featherRatio: number;
  readonly stops: KaraokeSweepStops;
  readonly maskAlphas: KaraokeSweepMaskAlphas;
  readonly continuation: KaraokeSweepContinuation;
}

interface ValidSweepBinding {
  readonly bindingId: string;
  readonly offset: number;
  readonly width: number;
  readonly beginMs: number;
  readonly endMs: number;
  readonly characterClass: KaraokeSweepCharacterClass;
  readonly graphemeCount: number | null;
  readonly featherAdjustment: number;
}

interface NormalizedBindingsCacheEntry {
  readonly lineWidth: number;
  readonly bindings: readonly ValidSweepBinding[];
}

const transparentMask = Object.freeze([
  0, 0, 0, 0,
]) as KaraokeSweepMaskAlphas;
const solidMask = Object.freeze([1, 1, 1, 1]) as KaraokeSweepMaskAlphas;
const forwardMask = Object.freeze([1, 1, 0, 0]) as KaraokeSweepMaskAlphas;
const reverseMask = Object.freeze([0, 0, 1, 1]) as KaraokeSweepMaskAlphas;
const staticStops = Object.freeze([0, 0, 1, 1]) as KaraokeSweepStops;
const normalizedBindingsCache = new WeakMap<
  readonly KaraokeSweepBindingInput[],
  NormalizedBindingsCacheEntry
>();

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function tuple4(
  first: number,
  second: number,
  third: number,
  fourth: number,
): KaraokeSweepStops {
  return Object.freeze([first, second, third, fourth]);
}

function normalizeBinding(
  binding: KaraokeSweepBindingInput,
  lineWidth: number,
): ValidSweepBinding | null {
  if (
    typeof binding.bindingId !== "string" ||
    !Number.isFinite(binding.offset) ||
    !Number.isFinite(binding.width) ||
    binding.width <= 0 ||
    !Number.isFinite(binding.beginMs) ||
    !Number.isFinite(binding.endMs) ||
    binding.endMs <= binding.beginMs
  ) {
    return null;
  }
  const rawEnd = binding.offset + binding.width;
  if (!Number.isFinite(rawEnd)) return null;
  const offset = clamp(binding.offset, 0, lineWidth);
  const end = clamp(rawEnd, 0, lineWidth);
  if (end <= offset) return null;
  return Object.freeze({
    bindingId: binding.bindingId,
    offset,
    width: end - offset,
    beginMs: binding.beginMs,
    endMs: binding.endMs,
    characterClass:
      binding.characterClass === "han-kana" ? "han-kana" : "other",
    graphemeCount:
      typeof binding.graphemeCount === "number" &&
      Number.isFinite(binding.graphemeCount) &&
      binding.graphemeCount > 0
        ? Math.max(1, Math.floor(binding.graphemeCount))
        : null,
    featherAdjustment: clamp(binding.featherAdjustment ?? 0.25, 0, 1),
  });
}

function normalizeBindings(
  bindings: readonly KaraokeSweepBindingInput[],
  lineWidth: number,
): readonly ValidSweepBinding[] {
  const cached = normalizedBindingsCache.get(bindings);
  if (cached?.lineWidth === lineWidth) return cached.bindings;

  const cacheable =
    cached !== undefined ||
    (Object.isFrozen(bindings) && bindings.every(Object.isFrozen));

  const valid: ValidSweepBinding[] = [];
  for (const binding of bindings) {
    const normalized = normalizeBinding(binding, lineWidth);
    if (normalized) valid.push(normalized);
  }
  const normalized = Object.freeze(valid);
  if (cacheable) {
    normalizedBindingsCache.set(
      bindings,
      Object.freeze({ lineWidth, bindings: normalized }),
    );
  }
  return normalized;
}

function startCursor(
  binding: ValidSweepBinding,
  direction: KaraokeSweepDirection,
): number {
  return direction === "forward"
    ? binding.offset
    : binding.offset + binding.width;
}

function endCursor(
  binding: ValidSweepBinding,
  direction: KaraokeSweepDirection,
): number {
  return direction === "forward"
    ? binding.offset + binding.width
    : binding.offset;
}

function advanceCursor(
  cursor: number,
  direction: KaraokeSweepDirection,
  distance: number,
): number {
  return direction === "forward" ? cursor + distance : cursor - distance;
}

function bindingPaintEndCursor(
  binding: ValidSweepBinding,
  direction: KaraokeSweepDirection,
  featherPx: number,
  terminal: boolean,
): number {
  const authoredEnd = endCursor(binding, direction);
  if (binding.characterClass === "han-kana") {
    return authoredEnd;
  }
  const adjustment = terminal ? 1 : binding.featherAdjustment;
  const overshoot = featherPx * adjustment;
  return direction === "forward"
    ? authoredEnd + overshoot
    : authoredEnd - overshoot;
}

function mergeCursor(
  current: number,
  candidate: number,
  direction: KaraokeSweepDirection,
): number {
  return direction === "forward"
    ? Math.max(current, candidate)
    : Math.min(current, candidate);
}

function continuationState(
  eligible: boolean,
  status: KaraokeSweepContinuationStatus,
  progress: number,
  fromCursor: number,
  targetCursor: number,
): KaraokeSweepContinuation {
  return Object.freeze({
    eligible,
    status: eligible ? status : "none",
    durationMs: eligible ? HAN_KANA_TERMINAL_CONTINUATION_MS : 0,
    progress: eligible ? clamp(progress, 0, 1) : 0,
    fromCursor,
    targetCursor,
  });
}

function cursorFeatherStops(
  cursorRatio: number,
  featherRatio: number,
  direction: KaraokeSweepDirection,
): KaraokeSweepStops {
  if (direction === "forward") {
    return tuple4(
      0,
      clamp(cursorRatio - featherRatio, 0, 1),
      clamp(cursorRatio, 0, 1),
      1,
    );
  }
  return tuple4(
    0,
    clamp(cursorRatio, 0, 1),
    clamp(cursorRatio + featherRatio, 0, 1),
    1,
  );
}

interface StateValues {
  readonly phase: KaraokeSweepPhase;
  readonly bindingId: string | null;
  readonly progress: number;
  readonly cursor: number;
  readonly useFeatherMask: boolean;
  readonly continuation: KaraokeSweepContinuation;
}

function freezeState(
  input: CreateKaraokeSweepStateInput,
  lineWidth: number,
  featherPx: number,
  cursorBounds: KaraokeSweepCursorBounds,
  values: StateValues,
): KaraokeSweepState {
  const cursor = clamp(values.cursor, cursorBounds[0], cursorBounds[1]);
  const cursorRatio = lineWidth > 0 ? cursor / lineWidth : 0;
  const featherRatio = lineWidth > 0 ? featherPx / lineWidth : 0;
  const stops = values.useFeatherMask
    ? cursorFeatherStops(cursorRatio, featherRatio, input.direction)
    : staticStops;
  const maskAlphas = values.useFeatherMask
    ? input.direction === "forward"
      ? forwardMask
      : reverseMask
    : values.phase === "sung"
      ? solidMask
      : transparentMask;

  return Object.freeze({
    lineId: input.visualLine.lineId,
    lane: input.visualLine.lane,
    direction: input.direction,
    phase: values.phase,
    bindingId: values.bindingId,
    progress: clamp(values.progress, 0, 1),
    cursor,
    cursorRatio,
    cursorBounds,
    featherPx,
    featherRatio,
    stops,
    maskAlphas,
    continuation: values.continuation,
  });
}

/**
 * Completes one CJK glyph locally before an authored gap or visual-line end.
 *
 * The shared cursor remains unchanged for adjacent bindings. This local mask
 * prevents a boundary glyph from freezing with most of its feather still
 * inside the glyph, then finishing at an unrelated continuation speed.
 */
export function createKaraokeBindingCompletionSweepState(
  input: CreateKaraokeBindingCompletionSweepStateInput,
): KaraokeSweepState {
  const lineWidth =
    Number.isFinite(input.lineWidth) && input.lineWidth > 0
      ? input.lineWidth
      : 0;
  const requestedFeatherPx =
    Number.isFinite(input.featherPx) && input.featherPx >= 0
      ? input.featherPx
      : 0;
  const visualLine = Object.freeze({
    lineId: input.lineId,
    width: lineWidth,
    lane: input.lane,
    bindings: Object.freeze([input.binding]),
  });
  const binding = normalizeBinding(input.binding, lineWidth);
  const maxFeatherGlyphRatio =
    input.maxFeatherGlyphRatio !== undefined &&
    Number.isFinite(input.maxFeatherGlyphRatio) &&
    input.maxFeatherGlyphRatio >= 0
      ? clamp(input.maxFeatherGlyphRatio, 0, 1)
      : null;
  const featherPx =
    binding && maxFeatherGlyphRatio !== null
      ? Math.min(requestedFeatherPx, binding.width * maxFeatherGlyphRatio)
      : requestedFeatherPx;
  const stateInput: CreateKaraokeSweepStateInput = {
    visualLine,
    positionMs: input.positionMs,
    direction: input.direction,
    featherPx,
  };
  const cursorBounds = Object.freeze(
    input.direction === "forward"
      ? ([0, lineWidth + featherPx] as const)
      : ([-featherPx, lineWidth] as const),
  );
  const initialCursor = input.direction === "forward" ? 0 : lineWidth;
  const noContinuation = continuationState(
    false,
    "none",
    0,
    initialCursor,
    initialCursor,
  );

  if (lineWidth === 0 || !binding) {
    return freezeState(stateInput, lineWidth, featherPx, cursorBounds, {
      phase: "empty",
      bindingId: null,
      progress: 0,
      cursor: initialCursor,
      useFeatherMask: false,
      continuation: noContinuation,
    });
  }

  const positionMs = Number.isFinite(input.positionMs)
    ? input.positionMs
    : Number.NEGATIVE_INFINITY;
  const start = startCursor(binding, input.direction);
  const finish = advanceCursor(
    endCursor(binding, input.direction),
    input.direction,
    featherPx,
  );
  if (positionMs < binding.beginMs) {
    return freezeState(stateInput, lineWidth, featherPx, cursorBounds, {
      phase: "future",
      bindingId: null,
      progress: 0,
      cursor: start,
      useFeatherMask: false,
      continuation: noContinuation,
    });
  }
  if (positionMs < binding.endMs) {
    const authoredDurationMs = binding.endMs - binding.beginMs;
    const maxVisualDurationMs =
      input.maxVisualDurationMs !== undefined &&
      Number.isFinite(input.maxVisualDurationMs) &&
      input.maxVisualDurationMs > 0
        ? input.maxVisualDurationMs
        : authoredDurationMs;
    const visualDurationMs = Math.min(
      authoredDurationMs,
      maxVisualDurationMs,
    );
    const authoredProgress = clamp(
      (positionMs - binding.beginMs) / authoredDurationMs,
      0,
      1,
    );
    const visualProgress = clamp(
      (positionMs - binding.beginMs) / visualDurationMs,
      0,
      1,
    );
    return freezeState(stateInput, lineWidth, featherPx, cursorBounds, {
      phase: "active",
      bindingId: binding.bindingId,
      progress: authoredProgress,
      cursor: start + (finish - start) * visualProgress,
      useFeatherMask: true,
      continuation: noContinuation,
    });
  }
  return freezeState(stateInput, lineWidth, featherPx, cursorBounds, {
    phase: "sung",
    bindingId: binding.bindingId,
    progress: 1,
    cursor: finish,
    // Keep the endpoint mask stable after the authored boundary. The solid
    // edge is already at the glyph's far edge, so switching to solidMask would
    // only change CSS mask topology and risk a subpixel rasterization flash.
    useFeatherMask: true,
    continuation: noContinuation,
  });
}

/** Resolves one visual line through a single layout-space cursor. */
export function createKaraokeSweepState(
  input: CreateKaraokeSweepStateInput,
): KaraokeSweepState {
  const lineWidth =
    Number.isFinite(input.visualLine.width) && input.visualLine.width > 0
      ? input.visualLine.width
      : 0;
  const requestedFeather =
    input.featherPx !== undefined &&
    Number.isFinite(input.featherPx) &&
    input.featherPx >= 0
      ? input.featherPx
      : DEFAULT_SWEEP_FEATHER_PX;
  const requestedMaxRatio =
    input.maxFeatherRatio !== undefined &&
    Number.isFinite(input.maxFeatherRatio) &&
    input.maxFeatherRatio >= 0
      ? clamp(input.maxFeatherRatio, 0, 1)
      : DEFAULT_SWEEP_MAX_FEATHER_RATIO;
  const featherReferenceWidth =
    input.featherReferenceWidth !== undefined &&
    Number.isFinite(input.featherReferenceWidth) &&
    input.featherReferenceWidth > 0
      ? input.featherReferenceWidth
      : lineWidth;
  const requestedFeatherPx = Math.min(
    requestedFeather,
    featherReferenceWidth * requestedMaxRatio,
  );
  const bindings = normalizeBindings(input.visualLine.bindings, lineWidth);
  const terminalBinding = bindings[bindings.length - 1] ?? null;
  const featherPx = requestedFeatherPx;
  const cursorBounds = Object.freeze(
    input.direction === "forward"
      ? ([0, lineWidth + featherPx] as const)
      : ([-featherPx, lineWidth] as const),
  );
  const initialCursor = input.direction === "forward" ? 0 : lineWidth;
  let terminalCursor = initialCursor;
  for (const binding of bindings) {
    terminalCursor = mergeCursor(
      terminalCursor,
      bindingPaintEndCursor(
        binding,
        input.direction,
        featherPx,
        binding === terminalBinding,
      ),
      input.direction,
    );
  }
  const continuationEligible =
    input.visualLine.lane === "top" &&
    terminalBinding?.characterClass === "han-kana";
  const continuationTarget =
    input.direction === "forward" ? lineWidth + featherPx : -featherPx;
  const pendingContinuation = continuationState(
    continuationEligible,
    "pending",
    0,
    terminalCursor,
    continuationTarget,
  );

  if (lineWidth === 0 || bindings.length === 0 || !terminalBinding) {
    return freezeState(input, lineWidth, featherPx, cursorBounds, {
      phase: "empty",
      bindingId: null,
      progress: 0,
      cursor: initialCursor,
      useFeatherMask: false,
      continuation: pendingContinuation,
    });
  }

  const positionMs = Number.isFinite(input.positionMs)
    ? input.positionMs
    : Number.NEGATIVE_INFINITY;
  let completedCursor = initialCursor;
  let completedBinding: ValidSweepBinding | null = null;

  for (const binding of bindings) {
    if (positionMs < binding.beginMs) {
      return freezeState(input, lineWidth, featherPx, cursorBounds, {
        phase: completedBinding ? "gap" : "future",
        bindingId: completedBinding?.bindingId ?? null,
        progress: completedBinding ? 1 : 0,
        cursor: completedCursor,
        useFeatherMask: completedBinding !== null,
        continuation: pendingContinuation,
      });
    }
    if (positionMs < binding.endMs) {
      const authoredProgress = clamp(
        (positionMs - binding.beginMs) /
          (binding.endMs - binding.beginMs),
        0,
        1,
      );
      // Native mask slots are shared by all timed bindings on this visual
      // line. Start the next segment from the current physical cursor rather
      // than its authored glyph edge, so a partial feather continues forward
      // instead of pausing or being replaced with a solid fill.
      const physicalStart = mergeCursor(
        completedCursor,
        startCursor(binding, input.direction),
        input.direction,
      );
      const physicalEnd = mergeCursor(
        physicalStart,
        bindingPaintEndCursor(
          binding,
          input.direction,
          featherPx,
          binding === terminalBinding,
        ),
        input.direction,
      );
      const localCursor =
        physicalStart + (physicalEnd - physicalStart) * authoredProgress;
      return freezeState(input, lineWidth, featherPx, cursorBounds, {
        phase: "active",
        bindingId: binding.bindingId,
        progress: authoredProgress,
        cursor: localCursor,
        useFeatherMask: true,
        continuation: pendingContinuation,
      });
    }
    completedCursor = mergeCursor(
      completedCursor,
      bindingPaintEndCursor(
        binding,
        input.direction,
        featherPx,
        binding === terminalBinding,
      ),
      input.direction,
    );
    completedBinding = binding;
  }

  if (continuationEligible) {
    const elapsedMs = Math.max(0, positionMs - terminalBinding.endMs);
    const continuationProgress = clamp(
      elapsedMs / HAN_KANA_TERMINAL_CONTINUATION_MS,
      0,
      1,
    );
    const continuationCursor =
      terminalCursor +
      (continuationTarget - terminalCursor) * continuationProgress;
    const active = elapsedMs < HAN_KANA_TERMINAL_CONTINUATION_MS;
    return freezeState(input, lineWidth, featherPx, cursorBounds, {
      phase: "sung",
      bindingId: terminalBinding.bindingId,
      progress: 1,
      cursor: continuationCursor,
      useFeatherMask: active,
      continuation: continuationState(
        true,
        active ? "active" : "settled",
        continuationProgress,
        terminalCursor,
        continuationTarget,
      ),
    });
  }

  return freezeState(input, lineWidth, featherPx, cursorBounds, {
    phase: "sung",
    bindingId: terminalBinding.bindingId,
    progress: 1,
    cursor: completedCursor,
    useFeatherMask: terminalBinding.characterClass !== "han-kana",
    continuation: pendingContinuation,
  });
}
