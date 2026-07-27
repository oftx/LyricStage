import type { LyricDocument, LyricTrack, TextLyricLine } from "../domain/types.js";
import { resolveLyricDirection } from "../layout/direction.js";
import type { PlaybackFrame } from "../playback/create-playback-frame.js";
import type {
  SyncedPaintTrackName,
  SyncedRowPaintHost,
} from "../view/row-view.js";
import {
  compileKaraokeBindingGroups,
  type KaraokeTextBinding,
  type KaraokeTrackBindingCompilation,
  type KaraokeVisualEmphasisGroupReference,
  type KaraokeWordBindingPlan,
} from "../karaoke/binding-groups.js";
import {
  createKaraokeEmphasisSpread,
  createKaraokeGlowMaskState,
  expandKaraokeGlowMaskStops,
  KARAOKE_GLOW_MASK_BLEED_PX,
  sampleKaraokeEmphasis,
  type KaraokeGlowPaintProfile,
  type KaraokeEmphasisState,
} from "../karaoke/glow.js";
import {
  createIdleKaraokeLiftState,
  sampleKaraokeLift,
  type KaraokeLiftState,
} from "../karaoke/lift.js";
import {
  createKaraokeMaskLayout,
  type KaraokeBindingMaskGeometry,
  type KaraokeMaskLayout,
  type KaraokeVisualLineGeometry,
} from "../karaoke/mask-layout.js";
import {
  createKaraokeBindingCompletionSweepState,
  createKaraokeSweepState,
  HAN_KANA_SWEEP_MAX_FEATHER_GLYPH_RATIO,
  HAN_KANA_SWEEP_MAX_VISUAL_DURATION_MS,
  HAN_KANA_TERMINAL_CONTINUATION_MS,
  type KaraokeSweepBindingInput,
  type KaraokeSweepDirection,
  type KaraokeSweepMaskAlphas,
  type KaraokeSweepStops,
} from "../karaoke/sweep.js";
import {
  classifyKaraokeGrapheme,
  countLetterOrNumberGraphemes,
  segmentKaraokeGraphemes,
} from "../karaoke/text-units.js";
import {
  advanceDisplayModeTransition,
  createDisplayModeTransitionState,
  requestDisplayModeTransition,
  type DisplayModeTransitionState,
} from "../transitions/display-mode.js";

export type KaraokePaintMode = "karaoke" | "line";

export interface KaraokeRenderOptions {
  readonly reducedMotion?: boolean;
  readonly playing?: boolean;
  readonly paintSuppressedLineIds?: ReadonlySet<string>;
  /**
   * When set (line-timed / lrc mode), primary paint follows this set instead of
   * time-based activeLineIds — matches native line-timed pre-anchor handoff.
   */
  readonly visualPrimaryLineIds?: ReadonlySet<string> | null;
  /** Opacity transition duration matched to concurrent row-move (line mode). */
  readonly alphaDurationMs?: number;
  readonly alphaDelayMs?: number;
  /** Only these lines receive mid-move fill timing (usually the new focus). */
  readonly alphaTimingLineIds?: ReadonlySet<string>;
}

export interface KaraokePaintModeOptions {
  readonly animate?: boolean;
  readonly playing?: boolean;
  readonly reducedMotion?: boolean;
  /**
   * Morph duration for karaoke ↔ line paint. Whole-line target should use the
   * fixed line-move interval so 逐字→整行 matches native 整行 cadence.
   */
  readonly durationMs?: number;
}

export interface KaraokeRendererOptions {
  readonly resolvePaintHost: (
    lineId: string,
  ) => SyncedRowPaintHost | null;
  /** Defaults to the foreground pair; separate renderers may own other tracks. */
  readonly trackNames?: readonly SyncedPaintTrackName[];
  readonly active?: boolean;
  readonly now?: () => number;
}

export interface KaraokeRenderer {
  setActive(active: boolean): void;
  setDocument(document: LyricDocument | null): void;
  setPaintMode(mode: KaraokePaintMode, options?: KaraokePaintModeOptions): void;
  hasGeometryObserver(): boolean;
  invalidateGeometry(lineIds?: readonly string[]): void;
  renderFrame(frame: PlaybackFrame, options?: KaraokeRenderOptions): void;
  resetPlaybackState(): void;
  getDisplayModeTransitionState(): DisplayModeTransitionState;
  getTrackCount(): number;
  getFallbackTrackCount(): number;
  destroy(): void;
}

type KaraokeTrackName = SyncedPaintTrackName;
type KaraokeLane = "top" | "bottom";
type KaraokeEmphasisLane =
  | "foreground-primary"
  | "foreground-pronunciation"
  | "background-primary"
  | "background-pronunciation";
type KaraokeScriptClass = "han-kana" | "latin" | "other";

interface CompiledTrack {
  readonly line: TextLyricLine;
  readonly trackName: KaraokeTrackName;
  readonly lane: KaraokeLane;
  readonly track: LyricTrack;
  readonly compilation: KaraokeTrackBindingCompilation;
}

interface ResolvedTrack extends CompiledTrack {
  readonly host: SyncedRowPaintHost;
  readonly hostElement: HTMLElement;
  readonly direction: KaraokeSweepDirection;
}

interface BindingDom {
  readonly plan: KaraokeTextBinding;
  readonly element: HTMLElement;
  readonly wordPlan: KaraokeWordBindingPlan | null;
  readonly scriptClass: KaraokeScriptClass;
  readonly letterNumberGraphemeCount: number;
  readonly emphasisGroup: KaraokeVisualEmphasisGroupReference | null;
  readonly emphasisBindingIndex: number;
  readonly emphasisBindingCount: number;
  readonly emphasisScriptClass: KaraokeScriptClass;
  readonly emphasisContainsHanOrKana: boolean;
  readonly emphasisLetterNumberCount: number;
  readonly paintCache: BindingPaintCache;
  emphasisPivotYPx: number | null;
}

interface BuiltTrack {
  readonly root: HTMLElement;
  readonly bindings: ReadonlyMap<string, BindingDom>;
}

interface TrackRecord extends ResolvedTrack, BuiltTrack {
  layout: KaraokeMaskLayout;
  layoutSource: "fallback" | "measured";
  featherReferenceWidth: number;
  readonly visualLinePlans: WeakMap<
    KaraokeVisualLineGeometry,
    VisualLinePaintPlan
  >;
}

interface VisualLineBindingPlan {
  readonly geometry: KaraokeBindingMaskGeometry;
  readonly binding: BindingDom;
  readonly completionMode: HanKanaCompletionMode | null;
  readonly completionSweepBinding: KaraokeSweepBindingInput | null;
}

interface VisualLinePaintPlan {
  readonly timedBindings: readonly KaraokeSweepBindingInput[];
  readonly maxBindingEndMs: number | null;
  readonly bindings: readonly VisualLineBindingPlan[];
}

type LinePaintTransitionKind = "activate" | "deactivate";

interface LineMixTransition {
  readonly kind: LinePaintTransitionKind;
  readonly startMs: number;
  readonly delayMs: number;
  readonly durationMs: number;
  readonly from: number;
  readonly to: number;
  /** Native line-timed fill uses linear (CSS --am-lp-curve-alpha: linear). */
  readonly linear: boolean;
}

interface LinePaintState {
  active: boolean;
  effectOwned: boolean;
  initialized: boolean;
  mix: number;
  transition: LineMixTransition | null;
}

interface LinePaintSample {
  readonly active: boolean;
  readonly trueActive: boolean;
  readonly effectOwned: boolean;
  readonly effectTailOwned: boolean;
  readonly primaryMix: number;
  readonly effectVisibility: number;
  readonly glowEnvelope: number;
}

interface RowRecord {
  readonly line: TextLyricLine;
  readonly tracks: ReadonlyMap<KaraokeTrackName, TrackRecord>;
  readonly linePaint: LinePaintState;
}

interface PaintContext {
  readonly frame: PlaybackFrame;
  readonly deltaMs: number;
  readonly reducedMotion: boolean;
  readonly playing: boolean;
  readonly paintSuppressedLineIds: ReadonlySet<string>;
  readonly visualPrimaryLineIds: ReadonlySet<string> | null;
  readonly alphaDurationMs: number | null;
  readonly alphaDelayMs: number;
  readonly alphaTimingLineIds: ReadonlySet<string> | null;
  /** When true, row mix uses native line-timed timing (not karaoke 250/350). */
  readonly lineTimedMix: boolean;
}

/** Karaoke word-mode row mix (legacy AM karaoke alpha). */
const ACTIVATE_MIX_DURATION_MS = 250;
const DEACTIVATE_MIX_DELAY_MS = 250;
const DEACTIVATE_MIX_DURATION_MS = 350;
/**
 * Native line-timed CSS defaults (base.css active/deactivate):
 * delay 75ms + duration 90ms linear mid-window fill.
 */
const LINE_ACTIVATE_MIX_DELAY_MS = 75;
const LINE_ACTIVATE_MIX_DURATION_MS = 90;
const LINE_DEACTIVATE_MIX_DELAY_MS = 75;
const LINE_DEACTIVATE_MIX_DURATION_MS = 90;
const POST_END_EFFECT_TAIL_MS = 3_000;
const BINDING_RESOURCE_PREWARM_MS = 100;
const BINDING_TRANSFORM_EPSILON = 0.000_01;
const solidMask = Object.freeze([1, 1, 1, 1]) as KaraokeSweepMaskAlphas;
const foregroundGlowPaintProfile = Object.freeze({
  primaryAlpha: 0.94,
  tertiaryAlpha: 0.18,
}) satisfies KaraokeGlowPaintProfile;
const backgroundGlowPaintProfile = Object.freeze({
  primaryAlpha: 0.35,
  tertiaryAlpha: 0.18,
}) satisfies KaraokeGlowPaintProfile;
const latinScriptPattern = /\p{Script_Extensions=Latin}/u;
const letterPattern = /\p{L}/u;
const numberPattern = /\p{N}/u;
const foregroundTrackNames = Object.freeze([
  "foreground",
  "foregroundPronunciation",
] as const satisfies readonly KaraokeTrackName[]);
const supportedTrackNames = new Set<KaraokeTrackName>([
  "foreground",
  "foregroundPronunciation",
  "background",
  "backgroundPronunciation",
]);

enum BindingStyleSlot {
  LineMix,
  MaskWidth,
  MaskOffsetX,
  MaskAlphaA,
  MaskAlphaB,
  MaskAlphaC,
  MaskAlphaD,
  StopB,
  StopC,
  GlowMaskAlphaA,
  GlowMaskAlphaB,
  GlowMaskAlphaC,
  GlowMaskAlphaD,
  GlowStopB,
  GlowStopC,
  GlowMaskWidth,
  GlowMaskOffsetX,
  LiftY,
  EmphasisScale,
  EmphasisSpreadX,
  EmphasisPivotY,
  GlowOpacity,
  GlowAlphaCore,
  GlowAlphaMid,
  GlowAlphaOuter,
  GlowAlphaBloom,
  Count,
}

const bindingStyleProperties = Object.freeze([
  "--am-lp-karaoke-line-mix",
  "--am-lp-karaoke-mask-width",
  "--am-lp-karaoke-mask-offset-x",
  "--am-lp-karaoke-mask-a",
  "--am-lp-karaoke-mask-b",
  "--am-lp-karaoke-mask-c",
  "--am-lp-karaoke-mask-d",
  "--am-lp-karaoke-stop-b",
  "--am-lp-karaoke-stop-c",
  "--am-lp-karaoke-glow-mask-a",
  "--am-lp-karaoke-glow-mask-b",
  "--am-lp-karaoke-glow-mask-c",
  "--am-lp-karaoke-glow-mask-d",
  "--am-lp-karaoke-glow-stop-b",
  "--am-lp-karaoke-glow-stop-c",
  "--am-lp-karaoke-glow-mask-width",
  "--am-lp-karaoke-glow-mask-offset-x",
  "--am-lp-karaoke-lift-y",
  "--am-lp-karaoke-emphasis-scale",
  "--am-lp-karaoke-emphasis-spread-x",
  "--am-lp-karaoke-emphasis-pivot-y",
  "--am-lp-karaoke-glow-opacity",
  "--am-lp-karaoke-glow-alpha-core",
  "--am-lp-karaoke-glow-alpha-mid",
  "--am-lp-karaoke-glow-alpha-outer",
  "--am-lp-karaoke-glow-alpha-bloom",
] as const);

type BindingStyleValueSlot = Exclude<
  BindingStyleSlot,
  BindingStyleSlot.Count
>;

type BindingDynamicDatasetKey =
  | "sweepCompletionMode"
  | "sweepPhase"
  | "liftPhase"
  | "emphasisPhase"
  | "glowMaskPhase";

type BindingDynamicClassKey = "motionActive" | "glowActive";

const bindingDynamicClasses = Object.freeze({
  motionActive: "am-lp-karaoke-binding-motion-active",
  glowActive: "am-lp-karaoke-binding-glow-active",
}) satisfies Readonly<Record<BindingDynamicClassKey, string>>;

interface BindingPaintCache {
  readonly styleValues: Array<string | undefined>;
  datasetValues: Partial<Record<BindingDynamicDatasetKey, string>>;
  readonly classValues: Record<BindingDynamicClassKey, boolean>;
}

function createBindingPaintCache(): BindingPaintCache {
  return {
    styleValues: Array<string | undefined>(BindingStyleSlot.Count),
    datasetValues: {},
    classValues: {
      motionActive: false,
      glowActive: false,
    },
  };
}

function setBindingStyle(
  binding: BindingDom,
  slot: BindingStyleValueSlot,
  value: string,
): void {
  const property = bindingStyleProperties[slot];
  if (binding.paintCache.styleValues[slot] === value) return;
  binding.element.style.setProperty(property, value);
  binding.paintCache.styleValues[slot] = value;
}

function setBindingDataset(
  binding: BindingDom,
  key: BindingDynamicDatasetKey,
  value: string,
): void {
  if (binding.paintCache.datasetValues[key] === value) return;
  binding.element.dataset[key] = value;
  binding.paintCache.datasetValues[key] = value;
}

function setBindingClass(
  binding: BindingDom,
  key: BindingDynamicClassKey,
  enabled: boolean,
): void {
  if (binding.paintCache.classValues[key] === enabled) return;
  binding.element.classList.toggle(bindingDynamicClasses[key], enabled);
  binding.paintCache.classValues[key] = enabled;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function finiteTimestamp(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function isWithinBindingResourcePrewarmWindow(
  positionMs: number,
  startMs: number | null,
): boolean {
  return (
    startMs !== null &&
    Number.isFinite(positionMs) &&
    positionMs >= startMs - BINDING_RESOURCE_PREWARM_MS &&
    positionMs < startMs + BINDING_RESOURCE_PREWARM_MS
  );
}

function cssNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(5) : "0.00000";
}

function directPaintAlphas(
  sweepAlphas: KaraokeSweepMaskAlphas,
  paintProfile: KaraokeGlowPaintProfile,
  primaryMix: number,
): KaraokeSweepMaskAlphas {
  const mix = clampUnit(primaryMix);
  const range = paintProfile.primaryAlpha - paintProfile.tertiaryAlpha;
  return Object.freeze(
    sweepAlphas.map(
      (alpha) =>
        paintProfile.tertiaryAlpha + range * clampUnit(alpha) * mix,
    ),
  ) as KaraokeSweepMaskAlphas;
}

function canvasFont(style: CSSStyleDeclaration): string {
  return [
    style.fontStyle,
    style.fontVariant,
    style.fontWeight,
    style.fontSize,
    style.fontFamily,
  ]
    .filter(Boolean)
    .join(" ");
}

function measureEmphasisPivotYPx(
  element: HTMLElement,
  context: CanvasRenderingContext2D | null,
): number | null {
  const view = element.ownerDocument.defaultView;
  if (!view || !context || element.offsetHeight <= 0) return null;
  const style = view.getComputedStyle(element);
  context.font = canvasFont(style);
  const text = element.textContent?.trim() || "Hg";
  const metrics = context.measureText(text);
  const descent = Number(
    metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || 0,
  );
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  return Math.max(0, element.offsetHeight - paddingBottom - descent);
}

function finiteCssPixel(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteCssNumber(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveSweepFeatherReferenceWidth(track: TrackRecord): number {
  const fallback = Math.max(1, track.root.clientWidth);
  const row = track.root.closest(".am-lp-line-row") as HTMLElement | null;
  const rows = row?.parentElement;
  const view = track.root.ownerDocument.defaultView;
  if (!row || !rows || !view || rows.clientWidth <= 0) return fallback;

  const style = view.getComputedStyle(row);
  const fixedMargin =
    row.dataset.agentSide === "end" ? style.marginRight : style.marginLeft;
  const marginInlinePx = Math.max(0, finiteCssPixel(fixedMargin, 0));
  const widthFraction = clampUnit(
    finiteCssNumber(style.getPropertyValue("--am-lp-line-width"), 1),
  );
  const availableWidth =
    (rows.clientWidth - marginInlinePx * 2) * widthFraction;
  return Number.isFinite(availableWidth) && availableWidth > 0
    ? Math.max(fallback, availableWidth)
    : fallback;
}

interface MutableSweepBinding {
  bindingId: string;
  offset: number;
  width: number;
  beginMs: number;
  endMs: number;
  characterClass: "han-kana" | "other";
  graphemeCount: number;
  featherAdjustment: number;
}

interface MutableSweepGeometry {
  readonly geometry: KaraokeBindingMaskGeometry;
  readonly binding: BindingDom | null;
  offset: number;
  width: number;
}

/**
 * Gives an inter-word space to the preceding timed binding for sweep math.
 * The DOM keeps the space as a separate node so line wrapping is unchanged,
 * while the physical cursor still traverses the legacy renderer's blank range.
 */
function createVisualLineSweepGeometries(
  track: TrackRecord,
  visualLine: KaraokeVisualLineGeometry,
): MutableSweepGeometry[] {
  const entries = visualLine.bindings.map((geometry) => ({
    geometry,
    binding: track.bindings.get(geometry.bindingId) ?? null,
    offset: geometry.offset,
    width: geometry.width,
  }));

  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const next = entries[index];
    const nextBinding = next?.binding;
    if (
      !previous ||
      !next ||
      !nextBinding?.plan.timed ||
      !nextBinding.wordPlan?.spaceBefore ||
      nextBinding.wordPlan.wordIndex <= 0 ||
      nextBinding.plan.unitIndex !== 0
    ) {
      continue;
    }

    if (track.direction === "forward") {
      const previousRight = previous.offset + previous.width;
      if (next.offset > previousRight) {
        previous.width = next.offset - previous.offset;
      }
      continue;
    }

    const previousRight = previous.offset + previous.width;
    const nextRight = next.offset + next.width;
    if (previous.offset > nextRight) {
      previous.offset = nextRight;
      previous.width = previousRight - nextRight;
    }
  }

  return entries;
}

function createVisualLineSweepBindings(
  track: TrackRecord,
  visualLine: KaraokeVisualLineGeometry,
): readonly MutableSweepBinding[] {
  const bindings: MutableSweepBinding[] = [];
  const sweepGeometries = createVisualLineSweepGeometries(track, visualLine);
  const aggregateIndexes = new Map<string, number>();
  const hanKanaGroupIds = new Set(
    sweepGeometries.flatMap(({ binding }) => {
      return binding?.emphasisGroup && binding.emphasisContainsHanOrKana
        ? [binding.emphasisGroup.id]
        : [];
    }),
  );

  for (const sweepGeometry of sweepGeometries) {
    const { geometry, binding, offset, width } = sweepGeometry;
    const beginMs = finiteTimestamp(binding?.plan.beginMs ?? null);
    const endMs = finiteTimestamp(binding?.plan.endMs ?? null);
    if (!binding?.plan.timed || beginMs === null || endMs === null) continue;

    const emphasisGroup = binding.emphasisGroup;
    const aggregateSweep =
      emphasisGroup !== null &&
      emphasisGroup.bindingCount > 1 &&
      !hanKanaGroupIds.has(emphasisGroup.id);
    const characterClass =
      binding.scriptClass === "han-kana" ? "han-kana" : "other";
    const graphemeCount = binding.letterNumberGraphemeCount;
    // Match native h0(): nonterminal Latin groups travel only part of the
    // shared feather during their own timing window. The slot cursor completes
    // the remaining feather as later bindings advance it.
    const featherAdjustment =
      characterClass === "han-kana"
        ? 0
        : binding.emphasisLetterNumberCount <= 2
          ? 0.5
          : 0.25;
    if (!aggregateSweep || !emphasisGroup) {
      bindings.push({
        bindingId: geometry.bindingId,
        offset,
        width,
        beginMs,
        endMs,
        characterClass,
        graphemeCount,
        featherAdjustment,
      });
      continue;
    }

    const aggregateKey = `${visualLine.lineId}\u0000${emphasisGroup.id}`;
    const existingIndex = aggregateIndexes.get(aggregateKey);
    if (existingIndex === undefined) {
      aggregateIndexes.set(aggregateKey, bindings.length);
      bindings.push({
        bindingId: aggregateKey,
        offset,
        width,
        beginMs: emphasisGroup.beginMs,
        endMs: emphasisGroup.endMs,
        characterClass,
        graphemeCount,
        featherAdjustment,
      });
      continue;
    }

    const aggregate = bindings[existingIndex];
    if (!aggregate) continue;
    const left = Math.min(aggregate.offset, offset);
    const right = Math.max(
      aggregate.offset + aggregate.width,
      offset + width,
    );
    aggregate.offset = left;
    aggregate.width = right - left;
  }

  return Object.freeze(bindings.map((binding) => Object.freeze(binding)));
}

type HanKanaCompletionMode = "authored-gap" | "visual-line-terminal";

function resolveHanKanaCompletionMode(
  track: TrackRecord,
  binding: BindingDom,
  visualLine: KaraokeVisualLineGeometry,
): HanKanaCompletionMode | null {
  const wordPlan = binding.wordPlan;
  if (
    track.lane !== "top" ||
    binding.scriptClass !== "han-kana" ||
    !binding.plan.timed
  ) {
    return null;
  }
  const terminalBinding = visualLine.bindings[visualLine.bindings.length - 1];
  if (
    terminalBinding?.bindingId === binding.plan.id &&
    binding.letterNumberGraphemeCount === 1
  ) {
    return "visual-line-terminal";
  }
  if (wordPlan && binding.plan.unitIndex === binding.plan.unitCount - 1) {
    const nextWord = track.compilation.wordPlans[wordPlan.wordIndex + 1];
    if (nextWord?.spaceBefore && nextWord.beginMs > wordPlan.endMs) {
      return "authored-gap";
    }
  }
  return null;
}

function createVisualLinePaintPlan(
  track: TrackRecord,
  visualLine: KaraokeVisualLineGeometry,
): VisualLinePaintPlan {
  const timedBindings = createVisualLineSweepBindings(track, visualLine);
  let maxBindingEndMs: number | null = null;
  for (const binding of timedBindings) {
    maxBindingEndMs =
      maxBindingEndMs === null
        ? binding.endMs
        : Math.max(maxBindingEndMs, binding.endMs);
  }
  const bindings = Object.freeze(
    visualLine.bindings.flatMap((geometry): VisualLineBindingPlan[] => {
      const binding = track.bindings.get(geometry.bindingId);
      if (!binding) return [];
      const beginMs = finiteTimestamp(binding.plan.beginMs);
      const endMs = finiteTimestamp(binding.plan.endMs);
      const completionMode = resolveHanKanaCompletionMode(
        track,
        binding,
        visualLine,
      );
      const completionSweepBinding =
        beginMs !== null && endMs !== null && completionMode !== null
          ? Object.freeze({
              bindingId: binding.plan.id,
              offset: geometry.offset,
              width: geometry.width,
              beginMs,
              endMs,
              characterClass: "han-kana" as const,
              graphemeCount: binding.letterNumberGraphemeCount,
            })
          : null;
      return [
        Object.freeze({
          geometry,
          binding,
          completionMode,
          completionSweepBinding,
        }),
      ];
    }),
  );
  return Object.freeze({ timedBindings, maxBindingEndMs, bindings });
}

function getVisualLinePaintPlan(
  track: TrackRecord,
  visualLine: KaraokeVisualLineGeometry,
): VisualLinePaintPlan {
  const current = track.visualLinePlans.get(visualLine);
  if (current) return current;
  const plan = createVisualLinePaintPlan(track, visualLine);
  track.visualLinePlans.set(visualLine, plan);
  return plan;
}

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function trackKey(lineId: string, trackName: KaraokeTrackName): string {
  return `${lineId}\u0000${trackName}`;
}

function emphasisLaneForTrack(
  trackName: KaraokeTrackName,
): KaraokeEmphasisLane {
  switch (trackName) {
    case "foreground":
      return "foreground-primary";
    case "foregroundPronunciation":
      return "foreground-pronunciation";
    case "background":
      return "background-primary";
    case "backgroundPronunciation":
      return "background-pronunciation";
    default: {
      const exhaustiveTrackName: never = trackName;
      return exhaustiveTrackName;
    }
  }
}

function glowPaintProfileForTrack(
  trackName: KaraokeTrackName,
): KaraokeGlowPaintProfile {
  return trackName === "background" || trackName === "backgroundPronunciation"
    ? backgroundGlowPaintProfile
    : foregroundGlowPaintProfile;
}

function laneForTrack(trackName: KaraokeTrackName): KaraokeLane {
  return trackName === "foregroundPronunciation" ||
    trackName === "backgroundPronunciation"
    ? "bottom"
    : "top";
}

function normalizeTrackNames(
  trackNames: readonly SyncedPaintTrackName[] | undefined,
): readonly KaraokeTrackName[] {
  const source = trackNames ?? foregroundTrackNames;
  const unique = new Set<KaraokeTrackName>();
  for (const trackName of source) {
    if (!supportedTrackNames.has(trackName)) {
      throw new TypeError(`Unsupported karaoke track name: ${String(trackName)}`);
    }
    unique.add(trackName);
  }
  return Object.freeze([...unique]);
}

function sweepDirectionForTrack(track: LyricTrack): KaraokeSweepDirection {
  return resolveLyricDirection({
    text: track.text,
    languageTag: track.language.effective,
  }).direction === "rtl"
    ? "reverse"
    : "forward";
}

function classifyScript(text: string): KaraokeScriptClass {
  let hasHanOrKana = false;
  let hasLatin = false;
  for (const grapheme of segmentKaraokeGraphemes(text)) {
    const script = classifyKaraokeGrapheme(grapheme);
    if (script === "han" || script === "hiragana" || script === "katakana") {
      hasHanOrKana = true;
      continue;
    }
    if (script === "hangul") return "other";
    if (letterPattern.test(grapheme)) {
      if (!latinScriptPattern.test(grapheme)) return "other";
      hasLatin = true;
      continue;
    }
    if (numberPattern.test(grapheme)) hasLatin = true;
  }
  if (hasHanOrKana && hasLatin) return "other";
  return hasHanOrKana ? "han-kana" : hasLatin ? "latin" : "other";
}

function containsHanOrKana(text: string): boolean {
  return segmentKaraokeGraphemes(text).some((grapheme) => {
    const script = classifyKaraokeGrapheme(grapheme);
    return (
      script === "han" || script === "hiragana" || script === "katakana"
    );
  });
}

function compileDocumentTracks(
  document: LyricDocument,
  selectedTrackNames: readonly KaraokeTrackName[],
): readonly CompiledTrack[] {
  const tracks: CompiledTrack[] = [];
  for (const sourceLine of document.lines) {
    if (sourceLine.type !== "karaoke" || sourceLine.tracks === null) continue;
    const line = sourceLine;
    for (const trackName of selectedTrackNames) {
      const track = line.tracks[trackName];
      if (!track) continue;
      const lane = laneForTrack(trackName);
      tracks.push({
        line,
        trackName,
        lane,
        track,
        compilation: compileKaraokeBindingGroups({
          track,
          trackName,
          lane,
        }),
      });
    }
  }
  return Object.freeze(tracks);
}

function resolveCompiledTracks(
  compiled: readonly CompiledTrack[],
  resolvePaintHost: KaraokeRendererOptions["resolvePaintHost"],
): readonly ResolvedTrack[] {
  const resolved: ResolvedTrack[] = [];
  for (const track of compiled) {
    // Invalid/untimed compilations remain owned by the line renderer so their
    // active tone does not get replaced by an empty karaoke mask.
    if (!track.compilation.ok) continue;
    const host = resolvePaintHost(track.line.id);
    const hostElement = host?.getTrackElement(track.trackName) ?? null;
    if (!host || !hostElement) {
      throw new Error(
        `Missing synchronized paint host for ${track.line.id}/${track.trackName}`,
      );
    }
    resolved.push({
      ...track,
      host,
      hostElement,
      direction: sweepDirectionForTrack(track.track),
    });
  }
  return Object.freeze(resolved);
}

function appendSpaceBefore(
  parent: Node,
  ownerDocument: Document,
  wordPlan: KaraokeWordBindingPlan,
): void {
  if (wordPlan.wordIndex > 0 && wordPlan.spaceBefore) {
    parent.appendChild(ownerDocument.createTextNode(" "));
  }
}

function createBindingElement(
  ownerDocument: Document,
  plan: KaraokeTextBinding,
): HTMLElement {
  const element = ownerDocument.createElement("span");
  element.className = "am-lp-karaoke-binding";
  element.dataset.bindingId = plan.id;
  element.dataset.bindingText = plan.text;
  element.dataset.wordId = plan.wordId ?? "";
  element.dataset.timed = String(plan.timed);
  element.dataset.unitIndex = String(plan.unitIndex);
  element.dataset.unitCount = String(plan.unitCount);
  element.dir = "auto";
  element.textContent = plan.text;
  return element;
}

function createWordElement(
  ownerDocument: Document,
  wordPlan: KaraokeWordBindingPlan,
  bindings: Map<string, BindingDom>,
): HTMLElement {
  const word = ownerDocument.createElement("span");
  word.className = "am-lp-karaoke-word";
  word.dataset.wordId = wordPlan.wordId;
  word.dataset.unitStrategy = wordPlan.strategy;
  word.dataset.emphasisGroupId = wordPlan.visualEmphasisGroup.id;
  word.dataset.emphasisGroupSource = wordPlan.visualEmphasisGroup.source;
  word.dataset.characterWrap = String(
    wordPlan.strategy === "split-cjk-graphemes" &&
      wordPlan.bindings.length > 1,
  );
  const emphasisGroup = wordPlan.visualEmphasisGroup;
  const emphasisScriptClass = classifyScript(emphasisGroup.text);
  const emphasisContainsHanOrKana = containsHanOrKana(emphasisGroup.text);

  wordPlan.bindings.forEach((bindingPlan, bindingIndex) => {
    const binding = createBindingElement(ownerDocument, bindingPlan);
    const letterNumberGraphemeCount = countLetterOrNumberGraphemes(
      bindingPlan.text,
    );
    const scriptClass = classifyScript(bindingPlan.text);
    const emphasisBindingIndex =
      emphasisGroup.bindingOffset + bindingIndex;
    binding.dataset.scriptClass = scriptClass;
    binding.dataset.emphasisGroupId = emphasisGroup.id;
    binding.dataset.emphasisBindingIndex = String(emphasisBindingIndex);
    binding.dataset.emphasisBindingCount = String(emphasisGroup.bindingCount);
    word.append(binding);
    bindings.set(bindingPlan.id, {
      plan: bindingPlan,
      element: binding,
      wordPlan,
      scriptClass,
      letterNumberGraphemeCount,
      emphasisGroup,
      emphasisBindingIndex,
      emphasisBindingCount: emphasisGroup.bindingCount,
      emphasisScriptClass,
      emphasisContainsHanOrKana,
      emphasisLetterNumberCount: emphasisGroup.letterOrNumberCount,
      paintCache: createBindingPaintCache(),
      emphasisPivotYPx: null,
    });
  });
  return word;
}

function buildTimedTrack(
  ownerDocument: Document,
  resolved: ResolvedTrack,
): BuiltTrack {
  const root = ownerDocument.createElement("span");
  root.className = "am-lp-karaoke-track";
  root.dataset.trackName = resolved.trackName;
  root.dataset.voice = resolved.trackName.startsWith("background")
    ? "background"
    : "foreground";
  root.dataset.lane = resolved.lane;
  root.dataset.signature = resolved.compilation.signature;
  root.dataset.sweepDirection = resolved.direction;
  root.lang = resolved.track.language.effective;
  root.dir = resolved.direction === "reverse" ? "rtl" : "ltr";
  root.setAttribute("aria-hidden", "true");
  const bindings = new Map<string, BindingDom>();

  if (!resolved.compilation.ok) {
    const bindingPlan = resolved.compilation.flatBindings[0];
    if (bindingPlan) {
      const binding = createBindingElement(ownerDocument, bindingPlan);
      const letterNumberGraphemeCount = countLetterOrNumberGraphemes(
        bindingPlan.text,
      );
      const scriptClass = classifyScript(bindingPlan.text);
      binding.dataset.scriptClass = scriptClass;
      root.append(binding);
      bindings.set(bindingPlan.id, {
        plan: bindingPlan,
        element: binding,
        wordPlan: null,
        scriptClass,
        letterNumberGraphemeCount,
        emphasisGroup: null,
        emphasisBindingIndex: 0,
        emphasisBindingCount: 1,
        emphasisScriptClass: classifyScript(bindingPlan.text),
        emphasisContainsHanOrKana: containsHanOrKana(bindingPlan.text),
        emphasisLetterNumberCount: letterNumberGraphemeCount,
        paintCache: createBindingPaintCache(),
        emphasisPivotYPx: null,
      });
    }
  } else {
    const joinContainers = new Map<string, HTMLElement>();
    for (const wordPlan of resolved.compilation.wordPlans) {
      const word = createWordElement(ownerDocument, wordPlan, bindings);
      const joinGroupId = wordPlan.parserJoinGroup?.id ?? null;
      if (!joinGroupId) {
        appendSpaceBefore(root, ownerDocument, wordPlan);
        root.append(word);
        continue;
      }

      let group = joinContainers.get(joinGroupId);
      if (!group) {
        appendSpaceBefore(root, ownerDocument, wordPlan);
        group = ownerDocument.createElement("span");
        group.className = "am-lp-karaoke-group";
        group.dataset.parserJoinGroupId = joinGroupId;
        joinContainers.set(joinGroupId, group);
        root.append(group);
      }
      group.append(word);
    }
  }

  if (root.textContent !== resolved.track.text) {
    throw new Error(
      `Karaoke DOM text mismatch for ${resolved.line.id}/${resolved.trackName}`,
    );
  }
  return { root, bindings };
}

function fallbackBindingWeight(binding: KaraokeTextBinding): number {
  return Math.max(1, Array.from(binding.text).length);
}

function createFallbackLayout(
  compilation: KaraokeTrackBindingCompilation,
): KaraokeMaskLayout {
  const totalWeight = Math.max(
    1,
    compilation.flatBindings.reduce(
      (total, binding) => total + fallbackBindingWeight(binding),
      0,
    ),
  );
  let left = 0;
  const rects = compilation.flatBindings.map((binding) => {
    const width = fallbackBindingWeight(binding);
    const rect = {
      bindingId: binding.id,
      left,
      top: 0,
      width,
      height: 1,
    };
    left += width;
    return rect;
  });
  return createKaraokeMaskLayout(rects, {
    containerLeft: 0,
    containerWidth: totalWeight,
  });
}

function createLinePaintState(): LinePaintState {
  return {
    active: false,
    effectOwned: false,
    initialized: false,
    mix: 0,
    transition: null,
  };
}

function transitionProgress(
  transition: LineMixTransition,
  positionMs: number,
): number {
  return alphaTransitionEase(
    (positionMs - transition.startMs - transition.delayMs) /
      Math.max(1, transition.durationMs),
    transition.linear,
  );
}

function sampleTransition(
  transition: LineMixTransition,
  positionMs: number,
): number {
  const progress = transitionProgress(transition, positionMs);
  return transition.from + (transition.to - transition.from) * progress;
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

/**
 * Default karaoke mix ease (easeOutSine-ish). Line-timed uses linear instead
 * (see sampleTransition with linear flag via duration path in line mode —
 * we apply linear for short line-timed ramps by using identity ease when
 * duration ≤ 100ms matching CSS --am-lp-curve-alpha: linear).
 */
function alphaTransitionEase(progress: number, linear = false): number {
  const x = clampUnit(progress);
  if (linear || x === 0 || x === 1) return x;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 14; iteration += 1) {
    const midpoint = (low + high) * 0.5;
    if (cubicCoordinate(midpoint, 0.39, 0.565) < x) low = midpoint;
    else high = midpoint;
  }
  return cubicCoordinate((low + high) * 0.5, 0.575, 1);
}

function resetBindingPaint(binding: BindingDom): void {
  setBindingClass(binding, "motionActive", false);
  setBindingClass(binding, "glowActive", false);
  binding.paintCache.styleValues.fill(undefined);
  binding.paintCache.datasetValues = {};
  delete binding.element.dataset.glowMaskAlphas;
  delete binding.element.dataset.glowLayerAlphas;
  setBindingStyle(binding, BindingStyleSlot.LineMix, "0");
  setBindingStyle(binding, BindingStyleSlot.MaskWidth, "100%");
  setBindingStyle(binding, BindingStyleSlot.MaskOffsetX, "0px");
  setBindingStyle(binding, BindingStyleSlot.MaskAlphaA, "0");
  setBindingStyle(binding, BindingStyleSlot.MaskAlphaB, "0");
  setBindingStyle(binding, BindingStyleSlot.MaskAlphaC, "0");
  setBindingStyle(binding, BindingStyleSlot.MaskAlphaD, "0");
  setBindingStyle(binding, BindingStyleSlot.StopB, "0");
  setBindingStyle(binding, BindingStyleSlot.StopC, "1");
  setBindingStyle(binding, BindingStyleSlot.GlowMaskAlphaA, "0");
  setBindingStyle(binding, BindingStyleSlot.GlowMaskAlphaB, "0");
  setBindingStyle(binding, BindingStyleSlot.GlowMaskAlphaC, "0");
  setBindingStyle(binding, BindingStyleSlot.GlowMaskAlphaD, "0");
  setBindingStyle(binding, BindingStyleSlot.GlowStopB, "0");
  setBindingStyle(binding, BindingStyleSlot.GlowStopC, "1");
  setBindingStyle(binding, BindingStyleSlot.GlowMaskWidth, "100%");
  setBindingStyle(binding, BindingStyleSlot.GlowMaskOffsetX, "0px");
  setBindingStyle(binding, BindingStyleSlot.LiftY, "0px");
  setBindingStyle(binding, BindingStyleSlot.EmphasisScale, "1");
  setBindingStyle(binding, BindingStyleSlot.EmphasisSpreadX, "0px");
  setBindingStyle(binding, BindingStyleSlot.EmphasisPivotY, "100%");
  setBindingStyle(binding, BindingStyleSlot.GlowOpacity, "0");
  setBindingStyle(binding, BindingStyleSlot.GlowAlphaCore, "0");
  setBindingStyle(binding, BindingStyleSlot.GlowAlphaMid, "0");
  setBindingStyle(binding, BindingStyleSlot.GlowAlphaOuter, "0");
  setBindingStyle(binding, BindingStyleSlot.GlowAlphaBloom, "0");
  setBindingDataset(binding, "sweepPhase", "empty");
  setBindingDataset(binding, "liftPhase", "idle");
  setBindingDataset(binding, "emphasisPhase", "ineligible");
  setBindingDataset(binding, "glowMaskPhase", "none");
}

function absoluteLayoutOffset(element: HTMLElement): {
  readonly left: number;
  readonly top: number;
} {
  let left = 0;
  let top = 0;
  let current: HTMLElement | null = element;
  while (current) {
    left += current.offsetLeft;
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return { left, top };
}

class KaraokeRendererImpl implements KaraokeRenderer {
  readonly #resolvePaintHost: KaraokeRendererOptions["resolvePaintHost"];
  readonly #trackNames: readonly KaraokeTrackName[];
  readonly #now: () => number;
  #documentId: string | null = null;
  #paintMode: KaraokePaintMode = "karaoke";
  #displayModeTransition = createDisplayModeTransitionState("karaoke");
  #displayModeSampleMs: number | null = null;
  /** Keep morphing paint mode while paused (playback frame loop is idle). */
  #displayModeMorphFrame: number | null = null;
  #rows = new Map<string, RowRecord>();
  #tracksByRoot = new Map<HTMLElement, TrackRecord>();
  #featherContainerWidths = new Map<HTMLElement, number>();
  #liftStates = new Map<string, KaraokeLiftState>();
  #transientLineIds = new Set<string>();
  #effectTailLineIds = new Set<string>();
  #resizeObserver: ResizeObserver | null = null;
  #measurementDocument: Document | null = null;
  #fontSet: FontFaceSet | null = null;
  #textMetricsContext: CanvasRenderingContext2D | null = null;
  #lastFrame: PlaybackFrame | null = null;
  #lastOptions: KaraokeRenderOptions = {};
  #lastLiftSampleAtMs: number | null = null;
  #fallbackTrackCount = 0;
  #active: boolean;
  #geometryDirty = false;
  #destroyed = false;

  readonly #fontLoadListener = (): void => {
    if (this.#destroyed) return;
    if (!this.#active) {
      this.#geometryDirty = true;
      return;
    }
    const changed = this.#measureTracks([...this.#tracksByRoot.values()]);
    if (changed) this.#repaintLastFrame();
  };

  constructor(options: KaraokeRendererOptions) {
    this.#resolvePaintHost = options.resolvePaintHost;
    this.#trackNames = normalizeTrackNames(options.trackNames);
    this.#active = options.active ?? true;
    this.#now =
      options.now ??
      (() => globalThis.performance?.now() ?? Date.now());
  }

  setActive(active: boolean): void {
    this.#assertAlive();
    if (this.#active === active) return;
    this.#active = active;
    if (!active) {
      this.#lastLiftSampleAtMs = null;
      this.#cancelDisplayModeMorphLoop();
      this.#displayModeTransition = requestDisplayModeTransition(
        this.#displayModeTransition,
        this.#paintMode,
        { animate: false },
      );
      this.#displayModeSampleMs = null;
      this.#syncPaintModeDataset();
      return;
    }
    const shouldMeasure =
      this.#geometryDirty || this.#tracksByRoot.size > 0;
    this.#geometryDirty = false;
    if (shouldMeasure) {
      this.#measureTracks([...this.#tracksByRoot.values()]);
    }
    this.#repaintLastFrame();
  }

  setDocument(document: LyricDocument | null): void {
    this.#assertAlive();
    if (!document) {
      const errors: unknown[] = [];
      try {
        this.#detachMeasurementEnvironment();
      } catch (error) {
        errors.push(error);
      }
      try {
        this.#releaseAllTracks();
      } catch (error) {
        errors.push(error);
      }
      this.#clearDocumentState();
      throwCollectedErrors(errors, "Karaoke document cleanup failed");
      return;
    }

    // Compile and resolve every track before touching live DOM.
    const compiled = compileDocumentTracks(document, this.#trackNames);
    const fallbackTrackCount = compiled.filter(
      ({ compilation }) => !compilation.ok,
    ).length;
    const currentTracksByKey = new Map<string, LyricTrack>();
    for (const line of document.lines) {
      if (line.tracks === null) continue;
      for (const trackName of this.#trackNames) {
        const track = line.tracks[trackName];
        if (!track) continue;
        currentTracksByKey.set(
          trackKey(line.id, trackName),
          track,
        );
      }
    }
    const resolved = resolveCompiledTracks(compiled, this.#resolvePaintHost);
    const ownerDocument = resolved[0]?.hostElement.ownerDocument ?? null;
    for (const track of resolved) {
      if (ownerDocument && track.hostElement.ownerDocument !== ownerDocument) {
        throw new Error("A karaoke renderer cannot span multiple documents");
      }
    }

    const previousDocumentId = this.#documentId;
    const previousTracks = new Map<string, TrackRecord>();
    for (const row of this.#rows.values()) {
      for (const [trackName, track] of row.tracks) {
        previousTracks.set(trackKey(row.line.id, trackName), track);
      }
    }

    const prepared = resolved.map((track) => {
      const key = trackKey(track.line.id, track.trackName);
      const previous = previousTracks.get(key);
      const reusable =
        previous?.compilation.signature === track.compilation.signature &&
        previous.root.ownerDocument === track.hostElement.ownerDocument;
      const built = reusable
        ? { root: previous.root, bindings: previous.bindings }
        : buildTimedTrack(track.hostElement.ownerDocument, track);
      const keepMeasuredLayout =
        reusable &&
        previous.hostElement === track.hostElement &&
        previous.layoutSource === "measured";
      const record: TrackRecord = {
        ...track,
        ...built,
        layout: keepMeasuredLayout
          ? previous.layout
          : createFallbackLayout(track.compilation),
        layoutSource: keepMeasuredLayout ? "measured" : "fallback",
        featherReferenceWidth: keepMeasuredLayout
          ? previous.featherReferenceWidth
          : Math.max(1, built.root.clientWidth),
        visualLinePlans: new WeakMap(),
      };
      return { key, previous, record, reusable };
    });

    const nextTracksByKey = new Map(
      prepared.map(({ key, record }) => [key, record] as const),
    );
    for (const [key, previous] of previousTracks) {
      const next = nextTracksByKey.get(key);
      if (!next || next.host !== previous.host) {
        const currentTrack = currentTracksByKey.get(key) ?? previous.track;
        previous.host.releaseTrackElement(
          previous.trackName,
          currentTrack.text,
          currentTrack.language.effective,
        );
      }
    }

    for (const { previous, record } of prepared) {
      const hostElement = record.host.claimTrackElement(
        record.trackName,
        "karaoke",
      );
      if (!hostElement) {
        throw new Error(
          `Paint host disappeared for ${record.line.id}/${record.trackName}`,
        );
      }
      if (hostElement !== record.hostElement) {
        throw new Error(
          `Paint host changed while claiming ${record.line.id}/${record.trackName}`,
        );
      }
      hostElement.lang = record.track.language.effective;
      hostElement.dir = "auto";
      hostElement.setAttribute("aria-label", record.track.text);
      record.root.dataset.paintMode = this.#paintMode;
      if (
        previous?.root !== record.root ||
        previous.hostElement !== hostElement ||
        hostElement.firstChild !== record.root ||
        hostElement.childNodes.length !== 1
      ) {
        hostElement.replaceChildren(record.root);
      }
    }

    const nextRows = new Map<string, RowRecord>();
    for (const { record } of prepared) {
      const current = nextRows.get(record.line.id);
      const tracks = new Map(current?.tracks ?? []);
      tracks.set(record.trackName, record);
      const previousRow = this.#rows.get(record.line.id);
      nextRows.set(record.line.id, {
        line: record.line,
        tracks,
        linePaint:
          previousDocumentId === document.id && previousRow
            ? previousRow.linePaint
            : createLinePaintState(),
      });
    }

    this.#rows = nextRows;
    this.#documentId = document.id;
    this.#fallbackTrackCount = fallbackTrackCount;
    if (previousDocumentId !== document.id) {
      this.#liftStates.clear();
      this.#transientLineIds.clear();
      this.#effectTailLineIds.clear();
      this.#lastFrame = null;
      this.#lastLiftSampleAtMs = null;
      this.#displayModeTransition = createDisplayModeTransitionState(
        this.#paintMode,
      );
      this.#displayModeSampleMs = null;
    }
    const liveBindingIds = new Set<string>();
    for (const row of nextRows.values()) {
      for (const track of row.tracks.values()) {
        for (const bindingId of track.bindings.keys()) liveBindingIds.add(bindingId);
      }
    }
    for (const bindingId of this.#liftStates.keys()) {
      if (!liveBindingIds.has(bindingId)) this.#liftStates.delete(bindingId);
    }
    for (const { record, reusable } of prepared) {
      if (reusable) continue;
      for (const bindingId of record.bindings.keys()) {
        this.#liftStates.delete(bindingId);
      }
    }
    for (const lineId of this.#transientLineIds) {
      if (!nextRows.has(lineId)) this.#transientLineIds.delete(lineId);
    }
    for (const lineId of this.#effectTailLineIds) {
      if (!nextRows.has(lineId)) this.#effectTailLineIds.delete(lineId);
    }
    this.#installMeasurementEnvironment(ownerDocument);
    this.#observeCurrentTracks();
    if (this.#active) {
      this.#measureTracks([...this.#tracksByRoot.values()]);
    } else {
      this.#geometryDirty = true;
    }
  }

  setPaintMode(
    mode: KaraokePaintMode,
    options: KaraokePaintModeOptions = {},
  ): void {
    this.#assertAlive();
    if (mode === this.#paintMode && !this.#displayModeTransition.running) return;
    // Morph karaoke ↔ line even while paused: wall-clock advances the mix.
    // Requiring `playing` made mode switches snap (free-run pause / lag).
    this.#displayModeTransition = requestDisplayModeTransition(
      this.#displayModeTransition,
      mode,
      {
        animate:
          this.#active &&
          options.animate === true &&
          options.reducedMotion !== true,
        ...(options.durationMs !== undefined
          ? { durationMs: options.durationMs }
          : {}),
      },
    );
    this.#displayModeSampleMs = this.#displayModeTransition.running
      ? this.#now()
      : null;
    this.#paintMode = mode;
    this.#syncPaintModeDataset();
    if (mode === "line" && !this.#displayModeTransition.running) {
      // Fully settled on line-timed paint: drop residual karaoke springs.
      this.#liftStates.clear();
    }
    if (this.#active) {
      this.#repaintLastFrame();
      this.#ensureDisplayModeMorphLoop();
    }
  }

  hasGeometryObserver(): boolean {
    return this.#resizeObserver !== null;
  }

  invalidateGeometry(lineIds?: readonly string[]): void {
    this.#assertAlive();
    if (!this.#active) {
      this.#geometryDirty = true;
      return;
    }
    const selectedLineIds = lineIds ? new Set(lineIds) : null;
    const tracks = [...this.#tracksByRoot.values()].filter(
      (track) => !selectedLineIds || selectedLineIds.has(track.line.id),
    );
    this.#measureTracks(tracks);
    this.#repaintLastFrame();
  }

  renderFrame(
    frame: PlaybackFrame,
    options: KaraokeRenderOptions = {},
  ): void {
    this.#assertAlive();
    if (frame.documentId !== this.#documentId) return;
    this.#lastFrame = frame;
    this.#lastOptions = { ...options };
    if (!this.#active) return;
    this.#renderFrame(frame, options, false);
  }

  resetPlaybackState(): void {
    this.#assertAlive();
    this.#liftStates.clear();
    this.#transientLineIds.clear();
    this.#effectTailLineIds.clear();
    this.#lastFrame = null;
    this.#lastLiftSampleAtMs = null;
    for (const row of this.#rows.values()) {
      Object.assign(row.linePaint, createLinePaintState());
      for (const track of row.tracks.values()) {
        for (const binding of track.bindings.values()) {
          resetBindingPaint(binding);
        }
      }
    }
  }

  getDisplayModeTransitionState(): DisplayModeTransitionState {
    return this.#displayModeTransition;
  }

  getTrackCount(): number {
    return this.#tracksByRoot.size;
  }

  getFallbackTrackCount(): number {
    return this.#fallbackTrackCount;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#cancelDisplayModeMorphLoop();
    const errors: unknown[] = [];
    try {
      this.#detachMeasurementEnvironment();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#releaseAllTracks();
    } catch (error) {
      errors.push(error);
    }
    this.#clearDocumentState();
    throwCollectedErrors(errors, "Karaoke renderer cleanup failed");
  }

  #renderFrame(
    frame: PlaybackFrame,
    options: KaraokeRenderOptions,
    forceCurrentRows: boolean,
  ): void {
    if (frame.mode === "reset" || frame.mode === "recycle") {
      this.#liftStates.clear();
      this.#transientLineIds.clear();
      this.#effectTailLineIds.clear();
    }
    const liftSampleAtMs = this.#now();
    // Native word lift is a display-frame spring. Playback time only triggers
    // a binding; it must not quantize the spring's continuous motion.
    const deltaMs =
      frame.mode === "playback" &&
      options.playing !== false &&
      this.#lastLiftSampleAtMs !== null &&
      Number.isFinite(liftSampleAtMs)
        ? Math.max(0, liftSampleAtMs - this.#lastLiftSampleAtMs)
        : 0;
    const lineTimedMix =
      this.#paintMode === "line" || this.#displayModeTransition.lineMix > 0.5;
    const context: PaintContext = {
      frame,
      deltaMs,
      reducedMotion: options.reducedMotion === true,
      playing: options.playing !== false,
      paintSuppressedLineIds: options.paintSuppressedLineIds ?? new Set(),
      visualPrimaryLineIds: options.visualPrimaryLineIds ?? null,
      alphaDurationMs:
        typeof options.alphaDurationMs === "number"
        && Number.isFinite(options.alphaDurationMs)
        && options.alphaDurationMs > 0
          ? options.alphaDurationMs
          : null,
      alphaDelayMs:
        typeof options.alphaDelayMs === "number"
        && Number.isFinite(options.alphaDelayMs)
        && options.alphaDelayMs >= 0
          ? options.alphaDelayMs
          : 0,
      alphaTimingLineIds: options.alphaTimingLineIds ?? null,
      lineTimedMix,
    };
    this.#advanceDisplayModeTransition();
    // While morphing paint mode, every row must repaint — partial sets leave
    // off-screen lines on the old karaoke sweep until they re-enter, which
    // reads as a hard fill/scale jump.
    const paintAllRows =
      forceCurrentRows
      || this.#displayModeTransition.running
      || lineTimedMix;
    const lineIds = this.#selectLinesToPaint(frame, paintAllRows);
    for (const lineId of lineIds) {
      const row = this.#rows.get(lineId);
      if (!row) continue;
      const linePaint = this.#sampleLinePaint(row, context);
      for (const track of row.tracks.values()) {
        this.#paintTrack(track, linePaint, context);
      }
    }
    this.#lastLiftSampleAtMs = Number.isFinite(liftSampleAtMs)
      ? liftSampleAtMs
      : null;
  }

  #selectLinesToPaint(
    frame: PlaybackFrame,
    forceCurrentRows: boolean,
  ): ReadonlySet<string> {
    if (frame.mode !== "playback" || forceCurrentRows) {
      return new Set(this.#rows.keys());
    }
    const lineIds = new Set<string>([
      ...frame.activeLineIds,
      ...frame.concurrentPrimaryTailLineIds,
      ...frame.previousActiveLineIds,
      ...frame.previousConcurrentPrimaryTailLineIdsInSourceOrder,
      ...frame.enteredLineIds,
      ...frame.exitedLineIds,
      ...this.#transientLineIds,
      ...this.#effectTailLineIds,
    ]);
    return lineIds;
  }

  #sampleLinePaint(
    row: RowRecord,
    context: PaintContext,
  ): LinePaintSample {
    const state = row.linePaint;
    const suppressed = context.paintSuppressedLineIds.has(row.line.id);
    const trueActive =
      !suppressed &&
      context.frame.activeLineIds.has(row.line.id);
    const concurrentPrimaryTail =
      !suppressed &&
      context.frame.concurrentPrimaryTailLineIds.has(row.line.id);
    // Match line-timed: motion primary (pre-anchor handoff) lights fill early.
    const motionPrimary = context.visualPrimaryLineIds;
    const isTimePrimary = trueActive || concurrentPrimaryTail;
    const active = !suppressed && (
      motionPrimary
        ? motionPrimary.has(row.line.id)
        : isTimePrimary
    );
    const positionMs = context.frame.playbackPositionMs;
    const effectPositionMs = context.frame.wordPlaybackPositionMs;
    const direct =
      context.frame.mode !== "playback" || context.reducedMotion || suppressed;
    const lineBeginMs = finiteTimestamp(row.line.begin.valueMs);
    const lineEndMs = finiteTimestamp(row.line.end.valueMs);
    if (direct) {
      state.effectOwned = trueActive;
    } else if (trueActive) {
      state.effectOwned = true;
    } else if (
      state.effectOwned &&
      lineBeginMs !== null &&
      lineEndMs !== null &&
      effectPositionMs >= lineBeginMs &&
      effectPositionMs < lineEndMs + POST_END_EFFECT_TAIL_MS
    ) {
      state.effectOwned = true;
    } else {
      state.effectOwned = false;
    }
    const effectTailOwned = state.effectOwned && !trueActive;
    if (effectTailOwned) this.#effectTailLineIds.add(row.line.id);
    else this.#effectTailLineIds.delete(row.line.id);

    if (direct) {
      state.active = active;
      state.initialized = true;
      state.mix = active ? 1 : 0;
      state.transition = null;
      this.#transientLineIds.delete(row.line.id);
      return Object.freeze({
        active,
        trueActive,
        effectOwned: state.effectOwned,
        effectTailOwned,
        primaryMix: state.mix,
        effectVisibility: state.effectOwned ? 1 : 0,
        glowEnvelope: active ? 1 : 0,
      });
    }

    if (!state.initialized) {
      state.initialized = true;
      state.active = active;
      state.mix = active ? 1 : 0;
      state.transition = null;
      this.#transientLineIds.delete(row.line.id);
    }
    if (
      state.active !== active ||
      (active && state.mix === 0 && !state.transition)
    ) {
      if (state.transition) {
        state.mix = sampleTransition(state.transition, positionMs);
      }
      state.active = active;
      const targetMix = active ? 1 : 0;
      if (Math.abs(state.mix - targetMix) < 0.00001) {
        state.mix = targetMix;
        state.transition = null;
        this.#transientLineIds.delete(row.line.id);
      } else {
        // Native line-timed: short linear fill (CSS 75+75). Karaoke word mode
        // keeps 250/350. Mid-move handoff can override duration/delay.
        const alphaTimingAllowed =
          !context.alphaTimingLineIds
          || context.alphaTimingLineIds.has(row.line.id);
        const useMidMove =
          context.lineTimedMix
          && alphaTimingAllowed
          && context.alphaDurationMs !== null
          && (active || state.transition?.kind === "deactivate");
        let delayMs: number;
        let durationMs: number;
        if (useMidMove && context.alphaDurationMs !== null) {
          delayMs = active ? context.alphaDelayMs : context.alphaDelayMs;
          durationMs = context.alphaDurationMs;
        } else if (context.lineTimedMix) {
          delayMs = active
            ? LINE_ACTIVATE_MIX_DELAY_MS
            : LINE_DEACTIVATE_MIX_DELAY_MS;
          durationMs = active
            ? LINE_ACTIVATE_MIX_DURATION_MS
            : LINE_DEACTIVATE_MIX_DURATION_MS;
        } else {
          delayMs = active ? 0 : DEACTIVATE_MIX_DELAY_MS;
          durationMs = active
            ? ACTIVATE_MIX_DURATION_MS
            : DEACTIVATE_MIX_DURATION_MS;
        }
        state.transition = {
          kind: active ? "activate" : "deactivate",
          startMs: positionMs,
          delayMs,
          durationMs,
          from: state.mix,
          to: targetMix,
          linear: context.lineTimedMix,
        };
        this.#transientLineIds.add(row.line.id);
      }
    }

    let deactivationProgress = 0;
    if (state.transition) {
      state.mix = sampleTransition(state.transition, positionMs);
      if (state.transition.kind === "deactivate") {
        deactivationProgress = transitionProgress(
          state.transition,
          positionMs,
        );
      }
      const transitionEnd =
        state.transition.startMs +
        state.transition.delayMs +
        state.transition.durationMs;
      if (positionMs >= transitionEnd) {
        state.mix = state.transition.to;
        state.transition = null;
        this.#transientLineIds.delete(row.line.id);
      }
    }
    const deactivating = state.transition?.kind === "deactivate";
    return Object.freeze({
      active: state.active,
      trueActive,
      effectOwned: state.effectOwned,
      effectTailOwned,
      primaryMix: clampUnit(state.mix),
      effectVisibility: state.effectOwned ? 1 : 0,
      glowEnvelope: deactivating
        ? 1 - deactivationProgress
        : state.active
          ? 1
          : 0,
    });
  }

  #paintTrack(
    track: TrackRecord,
    linePaint: LinePaintSample,
    context: PaintContext,
  ): void {
    track.root.dataset.layoutSource = track.layoutSource;
    const concurrentPrimaryTail =
      !context.paintSuppressedLineIds.has(track.line.id) &&
      context.frame.concurrentPrimaryTailLineIds.has(track.line.id);
    // True active set drives lift/glow live ownership. Concurrent tail keeps
    // lift settle alive but does not re-arm a fresh active set.
    const lineActive = linePaint.active;
    track.root.dataset.trueActive = String(linePaint.trueActive);
    track.root.dataset.effectOwned = String(linePaint.effectOwned);
    track.root.dataset.effectTailOwned = String(linePaint.effectTailOwned);
    if (track.root.dataset.concurrentPrimaryTail !== String(concurrentPrimaryTail)) {
      track.root.dataset.concurrentPrimaryTail = String(concurrentPrimaryTail);
    }
    for (const visualLine of track.layout.lines) {
      this.#paintVisualLine(
        track,
        visualLine,
        linePaint,
        lineActive,
        linePaint.trueActive,
        concurrentPrimaryTail,
        context,
      );
    }
  }

  #paintVisualLine(
    track: TrackRecord,
    visualLine: KaraokeVisualLineGeometry,
    linePaint: LinePaintSample,
    lineActive: boolean,
    trueActive: boolean,
    concurrentPrimaryTail: boolean,
    context: PaintContext,
  ): void {
    const visualLinePlan = getVisualLinePaintPlan(track, visualLine);
    const timedBindings = visualLinePlan.timedBindings;
    // Concurrent residual keeps its existing just-past-end sample. An ordinary
    // effect tail must settle the terminal feather before the row fades out.
    const maxBindingEndMs =
      visualLinePlan.maxBindingEndMs ?? context.frame.wordPlaybackPositionMs;
    const fillPositionMs = concurrentPrimaryTail
      ? maxBindingEndMs + 1
      : linePaint.effectTailOwned
        ? maxBindingEndMs + HAN_KANA_TERMINAL_CONTINUATION_MS + 1
        : context.frame.wordPlaybackPositionMs;
    const sweep = createKaraokeSweepState({
      visualLine: {
        lineId: visualLine.lineId,
        width: visualLine.width,
        lane: track.lane,
        bindings: timedBindings,
      },
      positionMs: fillPositionMs,
      direction: track.direction,
      featherReferenceWidth: track.featherReferenceWidth,
    });
    // If the row is no longer fill-primary, force empty masks even if a stale
    // full-sung sweep would otherwise remain under a zero line-mix.
    const suppressPaint =
      linePaint.primaryMix <= 0 && !lineActive && !concurrentPrimaryTail;
    const effectiveSweep =
      suppressPaint
        ? Object.freeze({
            ...sweep,
            stops: Object.freeze([0, 0, 0, 1] as const),
            maskAlphas: Object.freeze([0, 0, 0, 0] as const),
            phase: "idle",
          })
        : sweep;

    const emphasisByBinding = new Map<string, KaraokeEmphasisState>();
    const emphasisBindings = new Map<
      string,
      Array<{
        readonly binding: BindingDom;
        readonly geometry: KaraokeBindingMaskGeometry;
        readonly emphasis: KaraokeEmphasisState;
      }>
    >();
    for (const { geometry, binding } of visualLinePlan.bindings) {
      const emphasis = this.#sampleBindingEmphasis(
        track,
        binding,
        linePaint.effectVisibility,
        context,
      );
      emphasisByBinding.set(binding.plan.id, emphasis);
      const emphasisGroupId = binding.emphasisGroup?.id;
      if (!emphasisGroupId) continue;
      const entries = emphasisBindings.get(emphasisGroupId) ?? [];
      entries.push({ binding, geometry, emphasis });
      emphasisBindings.set(emphasisGroupId, entries);
    }
    const spreadByBinding = new Map<string, number>();
    for (const entries of emphasisBindings.values()) {
      entries.sort(
        (left, right) =>
          left.binding.emphasisBindingIndex -
          right.binding.emphasisBindingIndex,
      );
      const spread = createKaraokeEmphasisSpread(
        entries.map(
          ({ geometry, emphasis }) =>
            (Math.max(1, emphasis.scale) - 1) * geometry.width * 0.5,
        ),
        track.direction,
      );
      entries.forEach(({ binding }, index) => {
        spreadByBinding.set(
          binding.plan.id,
          spread.translationsPx[index] ?? 0,
        );
      });
    }

    // FullWidthAlphaGradientFlexboxLayout owns one cursor per visual mask
    // slot. Fill uses this shared sweep for every binding; word-local lift and
    // emphasis remain independent below.
    for (const bindingPlan of visualLinePlan.bindings) {
      const {
        geometry,
        binding,
        completionMode,
        completionSweepBinding,
      } = bindingPlan;
      const emphasis = emphasisByBinding.get(binding.plan.id);
      if (!emphasis) continue;
      const bindingCompletion =
        !suppressPaint &&
        completionMode !== null &&
        completionSweepBinding !== null
          ? createKaraokeBindingCompletionSweepState({
              lineId: visualLine.lineId,
              lane: track.lane,
              lineWidth: visualLine.width,
              binding: completionSweepBinding,
              positionMs: fillPositionMs,
              direction: track.direction,
              featherPx: effectiveSweep.featherPx,
              ...(completionMode === "visual-line-terminal"
                ? {
                    maxVisualDurationMs:
                      HAN_KANA_SWEEP_MAX_VISUAL_DURATION_MS,
                    maxFeatherGlyphRatio:
                      HAN_KANA_SWEEP_MAX_FEATHER_GLYPH_RATIO,
                  }
                : {}),
            })
          : null;
      const bindingSweep = bindingCompletion ?? effectiveSweep;
      const resolvedCompletionMode =
        bindingCompletion && completionMode ? completionMode : "shared";
      setBindingDataset(
        binding,
        "sweepCompletionMode",
        resolvedCompletionMode,
      );
      this.#paintBinding(
        track,
        binding,
        geometry,
        visualLine,
        bindingSweep.stops,
        bindingSweep.maskAlphas,
        bindingSweep.phase,
        bindingSweep.cursor,
        bindingSweep.featherPx,
        linePaint.primaryMix,
        linePaint.glowEnvelope,
        trueActive,
        emphasis,
        spreadByBinding.get(binding.plan.id) ?? 0,
        context,
      );
    }
  }

  #sampleBindingEmphasis(
    track: TrackRecord,
    binding: BindingDom,
    lineVisibility: number,
    context: PaintContext,
  ): KaraokeEmphasisState {
    const wordPlan = binding.wordPlan;
    const emphasisGroup = binding.emphasisGroup;
    return sampleKaraokeEmphasis({
      bindingId: binding.plan.id,
      groupBeginMs: emphasisGroup?.beginMs ?? wordPlan?.beginMs ?? Number.NaN,
      groupEndMs: emphasisGroup?.endMs ?? wordPlan?.endMs ?? Number.NaN,
      ...(emphasisGroup
        ? { groupDurationMs: emphasisGroup.durationMs }
        : {}),
      bindingIndex: binding.emphasisBindingIndex,
      bindingCount: binding.emphasisBindingCount,
      letterNumberCount: binding.emphasisLetterNumberCount,
      scriptClass: binding.emphasisScriptClass,
      lane: emphasisLaneForTrack(track.trackName),
      playbackPositionMs: context.frame.wordPlaybackPositionMs,
      lineVisibility,
      reducedMotion: context.reducedMotion,
    });
  }

  #paintBinding(
    track: TrackRecord,
    binding: BindingDom,
    geometry: KaraokeBindingMaskGeometry,
    visualLine: KaraokeVisualLineGeometry,
    sweepStops: KaraokeSweepStops,
    sweepAlphas: KaraokeSweepMaskAlphas,
    sweepPhase: string,
    sweepCursorPx: number,
    sweepFeatherPx: number,
    primaryMix: number,
    glowEnvelope: number,
    trueActive: boolean,
    emphasis: KaraokeEmphasisState,
    spreadPx: number,
    context: PaintContext,
  ): void {
    const plan = binding.plan;
    const beginMs = finiteTimestamp(plan.beginMs);
    const endMs = finiteTimestamp(plan.endMs);
    const liftBeginMs =
      emphasis.eligible &&
      binding.emphasisScriptClass === "latin" &&
      binding.emphasisGroup
        ? binding.emphasisGroup.beginMs + emphasis.startDelayMs
        : beginMs;
    const participates = track.lane === "top" && plan.timed;
    const previousLift = this.#liftStates.get(plan.id) ?? null;
    const lift =
      liftBeginMs !== null && endMs !== null
        ? sampleKaraokeLift(previousLift, {
            bindingId: plan.id,
            beginMs: liftBeginMs,
            endMs,
            playbackPositionMs: context.frame.wordPlaybackPositionMs,
            lineActive: trueActive,
            participates,
            frameMode: context.frame.mode,
            deltaMs: context.deltaMs,
            motionProfile:
              binding.scriptClass === "han-kana" ? "han-kana" : "default",
            reducedMotion: context.reducedMotion,
          })
        : createIdleKaraokeLiftState(plan.id);
    this.#liftStates.set(plan.id, lift);

    const paintProfile = glowPaintProfileForTrack(track.trackName);
    const glowMask = createKaraokeGlowMaskState(
      emphasis,
      sweepStops,
      sweepAlphas,
      paintProfile,
    );
    const displayLineMix = this.#displayModeTransition.lineMix;
    const karaokeEffectMix = 1 - displayLineMix;
    const playbackPositionMs = context.frame.wordPlaybackPositionMs;
    const emphasisStartMs = finiteTimestamp(
      binding.emphasisGroup?.beginMs ?? binding.wordPlan?.beginMs ?? null,
    );
    const resolvedEmphasisStartMs =
      emphasisStartMs === null
        ? null
        : emphasisStartMs + emphasis.startDelayMs;
    const effectCanBecomeVisible =
      karaokeEffectMix > BINDING_TRANSFORM_EPSILON ||
      this.#displayModeTransition.targetMode === "karaoke";
    const mayPrewarm =
      !context.reducedMotion &&
      context.playing &&
      context.frame.mode === "playback" &&
      trueActive &&
      effectCanBecomeVisible;
    const liftPrewarming =
      mayPrewarm &&
      participates &&
      isWithinBindingResourcePrewarmWindow(playbackPositionMs, liftBeginMs);
    const emphasisPrewarming =
      mayPrewarm &&
      emphasis.eligible &&
      isWithinBindingResourcePrewarmWindow(
        playbackPositionMs,
        resolvedEmphasisStartMs,
      );
    const baseTransformIsNonIdentity =
      Math.abs(lift.positionPx) > BINDING_TRANSFORM_EPSILON ||
      Math.abs(emphasis.scale - 1) > BINDING_TRANSFORM_EPSILON ||
      Math.abs(spreadPx) > BINDING_TRANSFORM_EPSILON;
    // Promotion follows ACTUAL motion, not the phase label: the lift spring
    // flips to "held" at the word's end time while the transform is still
    // settling (short words spend most of their visible rise there), and
    // demoting mid-motion forces a main-thread re-raster per frame — the
    // "stepped rise" regression after the static-hold demotion fix.
    const liftInMotion =
      lift.phase === "lifting" ||
      Math.abs(lift.positionPx - lift.targetPx) > BINDING_TRANSFORM_EPSILON ||
      Math.abs(lift.velocityPxPerSecond) > BINDING_TRANSFORM_EPSILON;
    const transformIsChanging =
      !context.reducedMotion &&
      context.playing &&
      context.frame.mode === "playback" &&
      karaokeEffectMix > BINDING_TRANSFORM_EPSILON &&
      (liftInMotion ||
        emphasis.phase === "expanding" ||
        emphasis.phase === "reversing");
    const displayModeTransformIsChanging =
      !context.reducedMotion &&
      this.#displayModeTransition.running &&
      baseTransformIsNonIdentity;
    // A "transformed active paint" (word held at peak lift/emphasis) used to
    // pin will-change too. That froze the compositor raster at its promotion
    // scale for the whole hold — Chromium honors the cheap-transform contract
    // by NOT re-rastering will-change:transform layers — so the brightest,
    // most-looked-at word rendered from a stale-scale raster and looked
    // aliased ("no anti-aliasing" user report; roma line worst, small glyphs
    // magnified). Static holds now demote so the glyphs re-raster crisply at
    // their final transform; only genuine motion windows stay promoted.
    const paintStops = sweepStops;
    const paintAlphas: KaraokeSweepMaskAlphas =
      displayLineMix <= 0
        ? sweepAlphas
        : displayLineMix >= 1
          ? solidMask
          : Object.freeze([
              sweepAlphas[0] +
                (solidMask[0] - sweepAlphas[0]) * displayLineMix,
              sweepAlphas[1] +
                (solidMask[1] - sweepAlphas[1]) * displayLineMix,
              sweepAlphas[2] +
                (solidMask[2] - sweepAlphas[2]) * displayLineMix,
              sweepAlphas[3] +
                (solidMask[3] - sweepAlphas[3]) * displayLineMix,
            ]);
    const resolvedPaintAlphas = directPaintAlphas(
      paintAlphas,
      paintProfile,
      primaryMix,
    );
    const measured = track.layoutSource === "measured";
    // Solid fills (future/sung, or line-timed display mix) do not need a
    // pixel line mask. Stale geometry after a font-size upscale was clipping
    // the last glyph of each word ("motio|n", "drear|m").
    const solidLocalMask =
      Math.abs(resolvedPaintAlphas[0] - resolvedPaintAlphas[3]) < 0.02
      && Math.abs(resolvedPaintAlphas[0] - resolvedPaintAlphas[1]) < 0.02
      && Math.abs(resolvedPaintAlphas[2] - resolvedPaintAlphas[3]) < 0.02;
    /** Extra px so bold/side-bearing ink past advance width is not mask-cut. */
    const MASK_END_BLEED_PX = 4;
    const useLineMask = measured && !solidLocalMask;
    const maskWidth = useLineMask
      ? `${(visualLine.width + MASK_END_BLEED_PX).toFixed(3)}px`
      : "100%";
    const maskOffset = useLineMask
      ? `${geometry.offset.toFixed(3)}px`
      : "0px";
    const glowMaskStops = useLineMask
      ? expandKaraokeGlowMaskStops({
          stops: glowMask.stops,
          visualLineWidthPx: visualLine.width,
          cursorPx: sweepCursorPx,
          featherPx: sweepFeatherPx,
          direction: track.direction,
        })
      : glowMask.stops;
    const glowMaskWidth = useLineMask
      ? `${(visualLine.width + KARAOKE_GLOW_MASK_BLEED_PX * 2).toFixed(3)}px`
      : "100%";
    const glowMaskOffset = useLineMask
      ? `${geometry.offset.toFixed(3)}px`
      : "0px";
    setBindingStyle(
      binding,
      BindingStyleSlot.LineMix,
      cssNumber(primaryMix),
    );
    setBindingStyle(binding, BindingStyleSlot.MaskWidth, maskWidth);
    setBindingStyle(binding, BindingStyleSlot.MaskOffsetX, maskOffset);
    setBindingStyle(
      binding,
      BindingStyleSlot.MaskAlphaA,
      cssNumber(resolvedPaintAlphas[0]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.MaskAlphaB,
      cssNumber(resolvedPaintAlphas[1]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.MaskAlphaC,
      cssNumber(resolvedPaintAlphas[2]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.MaskAlphaD,
      cssNumber(resolvedPaintAlphas[3]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.StopB,
      cssNumber(paintStops[1]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.StopC,
      cssNumber(paintStops[2]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowMaskAlphaA,
      cssNumber(glowMask.alphas[0]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowMaskAlphaB,
      cssNumber(glowMask.alphas[1]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowMaskAlphaC,
      cssNumber(glowMask.alphas[2]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowMaskAlphaD,
      cssNumber(glowMask.alphas[3]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowStopB,
      cssNumber(glowMaskStops[1]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowStopC,
      cssNumber(glowMaskStops[2]),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowMaskWidth,
      glowMaskWidth,
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowMaskOffsetX,
      glowMaskOffset,
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.LiftY,
      `${(lift.positionPx * karaokeEffectMix).toFixed(3)}px`,
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.EmphasisScale,
      cssNumber(1 + (emphasis.scale - 1) * karaokeEffectMix),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.EmphasisSpreadX,
      `${Number.isFinite(spreadPx) ? (spreadPx * karaokeEffectMix).toFixed(3) : "0.000"}px`,
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.EmphasisPivotY,
      binding.emphasisPivotYPx === null
        ? "100%"
        : `${binding.emphasisPivotYPx.toFixed(3)}px`,
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowOpacity,
      cssNumber(glowEnvelope * karaokeEffectMix),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowAlphaCore,
      cssNumber(glowMask.layerAlphas.core),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowAlphaMid,
      cssNumber(glowMask.layerAlphas.mid),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowAlphaOuter,
      cssNumber(glowMask.layerAlphas.outer),
    );
    setBindingStyle(
      binding,
      BindingStyleSlot.GlowAlphaBloom,
      cssNumber(glowMask.layerAlphas.bloom),
    );
    const glowIsVisible =
      glowMask.phase !== "none" &&
      glowEnvelope * karaokeEffectMix > BINDING_TRANSFORM_EPSILON;
    setBindingClass(
      binding,
      "motionActive",
      transformIsChanging ||
        displayModeTransformIsChanging ||
        liftPrewarming ||
        emphasisPrewarming,
    );
    setBindingClass(
      binding,
      "glowActive",
      glowIsVisible || emphasisPrewarming,
    );
    setBindingDataset(binding, "sweepPhase", sweepPhase);
    setBindingDataset(binding, "liftPhase", lift.phase);
    setBindingDataset(binding, "emphasisPhase", emphasis.phase);
    setBindingDataset(binding, "glowMaskPhase", glowMask.phase);
  }

  #installMeasurementEnvironment(ownerDocument: Document | null): void {
    if (ownerDocument === this.#measurementDocument) return;
    this.#detachMeasurementEnvironment();
    if (!ownerDocument) return;
    this.#measurementDocument = ownerDocument;
    this.#textMetricsContext = ownerDocument
      .createElement("canvas")
      .getContext("2d");
    const ResizeObserverConstructor = ownerDocument.defaultView?.ResizeObserver;
    if (ResizeObserverConstructor) {
      this.#resizeObserver = new ResizeObserverConstructor((entries) => {
        if (!this.#active) {
          this.#geometryDirty = true;
          return;
        }
        const records = new Set<TrackRecord>();
        let remeasureAll = false;
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const record = this.#tracksByRoot.get(target);
          if (record) records.add(record);
          else {
            const previousWidth = this.#featherContainerWidths.get(target);
            if (previousWidth === undefined) continue;
            const nextWidth = entry.contentRect.width;
            if (
              Number.isFinite(nextWidth) &&
              Math.abs(nextWidth - previousWidth) > 0.25
            ) {
              this.#featherContainerWidths.set(target, nextWidth);
              remeasureAll = true;
            }
          }
        }
        const tracks = remeasureAll
          ? [...this.#tracksByRoot.values()]
          : [...records];
        if (this.#measureTracks(tracks)) this.#repaintLastFrame();
      });
    }
    const fontSet = ownerDocument.fonts;
    if (fontSet && typeof fontSet.addEventListener === "function") {
      this.#fontSet = fontSet;
      this.#fontSet.addEventListener("loadingdone", this.#fontLoadListener);
    }
  }

  #detachMeasurementEnvironment(): void {
    const observer = this.#resizeObserver;
    const fontSet = this.#fontSet;
    this.#resizeObserver = null;
    this.#fontSet = null;
    this.#textMetricsContext = null;
    this.#measurementDocument = null;
    this.#tracksByRoot.clear();
    this.#featherContainerWidths.clear();
    const errors: unknown[] = [];
    try {
      observer?.disconnect();
    } catch (error) {
      errors.push(error);
    }
    try {
      fontSet?.removeEventListener("loadingdone", this.#fontLoadListener);
    } catch (error) {
      errors.push(error);
    }
    throwCollectedErrors(errors, "Karaoke measurement cleanup failed");
  }

  #observeCurrentTracks(): void {
    this.#resizeObserver?.disconnect();
    this.#tracksByRoot.clear();
    this.#featherContainerWidths.clear();
    const featherContainers = new Set<HTMLElement>();
    for (const row of this.#rows.values()) {
      for (const track of row.tracks.values()) {
        this.#tracksByRoot.set(track.root, track);
        this.#resizeObserver?.observe(track.root);
        const container = track.root.closest(".am-lp-line-row")?.parentElement;
        if (container) featherContainers.add(container);
      }
    }
    for (const container of featherContainers) {
      this.#featherContainerWidths.set(container, container.clientWidth);
      this.#resizeObserver?.observe(container);
    }
  }

  #measureTracks(tracks: readonly TrackRecord[]): boolean {
    let changed = false;
    for (const track of tracks) changed = this.#measureTrack(track) || changed;
    return changed;
  }

  #measureTrack(track: TrackRecord): boolean {
    track.featherReferenceWidth = resolveSweepFeatherReferenceWidth(track);
    const containerWidth = track.root.clientWidth;
    if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
      if (track.layoutSource === "fallback") return false;
      track.layout = createFallbackLayout(track.compilation);
      track.layoutSource = "fallback";
      return true;
    }
    const rootOffset = absoluteLayoutOffset(track.root);
    const rects = [...track.bindings.values()].map((binding) => {
      binding.emphasisPivotYPx = measureEmphasisPivotYPx(
        binding.element,
        this.#textMetricsContext,
      );
      const elementOffset = absoluteLayoutOffset(binding.element);
      return {
        bindingId: binding.plan.id,
        left: elementOffset.left - rootOffset.left,
        top: elementOffset.top - rootOffset.top,
        width: binding.element.offsetWidth,
        height: binding.element.offsetHeight,
      };
    });
    if (
      rects.length !== track.bindings.size ||
      rects.some(({ width, height }) => width <= 0 || height <= 0)
    ) {
      if (track.layoutSource === "fallback") return false;
      track.layout = createFallbackLayout(track.compilation);
      track.layoutSource = "fallback";
      return true;
    }
    const layout = createKaraokeMaskLayout(rects, {
      containerLeft: 0,
      containerWidth,
    });
    const measuredBindingCount = layout.lines.reduce(
      (count, line) => count + line.bindings.length,
      0,
    );
    if (measuredBindingCount !== track.bindings.size) return false;
    track.layout = layout;
    track.layoutSource = "measured";
    return true;
  }

  #repaintLastFrame(): void {
    if (!this.#lastFrame || this.#lastFrame.documentId !== this.#documentId) return;
    // Force all rows so paint-mode morph is consistent across the list.
    this.#renderFrame(this.#lastFrame, this.#lastOptions, true);
  }

  /**
   * Advance karaoke↔line paint morph on wall clock.
   * Never snap when paused — that caused fill/scale hard cuts on mode switch.
   */
  #advanceDisplayModeTransition(): void {
    const transition = this.#displayModeTransition;
    if (!transition.running) return;
    const nowMs = this.#now();
    const previousSampleMs = this.#displayModeSampleMs ?? nowMs;
    const deltaMs = Math.max(0, nowMs - previousSampleMs);
    const next = advanceDisplayModeTransition(transition, deltaMs);
    const wasRunning = transition.running;
    this.#displayModeTransition = next;
    this.#displayModeSampleMs = next.running ? nowMs : null;
    this.#syncPaintModeDataset();
    if (wasRunning && !next.running && this.#paintMode === "line") {
      this.#liftStates.clear();
    }
  }

  #ensureDisplayModeMorphLoop(): void {
    if (
      this.#destroyed ||
      !this.#active ||
      !this.#displayModeTransition.running ||
      this.#displayModeMorphFrame !== null
    ) {
      return;
    }
    const view =
      this.#measurementDocument?.defaultView ??
      (typeof globalThis !== "undefined" ? globalThis : null);
    if (!view || typeof view.requestAnimationFrame !== "function") return;
    const tick = (): void => {
      this.#displayModeMorphFrame = null;
      if (this.#destroyed || !this.#active) return;
      if (!this.#displayModeTransition.running) {
        if (this.#paintMode === "line") this.#liftStates.clear();
        this.#repaintLastFrame();
        return;
      }
      this.#repaintLastFrame();
      this.#ensureDisplayModeMorphLoop();
    };
    this.#displayModeMorphFrame = view.requestAnimationFrame(tick);
  }

  #cancelDisplayModeMorphLoop(): void {
    if (this.#displayModeMorphFrame === null) return;
    const view =
      this.#measurementDocument?.defaultView ??
      (typeof globalThis !== "undefined" ? globalThis : null);
    if (view && typeof view.cancelAnimationFrame === "function") {
      view.cancelAnimationFrame(this.#displayModeMorphFrame);
    }
    this.#displayModeMorphFrame = null;
  }

  #syncPaintModeDataset(): void {
    const transition = this.#displayModeTransition;
    const visualMode = transition.running ? "transition" : this.#paintMode;
    for (const row of this.#rows.values()) {
      for (const track of row.tracks.values()) {
        track.root.dataset.paintMode = visualMode;
        track.root.dataset.paintModeTarget = this.#paintMode;
        track.root.dataset.paintModeRunning = String(transition.running);
        track.root.dataset.paintModeLineMix = transition.lineMix.toFixed(5);
      }
    }
  }

  #releaseAllTracks(): void {
    const errors: unknown[] = [];
    for (const row of this.#rows.values()) {
      for (const track of row.tracks.values()) {
        try {
          track.host.releaseTrackElement(
            track.trackName,
            track.track.text,
            track.track.language.effective,
          );
        } catch (error) {
          errors.push(error);
        }
      }
    }
    throwCollectedErrors(errors, "Karaoke track release failed");
  }

  #clearDocumentState(): void {
    this.#documentId = null;
    this.#rows.clear();
    this.#tracksByRoot.clear();
    this.#liftStates.clear();
    this.#transientLineIds.clear();
    this.#effectTailLineIds.clear();
    this.#lastFrame = null;
    this.#lastLiftSampleAtMs = null;
    this.#fallbackTrackCount = 0;
    this.#displayModeTransition = createDisplayModeTransitionState(
      this.#paintMode,
    );
    this.#displayModeSampleMs = null;
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("Karaoke renderer is destroyed");
  }
}

export function createKaraokeRenderer(
  options: KaraokeRendererOptions,
): KaraokeRenderer {
  return new KaraokeRendererImpl(options);
}
