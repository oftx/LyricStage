export type KaraokeEmphasisPhase =
  | "ineligible"
  | "future"
  | "expanding"
  | "held"
  | "reversing"
  | "complete";

export type KaraokeGlowMaskPhase = "none" | "sweep" | "full-played";

export interface KaraokeEmphasisInput {
  readonly bindingId: string;
  readonly groupBeginMs: number;
  readonly groupEndMs: number;
  readonly groupDurationMs?: number;
  readonly bindingIndex: number;
  readonly bindingCount: number;
  readonly letterNumberCount: number;
  readonly scriptClass: "han-kana" | "latin" | "other";
  readonly lane:
    | "foreground-primary"
    | "foreground-pronunciation"
    | "background-primary"
    | "background-pronunciation";
  readonly playbackPositionMs: number;
  readonly lineVisibility: number;
  readonly reducedMotion?: boolean;
}

export interface KaraokeEmphasisState {
  readonly bindingId: string;
  readonly eligible: boolean;
  readonly phase: KaraokeEmphasisPhase;
  readonly scale: number;
  readonly targetScale: number;
  readonly shadowAlpha: number;
  readonly glowOpacity: number;
  readonly glowRadiusPx: number;
  readonly maskPhase: KaraokeGlowMaskPhase;
  readonly startDelayMs: number;
  readonly reverseStartMs: number;
  readonly reverseEndMs: number;
}

export interface KaraokeGlowMaskState {
  readonly stops: readonly [number, number, number, number];
  readonly alphas: readonly [number, number, number, number];
  readonly layerAlphas: KaraokeGlowLayerAlphas;
  readonly opacity: number;
  readonly phase: KaraokeGlowMaskPhase;
}

export interface KaraokeGlowLayerAlphas {
  readonly core: number;
  readonly mid: number;
  readonly outer: number;
  readonly bloom: number;
}

export interface KaraokeGlowPaintProfile {
  readonly primaryAlpha: number;
  readonly tertiaryAlpha: number;
}

export type KaraokeEmphasisSpreadDirection = "forward" | "reverse";

export interface KaraokeEmphasisSpreadState {
  readonly center: number;
  readonly translationsPx: readonly number[];
}

const MIN_DURATION_MS = 1_000;
const MAX_SCALE_DURATION_MS = 2_000;
const MAX_ANIMATION_DURATION_MS = 3_000;
const MAX_LETTER_NUMBER_COUNT = 7;
const STAGGER_FRACTION = 0.4;
const MAX_STAGGER_MS = 400;
const MAX_SCALE = 1.14;
const MAX_SHADOW_ALPHA_BYTE = 128;
const GLOW_RADIUS_PX = 5;
const MAX_SHADOW_ALPHA = MAX_SHADOW_ALPHA_BYTE / 255;
export const KARAOKE_GLOW_MASK_BLEED_PX = 32;

function clamp(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
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

function emphasisEase(progress: number): number {
  const x = clamp(progress);
  if (x === 0 || x === 1) return x;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const midpoint = (low + high) * 0.5;
    if (cubicCoordinate(midpoint, 0.25, 0.25) < x) low = midpoint;
    else high = midpoint;
  }
  return cubicCoordinate((low + high) * 0.5, 0.1, 1);
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

/** Keeps independently scaled bindings from overlapping around their center. */
export function createKaraokeEmphasisSpread(
  expansionsPx: readonly number[],
  direction: KaraokeEmphasisSpreadDirection,
): KaraokeEmphasisSpreadState {
  const expansions = expansionsPx.map((value) =>
    Number.isFinite(value) ? Math.max(0, value) : 0,
  );
  const size = expansions.length;
  const translations = Array<number>(size).fill(0);
  if (size <= 1) {
    return Object.freeze({
      center: 0,
      translationsPx: Object.freeze(translations),
    });
  }

  const center = size % 2 === 0 ? size / 2 - 0.5 : Math.floor(size / 2);
  const ceilCenter = Math.ceil(center);
  const floorCenter = Math.floor(center);
  const rightStart = ceilCenter === center ? ceilCenter + 1 : ceilCenter;
  const leftStart = floorCenter === center ? floorCenter - 1 : floorCenter;
  const directionSign = direction === "forward" ? 1 : -1;

  for (let index = leftStart; index >= 0; index -= 1) {
    const neighbor = index + 1;
    let amount = expansions[index] ?? 0;
    if (neighbor <= center) amount += expansions[neighbor] ?? 0;
    if (neighbor < center) amount += Math.abs(translations[neighbor] ?? 0);
    translations[index] = (-amount * directionSign) / 2;
  }
  for (let index = rightStart; index < size; index += 1) {
    const neighbor = index - 1;
    let amount = expansions[index] ?? 0;
    if (neighbor >= center) amount += expansions[neighbor] ?? 0;
    if (neighbor > center) amount += Math.abs(translations[neighbor] ?? 0);
    translations[index] = (amount * directionSign) / 2;
  }

  return Object.freeze({
    center,
    translationsPx: Object.freeze(translations),
  });
}

function freezeState(
  state: Omit<KaraokeEmphasisState, "bindingId"> & { readonly bindingId: string },
): KaraokeEmphasisState {
  return Object.freeze(state);
}

export function sampleKaraokeEmphasis(
  input: KaraokeEmphasisInput,
): KaraokeEmphasisState {
  const timelineDurationMs = input.groupEndMs - input.groupBeginMs;
  const durationMs =
    input.groupDurationMs !== undefined &&
    Number.isFinite(input.groupDurationMs) &&
    input.groupDurationMs > 0
      ? input.groupDurationMs
      : timelineDurationMs;
  const validTiming =
    Number.isFinite(input.groupBeginMs) &&
    Number.isFinite(input.groupEndMs) &&
    timelineDurationMs > 0 &&
    durationMs > 0 &&
    Number.isFinite(input.playbackPositionMs);
  const bindingCount = Number.isFinite(input.bindingCount)
    ? Math.max(1, Math.floor(input.bindingCount))
    : 1;
  const rawBindingIndex = Number.isFinite(input.bindingIndex)
    ? Math.floor(input.bindingIndex)
    : 0;
  const bindingIndex = clamp(
    rawBindingIndex,
    0,
    bindingCount - 1,
  );
  // Match emphasis-split eligibility: only multi-letter latin runs (2–7).
  // A lone digit like QRC `3(t,1360)` must not pop/glow, or it stays "active"
  // through the rest of the line (reverse was scheduled after group end).
  const eligible =
    validTiming &&
    input.lane === "foreground-primary" &&
    input.scriptClass === "latin" &&
    durationMs >= MIN_DURATION_MS &&
    input.letterNumberCount >= 2 &&
    input.letterNumberCount <= MAX_LETTER_NUMBER_COUNT;
  const targetScale = eligible
    ? lerp(
        1,
        MAX_SCALE,
        clamp(
          durationMs / MIN_DURATION_MS,
          1,
          MAX_SCALE_DURATION_MS / MIN_DURATION_MS,
        ) - 1,
      )
    : 1;
  const safeGroupBeginMs = Number.isFinite(input.groupBeginMs)
    ? input.groupBeginMs
    : 0;
  const safeDurationMs = validTiming ? durationMs : 0;
  const groupEndMs = safeGroupBeginMs + safeDurationMs;
  const startDelayMs =
    bindingIndex *
    Math.min(
      MAX_STAGGER_MS,
      (STAGGER_FRACTION * safeDurationMs) / bindingCount,
    );
  const animationDurationMs = Math.min(
    Math.max(1, safeDurationMs),
    MAX_ANIMATION_DURATION_MS,
  );
  const expandStartMs = safeGroupBeginMs + startDelayMs;
  // Ideal reverse is mid-group for multi-binding runs. For bindingCount=1 the
  // formula becomes begin+2*duration (after the word ends) and freezes the
  // expanded glow for the rest of the lyric line — clamp to group end.
  const unclampedReverseStartMs =
    safeGroupBeginMs +
    startDelayMs +
    (safeDurationMs * 2) / bindingCount;
  const reverseStartMs = Math.min(
    unclampedReverseStartMs,
    Math.max(expandStartMs, groupEndMs),
  );
  const reverseEndMs = reverseStartMs + animationDurationMs;
  const lineVisibility = clamp(input.lineVisibility);

  if (!eligible || input.reducedMotion) {
    return freezeState({
      bindingId: input.bindingId,
      eligible,
      phase: eligible ? "complete" : "ineligible",
      scale: 1,
      targetScale,
      shadowAlpha: 0,
      glowOpacity: 0,
      glowRadiusPx: eligible ? GLOW_RADIUS_PX : 0,
      maskPhase: "none",
      startDelayMs,
      reverseStartMs,
      reverseEndMs,
    });
  }
  if (input.playbackPositionMs < expandStartMs) {
    return freezeState({
      bindingId: input.bindingId,
      eligible: true,
      phase: "future",
      scale: 1,
      targetScale,
      shadowAlpha: 0,
      glowOpacity: 0,
      glowRadiusPx: GLOW_RADIUS_PX,
      maskPhase: "none",
      startDelayMs,
      reverseStartMs,
      reverseEndMs,
    });
  }

  const expansionAtReverseStart = emphasisEase(
    clamp((reverseStartMs - expandStartMs) / animationDurationMs),
  );
  const capturedScale = lerp(1, targetScale, expansionAtReverseStart);
  const capturedAlphaByte = Math.round(
    expansionAtReverseStart * MAX_SHADOW_ALPHA_BYTE,
  );
  let phase: KaraokeEmphasisPhase;
  let scale: number;
  let shadowAlpha: number;

  if (input.playbackPositionMs < reverseStartMs) {
    const progress = clamp(
      (input.playbackPositionMs - expandStartMs) / animationDurationMs,
    );
    const eased = emphasisEase(progress);
    phase = progress < 1 ? "expanding" : "held";
    scale = lerp(1, targetScale, eased);
    shadowAlpha = Math.round(eased * MAX_SHADOW_ALPHA_BYTE) / 255;
  } else if (input.playbackPositionMs < reverseEndMs) {
    const reverseProgress = clamp(
      (input.playbackPositionMs - reverseStartMs) / animationDurationMs,
    );
    const reverseFactor = 1 - emphasisEase(reverseProgress);
    phase = "reversing";
    scale = lerp(1, capturedScale, reverseFactor);
    shadowAlpha = Math.round(reverseFactor * capturedAlphaByte) / 255;
  } else {
    phase = "complete";
    scale = 1;
    shadowAlpha = 0;
  }

  const wordSung = input.playbackPositionMs >= input.groupEndMs;
  const maskPhase: KaraokeGlowMaskPhase =
    shadowAlpha <= 0 ? "none" : wordSung ? "full-played" : "sweep";
  return freezeState({
    bindingId: input.bindingId,
    eligible: true,
    phase,
    scale: lerp(1, scale, lineVisibility),
    targetScale,
    shadowAlpha,
    glowOpacity: shadowAlpha * lineVisibility,
    glowRadiusPx: GLOW_RADIUS_PX,
    maskPhase,
    startDelayMs,
    reverseStartMs,
    reverseEndMs,
  });
}

export function createKaraokeGlowMaskState(
  emphasis: KaraokeEmphasisState,
  stops: readonly [number, number, number, number],
  alphas: readonly [number, number, number, number],
  paintProfile: KaraokeGlowPaintProfile,
): KaraokeGlowMaskState {
  const primaryAlpha = clamp(paintProfile.primaryAlpha);
  const tertiaryAlpha = clamp(paintProfile.tertiaryAlpha);
  const mapSweepAlpha = (alpha: number): number =>
    lerp(tertiaryAlpha, primaryAlpha, clamp(alpha));
  const visibleShadowAlpha = clamp(
    emphasis.glowOpacity,
    0,
    MAX_SHADOW_ALPHA,
  );
  const hasPhysicalSweep = alphas[0] !== alphas[3];
  const effectivePhase: KaraokeGlowMaskPhase =
    visibleShadowAlpha <= 0
      ? "none"
      : emphasis.maskPhase === "full-played" && hasPhysicalSweep
        ? "sweep"
        : emphasis.maskPhase;
  const effectiveAlphas: readonly [number, number, number, number] =
    effectivePhase === "none"
      ? [0, 0, 0, 0]
      : effectivePhase === "full-played"
        ? [primaryAlpha, primaryAlpha, primaryAlpha, primaryAlpha]
        : [
            mapSweepAlpha(alphas[0]),
            mapSweepAlpha(alphas[1]),
            mapSweepAlpha(alphas[2]),
            mapSweepAlpha(alphas[3]),
          ];
  const layerAlphas = Object.freeze({
    core: Math.min(visibleShadowAlpha, MAX_SHADOW_ALPHA),
    mid: Math.min(visibleShadowAlpha * 0.72, 0.4),
    outer: Math.min(visibleShadowAlpha * 0.42, 0.26),
    bloom: Math.min(visibleShadowAlpha * 0.2, 0.12),
  });
  return Object.freeze({
    stops: Object.freeze([...stops]) as unknown as readonly [
      number,
      number,
      number,
      number,
    ],
    alphas: Object.freeze([...effectiveAlphas]) as unknown as readonly [
      number,
      number,
      number,
      number,
    ],
    layerAlphas,
    opacity: emphasis.glowOpacity,
    phase: effectivePhase,
  });
}

export function expandKaraokeGlowMaskStops(
  input: {
    readonly stops: readonly [number, number, number, number];
    readonly visualLineWidthPx: number;
    readonly cursorPx: number;
    readonly featherPx: number;
    readonly direction: KaraokeEmphasisSpreadDirection;
    readonly bleedPx?: number;
  },
): readonly [number, number, number, number] {
  const bleedPx = input.bleedPx ?? KARAOKE_GLOW_MASK_BLEED_PX;
  if (
    !Number.isFinite(input.visualLineWidthPx) ||
    input.visualLineWidthPx <= 0 ||
    !Number.isFinite(bleedPx) ||
    bleedPx <= 0
  ) {
    return Object.freeze([...input.stops]) as unknown as readonly [
      number,
      number,
      number,
      number,
    ];
  }
  const usePhysicalSweep =
    Number.isFinite(input.cursorPx) &&
    Number.isFinite(input.featherPx) &&
    input.featherPx >= 0;
  const stopBPx = usePhysicalSweep
    ? input.direction === "forward"
      ? input.cursorPx - input.featherPx
      : input.cursorPx
    : clamp(input.stops[1]) * input.visualLineWidthPx;
  const stopCPx = usePhysicalSweep
    ? input.direction === "forward"
      ? input.cursorPx
      : input.cursorPx + input.featherPx
    : clamp(input.stops[2]) * input.visualLineWidthPx;
  const expandedWidthPx = input.visualLineWidthPx + bleedPx * 2;
  return Object.freeze([
    0,
    clamp((bleedPx + stopBPx) / expandedWidthPx),
    clamp((bleedPx + stopCPx) / expandedWidthPx),
    1,
  ]);
}
