import type { LyricDocument } from "../domain/types.js";
import {
  createArtworkBackgroundRenderer,
  type ArtworkBackgroundRenderer,
  type LyricsBackgroundAppearance,
  type LyricsBackgroundArtworkSource,
  type LyricsBackgroundArtworkUpdateOptions,
  type LyricsBackgroundArtworkUpdateResult,
  type LyricsBackgroundPerformanceMode,
} from "../background/artwork-background.js";
import {
  createLyricLayoutPlan,
  type LyricLayoutPlan,
} from "../layout/layout-plan.js";
import {
  createSecondaryLaneLayoutPlan,
  type SecondaryLaneLayoutState,
  type SecondaryLaneLayoutPlan,
} from "../layout/secondary-lane.js";
import {
  captureScrollAnchor,
  findFirstFullyVisibleRow,
  isElementFullyVisible,
  LINE_MOVE_MAX_DURATION_MS,
  resolveKaraokeLinePreAnchor,
  resolveLineMoveDuration,
  resolveLyricTopOffset,
  type KaraokeLinePreAnchor,
  type ScrollAnchorSnapshot,
} from "../navigation/auto-scroll.js";
import {
  createClickSeekRequest,
  executeClickSeek,
  isClickSeekEligible,
  type PlaybackCommands,
} from "../navigation/click-seek.js";
import {
  applySeekScrollFloor,
  clearClickSeekOwnership,
  clearForcedClickSeekOwnership,
  createClickSeekOwnershipState,
  isPaintSuppressedByClickSeekOwnership,
  maybeExpireClickSeekOwnership,
  maybeExpireSeekScrollFloor,
  resolveClickSeekSecondaryResidualFocusLineId,
  resolveForcedFocusLineId,
  setClickSeekOwnership,
  type ClickSeekOwnershipState,
} from "../navigation/click-seek-ownership.js";
import {
  advanceFocusPolicy,
  createFocusPolicyContext,
  type FocusPolicyContext,
  type FocusPolicyReason,
  type FocusPolicyState,
} from "../navigation/focus-policy.js";
import {
  advanceScrollOwner,
  createScrollOwnerState,
  type ScrollOwnerState,
} from "../navigation/scroll-owner.js";
import {
  CLICK_SEEK_SCROLL_DURATION_MS,
  clickSeekScrollEase,
} from "../navigation/smooth-scroll.js";
import {
  createPlaybackFrame,
  createPlaybackFrameContext,
  type PlaybackFrame,
  type PlaybackFrameContext,
  type PlaybackFrameMode,
} from "../playback/create-playback-frame.js";
import { resolveLineForegroundEndMs } from "../playback/concurrent-primary-tail.js";
import {
  createFrameScheduler,
  type FrameSampleCause,
} from "../playback/frame-scheduler.js";
import type { PlaybackClock, PlaybackSnapshot } from "../playback/types.js";
import {
  createLineTimedRenderer,
  type LineTimedRenderer,
} from "../renderers/line-timed-renderer.js";
import {
  createBackgroundTrackRenderer,
  type BackgroundTrackRenderer,
} from "../renderers/background-track-renderer.js";
import {
  createDuetRenderer,
  type DuetRenderer,
} from "../renderers/duet-renderer.js";
import {
  createKaraokeRenderer,
  type KaraokeRenderer,
} from "../renderers/karaoke-renderer.js";
import {
  createInstrumentalRenderer,
  type InstrumentalRenderer,
} from "../instrumental/renderer.js";
import { INSTRUMENTAL_EXIT_TOTAL_DURATION_MS } from "../instrumental/session.js";
import {
  createPlaintextRenderer,
  type PlaintextRenderer,
} from "../renderers/plaintext-renderer.js";
import {
  createLayerCrossfade,
  type LayerCrossfade,
} from "../transitions/crossfade.js";
import {
  createRowMoveCoordinator,
  type RowMoveCoordinator,
  type RowMoveHost,
  type RowMoveTransaction,
} from "../transitions/row-move.js";
import {
  createSecondaryLaneTransition,
  type PreparedSecondaryLanePlan,
  type SecondaryLaneHost,
  type SecondaryLanePresentation,
  type SecondaryLaneTransition,
} from "../transitions/secondary-lane.js";
import {
  createSecondaryTextTransitionState,
  isTranslationToggleCooldownActive,
  requestSecondaryTextTransition,
  resetSecondaryTextTransition,
  SECONDARY_TEXT_LAYOUT_DURATION_MS,
  type SecondaryTextTransitionResult,
  type SecondaryTextTransitionState,
  type SecondaryTextUpdateSource,
} from "../transitions/secondary-text.js";
import {
  createPlayerView,
  type PlayerView,
  type PlayerViewLayer,
} from "../view/player-view.js";
import {
  isLyricsLayoutProfile,
  type LyricsLayoutProfile,
} from "../view/layout-profile.js";
import {
  DEFAULT_LYRICS_CONTENT_REGION,
  normalizeLyricsContentRegion,
  type LyricsContentRegion,
} from "../view/content-region.js";
import {
  createLyricsContentRegionControl,
  type LyricsContentRegionControl,
  type LyricsContentRegionControlEvent,
} from "../view/content-region-control.js";
import {
  createLyricsFontProfileManager,
  type LyricsFontProfileManager,
  type LyricsFontProfiles,
  type LyricsFontSource,
  type LyricsFontUpdateOptions,
  type LyricsFontUpdateResult,
} from "../view/font-profile.js";
import {
  DEFAULT_LYRICS_FONT_WEIGHT_TIER,
  isLyricsFontWeightTier,
  type LyricsFontWeightTier,
} from "../view/font-weight-tier.js";
import {
  setRowSeekActionable,
  type SecondaryTextVisibility,
} from "../view/row-view.js";
import {
  createInteractionController,
  type InteractionController,
} from "../view/interaction-controller.js";
import type { LyricsSurfaceMode } from "../view/surface-mode.js";

const EMPTY_LINE_ID_SET: ReadonlySet<string> = new Set<string>();

// A same-source replay is a visual navigation event rather than a media
// replacement. Keep the duration aligned with the accepted click-seek motion
// so the first row returns to its dock without a hard jump.
const SAME_SOURCE_REPLAY_SCROLL_DURATION_MS = 650;

export type LyricsDisplayMode = "plaintext" | "lrc" | "karaoke";

export type LyricsReducedMotionPreference = boolean | "system";

export interface LyricsPlayerOptions {
  readonly displayMode: LyricsDisplayMode;
  readonly backgroundAppearance: LyricsBackgroundAppearance;
  readonly translationVisible: boolean;
  readonly pronunciationVisible: boolean;
  readonly reducedMotion: boolean;
}

export interface LyricsPlayerOptionsInput {
  readonly displayMode: LyricsDisplayMode;
  readonly backgroundAppearance: LyricsBackgroundAppearance;
  readonly translationVisible: boolean;
  readonly pronunciationVisible: boolean;
  readonly reducedMotion: LyricsReducedMotionPreference;
}

export interface LyricsOptionsUpdateContext {
  readonly source?: SecondaryTextUpdateSource;
}

export interface LyricsOptionsUpdateResult {
  readonly accepted: boolean;
  readonly reason:
    | SecondaryTextTransitionResult["reason"]
    | "options-updated";
  readonly options: LyricsPlayerOptions;
  readonly reducedMotionPreference: LyricsReducedMotionPreference;
}

export interface LyricsPlayerController {
  mount(host: HTMLElement): void;
  setActive(active: boolean): void;
  setBackgroundPerformanceMode(mode: LyricsBackgroundPerformanceMode): void;
  setSurfaceMode(mode: LyricsSurfaceMode): void;
  setBackgroundArtwork(
    source: LyricsBackgroundArtworkSource | null,
    options?: LyricsBackgroundArtworkUpdateOptions,
  ): Promise<LyricsBackgroundArtworkUpdateResult>;
  setFontProfile(
    source: LyricsFontSource | null,
    options?: LyricsFontUpdateOptions,
  ): Promise<LyricsFontUpdateResult>;
  setFontProfiles(
    profiles: LyricsFontProfiles,
    options?: LyricsFontUpdateOptions,
  ): Promise<LyricsFontUpdateResult>;
  setContentRegion(region: LyricsContentRegion): void;
  setContentRegionControlVisible(visible: boolean): void;
  setFontWeightTier(tier: LyricsFontWeightTier): void;
  /**
   * Weight tier for the plaintext poem view only — independent of the synced
   * (LRC/karaoke) tier, which never applies to plaintext.
   */
  setPlaintextFontWeightTier(tier: LyricsFontWeightTier): void;
  setLayoutProfile(profile: LyricsLayoutProfile): void;
  setLyrics(document: LyricDocument | null): void;
  setPlayback(
    clock: PlaybackClock | null,
    commands?: PlaybackCommands | null,
  ): void;
  setOptions(
    patch: Partial<LyricsPlayerOptionsInput>,
    context?: LyricsOptionsUpdateContext,
  ): LyricsOptionsUpdateResult;
  syncScroll(): void;
  destroy(): void;
}

const defaultOptions: LyricsPlayerOptions = {
  displayMode: "karaoke",
  backgroundAppearance: "light",
  translationVisible: false,
  pronunciationVisible: false,
  reducedMotion: false,
};

const DEFAULT_REDUCED_MOTION_PREFERENCE: LyricsReducedMotionPreference =
  "system";
const REDUCED_MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";

function normalizeReducedMotionPreference(
  preference: LyricsReducedMotionPreference | undefined,
): LyricsReducedMotionPreference {
  return preference === true || preference === false
    ? preference
    : DEFAULT_REDUCED_MOTION_PREFERENCE;
}

interface SecondaryLaneUpdate {
  readonly key: string;
  readonly layoutPlan: SecondaryLaneLayoutPlan;
  readonly prepared: PreparedSecondaryLanePlan;
  readonly directHosts: readonly SecondaryLaneHost[];
  readonly directGeometryLineIds: readonly string[];
}

interface FontLayoutChange {
  readonly layer: PlayerViewLayer;
  readonly anchor: ScrollAnchorSnapshot | null;
  readonly anchorLineId: string | null;
  readonly rowTransaction: RowMoveTransaction;
}

interface ContentRegionLayoutChange {
  readonly layer: PlayerViewLayer;
  readonly anchor: ScrollAnchorSnapshot | null;
  readonly originRegion: LyricsContentRegion;
}

interface ComponentSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

interface ComponentScrollAnchor {
  readonly layer: PlayerViewLayer;
  readonly anchor: ScrollAnchorSnapshot;
}

const CONTENT_REGION_MIN_SPAN_RATIO = 0.12;

function contentRegionsEqual(
  left: LyricsContentRegion,
  right: LyricsContentRegion,
): boolean {
  return left.left === right.left && left.right === right.right;
}

function contentRegionSpan(region: LyricsContentRegion): number {
  return region.right - region.left;
}

function foregroundSecondaryLaneState(
  lineId: string,
  target: "expanded" | "none",
): SecondaryLaneLayoutState {
  return Object.freeze({
    lineId,
    target,
    reason: target === "expanded" ? "focus-line" : "no-secondary-content",
    hasBackground: false,
    hasBackgroundPronunciation: false,
    hasBackgroundTranslation: false,
    visibleBackgroundPronunciation: false,
    visibleBackgroundTranslation: false,
  });
}

interface KaraokePreAnchorMotionState {
  readonly targetLineId: string;
  readonly authoredBeginMs: number;
  readonly visualFocusLineId: string;
  readonly visualStyleFocusLineId: string;
  readonly lineMoveAnchorLineId: string;
  readonly scaleActiveLineIds: ReadonlySet<string>;
  readonly playbackRate: number;
  readonly restartRequested: boolean;
}

function secondaryLaneStateKey(state: SecondaryLaneLayoutState): string {
  return [
    state.target,
    state.reason,
    state.visibleBackgroundPronunciation ? "1" : "0",
    state.visibleBackgroundTranslation ? "1" : "0",
  ].join("\u0000");
}

function setDatasetValue(
  element: HTMLElement,
  key: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    if (element.dataset[key] !== undefined) delete element.dataset[key];
    return;
  }
  if (element.dataset[key] !== value) element.dataset[key] = value;
}

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

class PlaybackSampleError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`Lyrics playback sample failed${detail}`);
    this.name = "PlaybackSampleError";
    this.cause = cause;
  }
}

function containsPlaybackSampleError(error: unknown): boolean {
  if (error instanceof PlaybackSampleError) return true;
  return (
    error instanceof AggregateError &&
    error.errors.some((nestedError) => containsPlaybackSampleError(nestedError))
  );
}

function displayLayer(mode: LyricsDisplayMode): PlayerViewLayer {
  return mode === "plaintext" ? "plaintext" : "synced";
}

function monotonicNow(view: Window | null): number {
  return view?.performance?.now() ?? globalThis.performance?.now() ?? Date.now();
}

class LyricsPlayerControllerImpl implements LyricsPlayerController {
  readonly #scheduler = createFrameScheduler({
    onSample: (snapshot, cause) => this.#handlePlaybackSample(snapshot, cause),
    onError: (error) => this.#handleSchedulerError(error),
    requestFrame: (callback) => this.#requestPlaybackFrame(callback),
    cancelFrame: (handle) => this.#cancelPlaybackFrame(handle),
  });
  #lifecycle: "created" | "mounted" | "destroyed" = "created";
  #active = true;
  #options: LyricsPlayerOptions;
  #lyrics: LyricDocument | null = null;
  #layoutPlan: LyricLayoutPlan | null = null;
  #frameContext: PlaybackFrameContext | null = null;
  #focusPolicyContext: FocusPolicyContext | null = null;
  #focusPolicy: FocusPolicyState | null = null;
  #playbackSnapshot: PlaybackSnapshot | null = null;
  #playbackFrame: PlaybackFrame | null = null;
  #nextFrameMode: PlaybackFrameMode | null = null;
  #view: PlayerView | null = null;
  #contentRegion: LyricsContentRegion = DEFAULT_LYRICS_CONTENT_REGION;
  #contentRegionControl: LyricsContentRegionControl | null = null;
  #contentRegionControlVisible = false;
  #contentRegionLayoutChange: ContentRegionLayoutChange | null = null;
  #artworkBackgroundRenderer: ArtworkBackgroundRenderer | null = null;
  #backgroundPerformanceMode: LyricsBackgroundPerformanceMode = "auto";
  #surfaceMode: LyricsSurfaceMode = "default";
  #fontProfileManager: LyricsFontProfileManager | null = null;
  #fontWeightTier: LyricsFontWeightTier = DEFAULT_LYRICS_FONT_WEIGHT_TIER;
  #plaintextFontWeightTier: LyricsFontWeightTier = 1;
  #layoutProfile: LyricsLayoutProfile = "auto";
  #backgroundArtworkPresent = false;
  #backgroundArtworkRequestGeneration = 0;
  #sheetCompositeMode: "normal" | "add" = "normal";
  #sheetCompositePlainLight: boolean | null = null;
  #plaintextRenderer: PlaintextRenderer | null = null;
  #lineTimedRenderer: LineTimedRenderer | null = null;
  #karaokeRenderer: KaraokeRenderer | null = null;
  #backgroundTrackRenderer: BackgroundTrackRenderer | null = null;
  #duetRenderer: DuetRenderer | null = null;
  #instrumentalRenderer: InstrumentalRenderer | null = null;
  #crossfade: LayerCrossfade | null = null;
  #interaction: InteractionController | null = null;
  readonly #rowMove: RowMoveCoordinator = createRowMoveCoordinator();
  readonly #secondaryLaneTransition: SecondaryLaneTransition =
    createSecondaryLaneTransition();
  readonly #foregroundSecondaryLaneTransition: SecondaryLaneTransition =
    createSecondaryLaneTransition();
  #secondaryTextState: SecondaryTextTransitionState;
  #syncedDisplayMode: Exclude<LyricsDisplayMode, "plaintext">;
  #scrollOwner: ScrollOwnerState = createScrollOwnerState();
  #playbackCommands: PlaybackCommands | null = null;
  #schedulerOperationErrors: unknown[] | null = null;
  #playbackError = false;
  #secondaryLaneSyncKey: string | null = null;
  #secondaryLaneStateByLineId = new Map<string, string>();
  #visibilityDocument: Document | null = null;
  #visibilityResumePending = false;
  #reducedMotionPreference: LyricsReducedMotionPreference;
  #systemReducedMotion = false;
  #reducedMotionMediaQuery: MediaQueryList | null = null;
  #reducedMotionMediaQueryListenerMode: "event" | "legacy" | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #resizeWindow: Window | null = null;
  #resizeFrame = 0;
  #geometryRefreshFrame = 0;
  #stableAnchorFrame = 0;
  #resizePending = false;
  #pendingComponentSize: ComponentSize | null = null;
  #pendingResizeAnchor: ComponentScrollAnchor | null = null;
  #stableComponentAnchor: ComponentScrollAnchor | null = null;
  #componentSize: ComponentSize | null = null;
  #clickSeekScrollLineId: string | null = null;
  #clickSeekScrollGeneration = 0;
  #clickSeekMotionPhase: "pending" | "row" | "scroll" | null = null;
  /**
   * Distinguishes lyric-row click seeks (forced paint ownership) from host
   * progress/timeline seeks. Both reuse the same FLIP + smooth-scroll path so
   * external scrubbing does not hard-jump the viewport.
   */
  #seekMotionOrigin: "click" | "external" | null = null;
  #clickSeekDiscontinuityBaseline = 0;
  #clickSeekDiscontinuitySequence: number | null = null;
  #karaokePreAnchorMotion: KaraokePreAnchorMotionState | null = null;
  #clickSeekOwnership: ClickSeekOwnershipState =
    createClickSeekOwnershipState();
  readonly #handleVisibilityChange = (): void => {
    if (this.#lifecycle !== "mounted" || !this.#visibilityDocument) return;
    const hidden = this.#visibilityDocument.visibilityState === "hidden";
    if (hidden) this.#visibilityResumePending = true;
    this.#runSchedulerOperation(
      () => this.#scheduler.setEnabled(this.#schedulerMayRun()),
      "Lyrics player visibility update failed",
    );
    if (hidden) this.#suspendPlaybackMotionForVisibility();
    this.#syncDomState();
  };
  readonly #handleReducedMotionMediaQueryChange = (): void => {
    const mediaQuery = this.#reducedMotionMediaQuery;
    if (!mediaQuery) return;
    const nextSystemReducedMotion = mediaQuery.matches;
    if (nextSystemReducedMotion === this.#systemReducedMotion) return;
    this.#systemReducedMotion = nextSystemReducedMotion;
    if (
      this.#lifecycle !== "mounted" ||
      this.#reducedMotionPreference !== "system"
    ) {
      return;
    }
    this.setOptions({ reducedMotion: "system" });
  };
  readonly #handleComponentResize = (
    entriesOrEvent?: readonly ResizeObserverEntry[] | Event,
  ): void => {
    if (this.#lifecycle !== "mounted" || !this.#active) return;
    const root = this.#view?.root;
    const entries = Array.isArray(entriesOrEvent)
      ? (entriesOrEvent as readonly ResizeObserverEntry[])
      : [];
    const entry = root
      ? entries.find((candidate) => candidate.target === root)
      : undefined;
    if (entry) {
      this.#pendingComponentSize = this.#normalizeComponentSize(
        entry.contentRect.width,
        entry.contentRect.height,
      );
    }
    if (!this.#resizePending) {
      this.#resizePending = true;
      this.#pendingResizeAnchor = this.#interaction?.getState().manualScrollActive
        ? null
        : this.#stableComponentAnchor;
    }
    this.#scheduleComponentResize();
  };

  constructor(options: Partial<LyricsPlayerOptionsInput>) {
    const { reducedMotion, ...rest } = options;
    this.#reducedMotionPreference = normalizeReducedMotionPreference(
      reducedMotion,
    );
    this.#options = {
      ...defaultOptions,
      ...rest,
      reducedMotion:
        typeof this.#reducedMotionPreference === "boolean"
          ? this.#reducedMotionPreference
          : false,
    };
    this.#syncedDisplayMode =
      this.#options.displayMode === "lrc" ? "lrc" : "karaoke";
    this.#secondaryTextState = createSecondaryTextTransitionState({
      translationVisible: this.#options.translationVisible,
      pronunciationVisible: this.#options.pronunciationVisible,
    });
  }

  mount(host: HTMLElement): void {
    this.#assertMutable();
    if (this.#lifecycle === "mounted") {
      throw new Error("Lyrics player is already mounted");
    }

    const playbackSnapshotBeforeMount = this.#playbackSnapshot;
    const playbackFrameBeforeMount = this.#playbackFrame;
    const nextFrameModeBeforeMount = this.#nextFrameMode;
    const reducedMotionBeforeMount = this.#options.reducedMotion;
    let view: PlayerView | null = null;
    let contentRegionControl: LyricsContentRegionControl | null = null;
    let artworkBackgroundRenderer: ArtworkBackgroundRenderer | null = null;
    let fontProfileManager: LyricsFontProfileManager | null = null;
    let plaintextRenderer: PlaintextRenderer | null = null;
    let lineTimedRenderer: LineTimedRenderer | null = null;
    let karaokeRenderer: KaraokeRenderer | null = null;
    let backgroundTrackRenderer: BackgroundTrackRenderer | null = null;
    let duetRenderer: DuetRenderer | null = null;
    let instrumentalRenderer: InstrumentalRenderer | null = null;
    let crossfade: LayerCrossfade | null = null;
    let interaction: InteractionController | null = null;
    this.#lifecycle = "mounted";

    try {
      this.#installReducedMotionMediaQuery(host.ownerDocument.defaultView);
      view = createPlayerView(host);
      view.setSurfaceMode(this.#surfaceMode);
      view.setContentRegion(this.#contentRegion);
      view.setFontWeightTier(this.#fontWeightTier);
      view.setPlaintextFontWeightTier(this.#plaintextFontWeightTier);
      contentRegionControl = createLyricsContentRegionControl({
        document: host.ownerDocument,
        initialRegion: this.#contentRegion,
        minSpanRatio: CONTENT_REGION_MIN_SPAN_RATIO,
        initialVisible: this.#active && this.#contentRegionControlVisible,
        onStart: (event) => this.#beginContentRegionControlInteraction(event),
        onInput: (event) => this.#updateContentRegionControlInteraction(event),
        onCommit: (event) => this.#commitContentRegionControlInteraction(event),
        onCancel: (event) => this.#cancelContentRegionControlInteraction(event),
      });
      view.root.append(contentRegionControl.element);
      artworkBackgroundRenderer = createArtworkBackgroundRenderer({
        container: view.background,
        previousCanvas: view.backgroundPreviousCanvas,
        currentCanvas: view.backgroundCurrentCanvas,
        appearance: this.#options.backgroundAppearance,
        active: this.#backgroundMayRun(),
        reducedMotion: this.#options.reducedMotion,
      });
      fontProfileManager = createLyricsFontProfileManager({
        document: host.ownerDocument,
        applyFontOverrides: (overrides, kinds) =>
          view?.setFontOverrides(overrides, kinds),
      });
      plaintextRenderer = createPlaintextRenderer(view.plaintextRows);
      lineTimedRenderer = createLineTimedRenderer(view.syncedRows);
      karaokeRenderer = createKaraokeRenderer({
        resolvePaintHost: (lineId) =>
          lineTimedRenderer?.getPaintHost(lineId) ?? null,
        now: () => monotonicNow(host.ownerDocument.defaultView),
        active: this.#active,
      });
      backgroundTrackRenderer = createBackgroundTrackRenderer({
        resolvePaintHost: (lineId) =>
          lineTimedRenderer?.getPaintHost(lineId) ?? null,
        now: () => monotonicNow(host.ownerDocument.defaultView),
        active: this.#active,
      });
      duetRenderer = createDuetRenderer({
        resolveRow: (lineId) => lineTimedRenderer?.getRow(lineId) ?? null,
      });
      instrumentalRenderer = createInstrumentalRenderer({
        container: view.syncedRows,
        resolveTextRow: (lineId) => lineTimedRenderer?.getRow(lineId) ?? null,
      });
      crossfade = createLayerCrossfade({
        synced: view.syncedLayer,
        plaintext: view.plaintextLayer,
      });
      interaction = createInteractionController({
        viewport: view.syncedLayer,
        now: () => monotonicNow(host.ownerDocument.defaultView),
        requestFrame: (callback) => {
          const ownerWindow = host.ownerDocument.defaultView;
          if (!ownerWindow) {
            throw new Error("Lyrics player mount window is unavailable");
          }
          return ownerWindow.requestAnimationFrame(callback);
        },
        cancelFrame: (handle) => {
          const ownerWindow = host.ownerDocument.defaultView;
          if (!ownerWindow) {
            throw new Error("Lyrics player mount window is unavailable");
          }
          ownerWindow.cancelAnimationFrame(handle);
        },
        onManualScroll: () => this.#handleManualScroll(),
        onManualScrollIdle: () => this.#handleManualScrollIdle(),
        onLineClick: (lineId) => this.#handleLineClick(lineId),
      });
      this.#view = view;
      this.#contentRegionControl = contentRegionControl;
      this.#artworkBackgroundRenderer = artworkBackgroundRenderer;
      artworkBackgroundRenderer.setPerformanceMode(
        this.#backgroundPerformanceMode,
      );
      this.#fontProfileManager = fontProfileManager;
      this.#plaintextRenderer = plaintextRenderer;
      this.#lineTimedRenderer = lineTimedRenderer;
      this.#karaokeRenderer = karaokeRenderer;
      this.#backgroundTrackRenderer = backgroundTrackRenderer;
      this.#duetRenderer = duetRenderer;
      this.#instrumentalRenderer = instrumentalRenderer;
      this.#crossfade = crossfade;
      this.#interaction = interaction;
      this.#visibilityDocument = host.ownerDocument;
      this.#visibilityDocument.addEventListener(
        "visibilitychange",
        this.#handleVisibilityChange,
      );
      this.#installResizeObserver();
      this.#syncViewDocument();
      this.#syncViewOptions(false, true);
      this.#syncDomState();
      this.#runSchedulerOperation(
        () => this.#scheduler.setEnabled(this.#schedulerMayRun()),
        "Lyrics player scheduler activation failed",
      );
      this.#syncDomState();
      this.#captureStableComponentAnchor();
    } catch (error) {
      const cleanupErrors: unknown[] = [error];
      this.#sheetCompositeMode = "normal";
      this.#sheetCompositePlainLight = null;
      try {
        this.#rowMove.cancel("mount-failed");
        this.#secondaryLaneTransition.cancel("mount-failed");
        this.#foregroundSecondaryLaneTransition.cancel("mount-failed");
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        this.#scheduler.setEnabled(false);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        this.#detachVisibilityListener();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        this.#detachReducedMotionMediaQuery();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        this.#detachResizeObserver();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      for (const resource of [
        contentRegionControl,
        fontProfileManager,
        interaction,
        crossfade,
        instrumentalRenderer,
        duetRenderer,
        backgroundTrackRenderer,
        karaokeRenderer,
        lineTimedRenderer,
        plaintextRenderer,
        artworkBackgroundRenderer,
      ]) {
        try {
          resource?.destroy();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        view?.destroy();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      this.#view = null;
      this.#contentRegionControl = null;
      this.#contentRegionLayoutChange = null;
      this.#artworkBackgroundRenderer = null;
      this.#fontProfileManager = null;
      this.#plaintextRenderer = null;
      this.#lineTimedRenderer = null;
      this.#karaokeRenderer = null;
      this.#backgroundTrackRenderer = null;
      this.#duetRenderer = null;
      this.#instrumentalRenderer = null;
      this.#crossfade = null;
      this.#interaction = null;
      this.#playbackSnapshot = playbackSnapshotBeforeMount;
      this.#playbackFrame = playbackFrameBeforeMount;
      this.#nextFrameMode = nextFrameModeBeforeMount;
      this.#options = Object.freeze({
        ...this.#options,
        reducedMotion: reducedMotionBeforeMount,
      });
      this.#lifecycle = "created";
      throwCollectedErrors(cleanupErrors, "Lyrics player mount failed");
    }
  }

  async setBackgroundArtwork(
    source: LyricsBackgroundArtworkSource | null,
    options: LyricsBackgroundArtworkUpdateOptions = {},
  ): Promise<LyricsBackgroundArtworkUpdateResult> {
    this.#assertMutable();
    const renderer = this.#artworkBackgroundRenderer;
    if (!renderer) {
      throw new Error(
        "Lyrics player must be mounted before setting background artwork",
      );
    }
    const generation = ++this.#backgroundArtworkRequestGeneration;
    const result = await renderer.setArtwork(source, options);
    if (
      result.status === "applied" &&
      generation === this.#backgroundArtworkRequestGeneration
    ) {
      this.#backgroundArtworkPresent = source !== null;
      this.#syncDomState();
    }
    return result;
  }

  setActive(active: boolean): void {
    this.#assertMutable();
    if (this.#active === active) return;
    this.#active = active;
    const errors: unknown[] = [];
    if (!active) {
      this.#nextFrameMode = "bind";
      try {
        this.#contentRegionControl?.cancelInteraction();
        this.#contentRegionControl?.setVisible(false);
      } catch (error) {
        errors.push(error);
      }
      this.#cancelComponentFrames();
      this.#clearSeekMotion("player-inactive");
      this.#clickSeekOwnership = clearClickSeekOwnership("player-inactive");
      if (this.#scrollOwner.pendingSeekLineId !== null) {
        this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
          type: "seek-settled",
        });
      }
      try {
        this.#interaction?.cancelSmoothScroll("player-inactive");
      } catch (error) {
        errors.push(error);
      }
      this.#settlePlaybackMotion("player-inactive", errors);
      if (this.#sheetCompositePlainLight !== null) {
        this.#sheetCompositeMode = this.#sheetCompositePlainLight
          ? "normal"
          : "add";
      }
    }
    if (active) this.#refreshComponentSizeForActivation();
    for (const renderer of [
      this.#karaokeRenderer,
      this.#backgroundTrackRenderer,
    ]) {
      try {
        renderer?.setActive(active);
      } catch (error) {
        errors.push(error);
      }
    }
    if (active) {
      try {
        this.#contentRegionControl?.setVisible(
          this.#contentRegionControlVisible,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.#artworkBackgroundRenderer?.setActive(this.#backgroundMayRun());
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#runSchedulerOperation(
        () => this.#scheduler.setEnabled(this.#schedulerMayRun()),
        "Lyrics player activation failed",
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#syncDomState();
    } catch (error) {
      errors.push(error);
    }
    throwCollectedErrors(errors, "Lyrics player activation failed");
  }

  setBackgroundPerformanceMode(mode: LyricsBackgroundPerformanceMode): void {
    this.#assertMutable();
    if (
      mode !== "auto" &&
      mode !== "normal" &&
      mode !== "constrained" &&
      mode !== "critical"
    ) {
      throw new TypeError(`Unsupported background performance mode: ${mode}`);
    }
    this.#backgroundPerformanceMode = mode;
    this.#artworkBackgroundRenderer?.setPerformanceMode(mode);
    this.#syncDomState();
  }

  setSurfaceMode(mode: LyricsSurfaceMode): void {
    this.#assertMutable();
    if (mode !== "default" && mode !== "transparent") {
      throw new TypeError(`Unsupported lyrics surface mode: ${mode}`);
    }
    if (this.#surfaceMode === mode) return;
    this.#surfaceMode = mode;
    this.#view?.setSurfaceMode(mode);
    this.#artworkBackgroundRenderer?.setActive(this.#backgroundMayRun());
    this.#syncDomState();
  }

  async setFontProfile(
    source: LyricsFontSource | null,
    options: LyricsFontUpdateOptions = {},
  ): Promise<LyricsFontUpdateResult> {
    this.#assertMutable();
    this.#settleContentRegionInteractionForMutation();
    const manager = this.#fontProfileManager;
    if (!manager) {
      throw new Error("Lyrics player must be mounted before setting a font");
    }
    return manager.setSource(source, options, {
      beforeApply: () => {
        this.#settleContentRegionInteractionForMutation();
        return this.#beginFontLayoutChange();
      },
      afterApply: (change) => this.#completeFontLayoutChange(change),
      afterRollback: (change) => this.#rollbackFontLayoutChange(change),
    });
  }

  async setFontProfiles(
    profiles: LyricsFontProfiles,
    options: LyricsFontUpdateOptions = {},
  ): Promise<LyricsFontUpdateResult> {
    this.#assertMutable();
    this.#settleContentRegionInteractionForMutation();
    const manager = this.#fontProfileManager;
    if (!manager) {
      throw new Error("Lyrics player must be mounted before setting fonts");
    }
    return manager.setSources(profiles, options, {
      beforeApply: () => {
        this.#settleContentRegionInteractionForMutation();
        return this.#beginFontLayoutChange();
      },
      afterApply: (change) => this.#completeFontLayoutChange(change),
      afterRollback: (change) => this.#rollbackFontLayoutChange(change),
    });
  }

  setContentRegion(region: LyricsContentRegion): void {
    this.#assertMutable();
    const next = normalizeLyricsContentRegion(
      region,
      CONTENT_REGION_MIN_SPAN_RATIO,
    );
    if (contentRegionsEqual(next, this.#contentRegion)) return;

    const previous = this.#contentRegion;
    const activeChange = this.#contentRegionLayoutChange;
    if (!this.#view) {
      this.#contentRegion = next;
      return;
    }

    const change = activeChange ?? this.#beginContentRegionLayoutChange(previous);
    try {
      this.#applyContentRegionLayoutChange(change, next);
      this.#contentRegionControl?.setRegion(next);
      if (activeChange) {
        // An API update during a pointer gesture becomes the new rollback
        // baseline. The next Escape/cancel must not silently discard it.
        this.#contentRegionLayoutChange = Object.freeze({
          ...activeChange,
          originRegion: next,
        });
      } else {
        this.#completeContentRegionLayoutChange(change);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        this.#applyContentRegionLayoutChange(change, previous);
        this.#contentRegionControl?.setRegion(previous);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (!activeChange) this.#completeContentRegionLayoutChange(change);
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Lyrics content region update and rollback failed",
        );
      }
      throw error;
    }
  }

  setContentRegionControlVisible(visible: boolean): void {
    this.#assertMutable();
    const next = Boolean(visible);
    if (next === this.#contentRegionControlVisible) return;
    this.#contentRegionControlVisible = next;
    this.#contentRegionControl?.setVisible(this.#active && next);
  }

  setFontWeightTier(tier: LyricsFontWeightTier): void {
    this.#assertMutable();
    if (!isLyricsFontWeightTier(tier)) {
      throw new TypeError(`Unsupported lyrics font weight tier: ${String(tier)}`);
    }
    const view = this.#view;
    if (!view) {
      throw new Error(
        "Lyrics player must be mounted before setting a font weight tier",
      );
    }
    if (tier === this.#fontWeightTier) return;
    this.#settleContentRegionInteractionForMutation();

    const previousTier = this.#fontWeightTier;
    const change = this.#beginFontLayoutChange();
    try {
      view.setFontWeightTier(tier);
      this.#fontWeightTier = tier;
      this.#completeFontLayoutChange(change);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        view.setFontWeightTier(previousTier);
        this.#fontWeightTier = previousTier;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        this.#rollbackFontLayoutChange(change);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Lyrics font weight tier update and rollback failed",
        );
      }
      throw error;
    }
  }

  setPlaintextFontWeightTier(tier: LyricsFontWeightTier): void {
    this.#assertMutable();
    if (!isLyricsFontWeightTier(tier)) {
      throw new TypeError(
        `Unsupported plaintext font weight tier: ${String(tier)}`,
      );
    }
    const view = this.#view;
    if (!view) {
      throw new Error(
        "Lyrics player must be mounted before setting a plaintext weight tier",
      );
    }
    if (tier === this.#plaintextFontWeightTier) return;
    // Plaintext is a static poem layer with no karaoke mask geometry, so a
    // weight change needs no font-layout invalidation cycle — the row heights
    // reflow naturally on the next frame.
    view.setPlaintextFontWeightTier(tier);
    this.#plaintextFontWeightTier = tier;
  }

  setLayoutProfile(profile: LyricsLayoutProfile): void {
    this.#assertMutable();
    if (!isLyricsLayoutProfile(profile)) {
      throw new TypeError(`Unsupported lyrics layout profile: ${profile}`);
    }
    const view = this.#view;
    if (!view) {
      throw new Error(
        "Lyrics player must be mounted before setting a layout profile",
      );
    }
    if (profile === this.#layoutProfile) return;
    this.#settleContentRegionInteractionForMutation();

    const previousProfile = this.#layoutProfile;
    const change = this.#beginFontLayoutChange();
    try {
      view.setLayoutProfile(profile);
      this.#layoutProfile = profile;
      this.#completeFontLayoutChange(change);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        view.setLayoutProfile(previousProfile);
        this.#layoutProfile = previousProfile;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        this.#rollbackFontLayoutChange(change);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Lyrics layout profile update and rollback failed",
        );
      }
      throw error;
    }
  }

  setLyrics(document: LyricDocument | null): void {
    this.#assertMutable();
    this.#settleContentRegionInteractionForMutation();
    const nextLayoutPlan = document ? createLyricLayoutPlan(document) : null;
    const previousLyrics = this.#lyrics;
    const previousLayoutPlan = this.#layoutPlan;
    const previousFrameContext = this.#frameContext;
    const previousFocusPolicyContext = this.#focusPolicyContext;
    const previousFocusPolicy = this.#focusPolicy;
    const previousPlaybackFrame = this.#playbackFrame;
    const previousNextFrameMode = this.#nextFrameMode;
    const previousScrollOwner = this.#scrollOwner;
    const previousSecondaryTextState = this.#secondaryTextState;
    const previousDocumentId = previousLyrics?.id ?? null;
    const nextDocumentId = document?.id ?? null;

    try {
      this.#rowMove.cancel("source-replacement");
      this.#secondaryLaneTransition.cancel("source-replacement");
      this.#foregroundSecondaryLaneTransition.cancel("source-replacement");
      this.#crossfade?.settle(displayLayer(this.#options.displayMode));
      this.#lyrics = document;
      this.#layoutPlan = nextLayoutPlan;
      this.#frameContext = document ? createPlaybackFrameContext(document) : null;
      this.#focusPolicyContext = document
        ? createFocusPolicyContext(document)
        : null;
      this.#focusPolicy = null;
      this.#playbackFrame = null;
      this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
        type: "reset",
        reason: "source-replacement",
      });
      this.#clickSeekOwnership = clearClickSeekOwnership("source-replacement");
      this.#clearSeekMotion("source-replacement");
      this.#karaokePreAnchorMotion = null;
      this.#interaction?.cancelSmoothScroll("source-replacement");
      this.#secondaryTextState = resetSecondaryTextTransition(
        this.#secondaryTextState,
      );
      this.#nextFrameMode =
        previousDocumentId !== null && previousDocumentId !== nextDocumentId
          ? "reset"
          : "bind";
      this.#syncViewDocument();
      // A different document starts from the top. Nothing else resets
      // scrollTop: the old offset survives the row swap, and if the pending
      // clock still carries the previous track's time the sample below can
      // resolve an active line near the new document's end and pin the view
      // there ("new song, lyrics stuck at the bottom").
      if (previousDocumentId !== nextDocumentId) {
        for (const layer of ["synced", "plaintext"] as const) {
          try {
            this.#setProgrammaticScrollTop(this.#viewportForLayer(layer), 0);
          } catch {
            // view not mounted for this layer — nothing to reset
          }
        }
      }
      this.#samplePlaybackAfterMutation();
      this.#syncDomState();
      this.#captureStableComponentAnchor();
    } catch (error) {
      this.#lyrics = previousLyrics;
      this.#layoutPlan = previousLayoutPlan;
      this.#frameContext = previousFrameContext;
      this.#focusPolicyContext = previousFocusPolicyContext;
      this.#focusPolicy = previousFocusPolicy;
      this.#playbackFrame = previousPlaybackFrame;
      this.#nextFrameMode = previousNextFrameMode;
      this.#scrollOwner = previousScrollOwner;
      this.#secondaryTextState = previousSecondaryTextState;
      const rollbackErrors: unknown[] = [];
      try {
        this.#syncViewDocument();
        if (previousPlaybackFrame) {
          this.#lineTimedRenderer?.renderFrame(previousPlaybackFrame, {
            reducedMotion: true,
          });
          this.#karaokeRenderer?.renderFrame(previousPlaybackFrame, {
            reducedMotion: true,
            playing: this.#playbackSnapshot?.playing ?? false,
          });
          this.#backgroundTrackRenderer?.renderFrame(previousPlaybackFrame, {
            reducedMotion: true,
            playing: this.#playbackSnapshot?.playing ?? false,
          });
          this.#duetRenderer?.renderFrame(previousPlaybackFrame);
          this.#instrumentalRenderer?.renderFrame(previousPlaybackFrame, {
            reducedMotion: true,
            playing: this.#playbackSnapshot?.playing ?? false,
          });
          this.#syncSecondaryLaneTargets(previousPlaybackFrame);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (containsPlaybackSampleError(error) && rollbackErrors.length === 0) {
        try {
          this.#samplePlaybackAfterMutation();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        const errors = [error, ...rollbackErrors];
        if (rollbackErrors.some(containsPlaybackSampleError)) {
          this.#settlePlaybackFailure(errors);
        }
        throw new AggregateError(errors, "Lyrics replacement and rollback failed");
      }
      throw error;
    }
  }

  setPlayback(
    clock: PlaybackClock | null,
    commands?: PlaybackCommands | null,
  ): void {
    this.#assertMutable();
    this.#settleContentRegionInteractionForMutation();
    const requestedCommands = commands ?? null;
    this.#playbackCommands = null;
    this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
      type: "playback-replaced",
    });
    this.#playbackSnapshot = null;
    this.#playbackFrame = null;
    this.#focusPolicy = null;
    this.#nextFrameMode = "bind";
    const errors: unknown[] = [];
    try {
      this.#runSchedulerOperation(() => {
        const replacementErrors: unknown[] = [];
        try {
          this.#scheduler.setClock(clock);
        } catch (error) {
          replacementErrors.push(error);
        }
        const schedulerState = this.#scheduler.getState();
        if (
          this.#lifecycle === "mounted" &&
          schedulerState.hasClock &&
          !schedulerState.enabled &&
          this.#schedulerMayRun()
        ) {
          try {
            this.#scheduler.setEnabled(true);
          } catch (error) {
            replacementErrors.push(error);
          }
        }
        throwCollectedErrors(
          replacementErrors,
          "Playback clock replacement failed",
        );
      }, "Lyrics player playback binding failed");
    } catch (error) {
      errors.push(error);
      if (containsPlaybackSampleError(error)) {
        this.#settlePlaybackFailure(errors);
      } else if (!this.#scheduler.getState().hasClock) {
        this.#playbackError = true;
      }
    }
    if (!this.#scheduler.getState().hasClock) {
      if (errors.length === 0) this.#playbackError = false;
      this.#settlePlaybackMotion("playback-detach", errors);
      this.#resetRendererPlaybackState(errors);
    }
    this.#playbackCommands =
      this.#scheduler.getState().hasClock &&
      !errors.some((error) => containsPlaybackSampleError(error))
        ? requestedCommands
        : null;
    this.#syncLineActionability();
    try {
      this.#syncDomState();
    } catch (error) {
      errors.push(error);
    }
    throwCollectedErrors(errors, "Lyrics player playback update failed");
  }

  setOptions(
    patch: Partial<LyricsPlayerOptionsInput>,
    context: LyricsOptionsUpdateContext = {},
  ): LyricsOptionsUpdateResult {
    this.#assertMutable();
    this.#settleContentRegionInteractionForMutation();
    const previousOptions = this.#options;
    const previousSecondaryTextState = this.#secondaryTextState;
    const previousSyncedDisplayMode = this.#syncedDisplayMode;
    const previousKaraokePreAnchorMotion = this.#karaokePreAnchorMotion;
    const previousReducedMotionPreference = this.#reducedMotionPreference;
    const previousLayer = displayLayer(previousOptions.displayMode);
    const nextReducedMotionPreference =
      patch.reducedMotion === undefined
        ? previousReducedMotionPreference
        : normalizeReducedMotionPreference(patch.reducedMotion);
    const { reducedMotion: _reducedMotionPreference, ...optionsPatch } = patch;
    const nextOptions: LyricsPlayerOptions = {
      ...previousOptions,
      ...optionsPatch,
      reducedMotion: this.#resolveReducedMotionPreference(
        nextReducedMotionPreference,
      ),
    };
    const secondaryVisibilityChanged =
      previousOptions.translationVisible !== nextOptions.translationVisible ||
      previousOptions.pronunciationVisible !== nextOptions.pronunciationVisible;
    const secondaryRequest = requestSecondaryTextTransition(
      this.#secondaryTextState,
      {
        translationVisible: nextOptions.translationVisible,
        pronunciationVisible: nextOptions.pronunciationVisible,
        source: context.source ?? "api",
        nowMs: monotonicNow(this.#view?.root.ownerDocument.defaultView ?? null),
      },
    );
    if (!secondaryRequest.accepted) {
      this.#secondaryTextState = secondaryRequest.state;
      this.#syncDomState();
      return Object.freeze({
        accepted: false,
        reason: secondaryRequest.reason,
        options: Object.freeze({ ...this.#options }),
        reducedMotionPreference: this.#reducedMotionPreference,
      });
    }
    this.#secondaryTextState = secondaryRequest.state;
    this.#options = nextOptions;
    this.#reducedMotionPreference = nextReducedMotionPreference;
    if (
      previousOptions.displayMode !== nextOptions.displayMode ||
      previousOptions.reducedMotion !== nextOptions.reducedMotion
    ) {
      this.#karaokePreAnchorMotion = null;
    }
    const nextLayer = displayLayer(nextOptions.displayMode);
    // Settings-panel toggles should update immediately without the full
    // secondary-lane / row FLIP animation pipeline that freezes large songs.
    const settleForSettingsUi = context.source === "ui";
    try {
      if (nextOptions.reducedMotion && !previousOptions.reducedMotion) {
        this.#settleForReducedMotion();
      }
      this.#syncViewOptions(
        previousLayer !== nextLayer,
        settleForSettingsUi,
        previousOptions,
      );
      if (secondaryVisibilityChanged && this.#karaokePreAnchorMotion) {
        this.#karaokePreAnchorMotion = Object.freeze({
          ...this.#karaokePreAnchorMotion,
          restartRequested: true,
        });
        this.#secondaryLaneSyncKey = null;
        this.#samplePlaybackAfterMutation();
      }
      this.#syncDomState();
      // Plaintext locks CSS weight tokens; synced modes use the weight tier.
      // data-display-mode is applied in syncDomState — remeasure masks after.
      if (previousOptions.displayMode !== nextOptions.displayMode) {
        this.#invalidateGeometry();
        this.#scheduleGeometryRefresh();
      }
      this.#scheduleStableComponentAnchorCapture();
    } catch (error) {
      this.#options = previousOptions;
      this.#reducedMotionPreference = previousReducedMotionPreference;
      this.#secondaryTextState = previousSecondaryTextState;
      this.#syncedDisplayMode = previousSyncedDisplayMode;
      this.#karaokePreAnchorMotion = previousKaraokePreAnchorMotion;
      this.#rowMove.cancel("options-rollback");
      this.#secondaryLaneTransition.cancel("options-rollback");
      this.#foregroundSecondaryLaneTransition.cancel("options-rollback");
      if (secondaryVisibilityChanged) {
        this.#secondaryLaneSyncKey = null;
        this.#secondaryLaneStateByLineId.clear();
      }
      try {
        this.#syncViewOptions(false, true, nextOptions);
        this.#syncDomState();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Lyrics player options update and rollback failed",
        );
      }
      throw error;
    }
    return Object.freeze({
      accepted: true,
      reason: secondaryRequest.changed
        ? secondaryRequest.reason
        : "options-updated",
      options: Object.freeze({ ...this.#options }),
      reducedMotionPreference: this.#reducedMotionPreference,
    });
  }

  #settleForReducedMotion(): void {
    const targetLineId =
      this.#clickSeekScrollLineId ??
      this.#scrollOwner.pendingSeekLineId ??
      this.#karaokePreAnchorMotion?.targetLineId ??
      this.#clickSeekOwnership.forcedFocusLineId;

    this.#interaction?.cancelSmoothScroll("reduced-motion");
    this.#rowMove.cancel("reduced-motion");
    this.#secondaryLaneTransition.cancel("reduced-motion");
    this.#foregroundSecondaryLaneTransition.cancel("reduced-motion");
    this.#karaokePreAnchorMotion = null;
    this.#clearSeekMotion("reduced-motion");
    this.#clickSeekOwnership = clearClickSeekOwnership("reduced-motion");
    if (this.#scrollOwner.pendingSeekLineId !== null) {
      this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
        type: "seek-settled",
      });
    }

    this.#secondaryLaneSyncKey = null;
    this.#secondaryLaneStateByLineId.clear();
    this.#syncSecondaryLaneTargets(this.#playbackFrame, true);
    this.#syncForegroundSecondaryLaneTargets(true);

    if (targetLineId) {
      const layer = displayLayer(this.#options.displayMode);
      const row = this.#rowForLayer(targetLineId, layer);
      if (row) this.#anchorRowToTop(row);
    }
  }

  syncScroll(): void {
    this.#assertMutable();
    this.#settleContentRegionInteractionForMutation();
    this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, { type: "sync" });
    const row = this.#resolveVisualFocusRow();
    if (row) {
      const interaction = this.#interaction;
      if (interaction && this.#active && !this.#options.reducedMotion) {
        interaction.animateProgrammaticScroll({
          resolveTargetTop: () => this.#resolveRowTop(row),
          durationMs: CLICK_SEEK_SCROLL_DURATION_MS,
          ease: clickSeekScrollEase,
          trackTargetChanges: true,
          onSettled: () => this.#captureStableComponentAnchor(),
        });
      } else {
        this.#anchorRowToTop(row);
        this.#captureStableComponentAnchor();
      }
    }
    this.#syncDomState();
  }

  destroy(): void {
    if (this.#lifecycle === "destroyed") return;
    this.#lifecycle = "destroyed";

    const errors: unknown[] = [];
    this.#playbackSnapshot = null;
    this.#playbackFrame = null;
    this.#frameContext = null;
    this.#focusPolicyContext = null;
    this.#focusPolicy = null;
    this.#nextFrameMode = null;
    this.#schedulerOperationErrors = null;
    this.#playbackError = false;
    this.#secondaryLaneSyncKey = null;
    this.#secondaryLaneStateByLineId.clear();
    this.#playbackCommands = null;
    this.#backgroundArtworkRequestGeneration += 1;
    this.#backgroundArtworkPresent = false;
    this.#sheetCompositeMode = "normal";
    this.#sheetCompositePlainLight = null;
    this.#clearSeekMotion("destroy");
    this.#karaokePreAnchorMotion = null;
    this.#contentRegionLayoutChange = null;
    this.#clickSeekOwnership = createClickSeekOwnershipState();
    try {
      this.#detachVisibilityListener();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#detachReducedMotionMediaQuery();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#detachResizeObserver();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#scheduler.destroy();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#rowMove.destroy();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#secondaryLaneTransition.destroy();
      this.#foregroundSecondaryLaneTransition.destroy();
    } catch (error) {
      errors.push(error);
    }
    for (const resource of [
      this.#contentRegionControl,
      this.#fontProfileManager,
      this.#interaction,
      this.#crossfade,
      this.#instrumentalRenderer,
      this.#duetRenderer,
      this.#backgroundTrackRenderer,
      this.#karaokeRenderer,
      this.#lineTimedRenderer,
      this.#plaintextRenderer,
      this.#artworkBackgroundRenderer,
      this.#view,
    ]) {
      try {
        resource?.destroy();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#crossfade = null;
    this.#contentRegionControl = null;
    this.#interaction = null;
    this.#lineTimedRenderer = null;
    this.#karaokeRenderer = null;
    this.#backgroundTrackRenderer = null;
    this.#duetRenderer = null;
    this.#instrumentalRenderer = null;
    this.#plaintextRenderer = null;
    this.#artworkBackgroundRenderer = null;
    this.#fontProfileManager = null;
    this.#view = null;
    this.#layoutPlan = null;
    this.#lyrics = null;
    throwCollectedErrors(errors, "Lyrics player cleanup failed");
  }

  #assertMutable(): void {
    if (this.#lifecycle === "destroyed") {
      throw new Error("Lyrics player has been destroyed");
    }
  }

  #settleContentRegionInteractionForMutation(): void {
    const control = this.#contentRegionControl;
    if (control && control.getState().interaction !== "idle") {
      control.commitInteraction();
      return;
    }
    const change = this.#contentRegionLayoutChange;
    if (change) this.#completeContentRegionLayoutChange(change);
  }

  #detachVisibilityListener(): void {
    const document = this.#visibilityDocument;
    this.#visibilityDocument = null;
    this.#visibilityResumePending = false;
    document?.removeEventListener(
      "visibilitychange",
      this.#handleVisibilityChange,
    );
  }

  #installReducedMotionMediaQuery(ownerWindow: Window | null): void {
    this.#detachReducedMotionMediaQuery();
    const mediaQuery = ownerWindow?.matchMedia?.(REDUCED_MOTION_MEDIA_QUERY);
    this.#systemReducedMotion = mediaQuery?.matches ?? false;
    this.#options = Object.freeze({
      ...this.#options,
      reducedMotion: this.#resolveReducedMotionPreference(
        this.#reducedMotionPreference,
      ),
    });
    if (!mediaQuery) return;

    this.#reducedMotionMediaQuery = mediaQuery;
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener(
        "change",
        this.#handleReducedMotionMediaQueryChange,
      );
      this.#reducedMotionMediaQueryListenerMode = "event";
      return;
    }
    if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(this.#handleReducedMotionMediaQueryChange);
      this.#reducedMotionMediaQueryListenerMode = "legacy";
    }
  }

  #detachReducedMotionMediaQuery(): void {
    const mediaQuery = this.#reducedMotionMediaQuery;
    const listenerMode = this.#reducedMotionMediaQueryListenerMode;
    this.#reducedMotionMediaQuery = null;
    this.#reducedMotionMediaQueryListenerMode = null;
    this.#systemReducedMotion = false;
    if (!mediaQuery) return;
    if (listenerMode === "event") {
      mediaQuery.removeEventListener(
        "change",
        this.#handleReducedMotionMediaQueryChange,
      );
    } else if (listenerMode === "legacy") {
      mediaQuery.removeListener(this.#handleReducedMotionMediaQueryChange);
    }
  }

  #resolveReducedMotionPreference(
    preference: LyricsReducedMotionPreference,
  ): boolean {
    return preference === "system" ? this.#systemReducedMotion : preference;
  }

  #installResizeObserver(): void {
    const view = this.#view;
    if (!view) return;
    this.#detachResizeObserver();
    const root = view.root;
    const ownerWindow = root.ownerDocument.defaultView;
    this.#resizeWindow = ownerWindow;
    this.#componentSize = this.#measureComponentSize(root);
    this.#syncComponentHeight(this.#componentSize.heightPx);

    const ResizeObserverConstructor = ownerWindow?.ResizeObserver;
    if (ResizeObserverConstructor) {
      this.#resizeObserver = new ResizeObserverConstructor(
        this.#handleComponentResize,
      );
      this.#resizeObserver.observe(root);
      return;
    }
    ownerWindow?.addEventListener("resize", this.#handleComponentResize);
  }

  #detachResizeObserver(): void {
    const observer = this.#resizeObserver;
    const ownerWindow = this.#resizeWindow;
    const frame = this.#resizeFrame;
    const geometryRefreshFrame = this.#geometryRefreshFrame;
    const stableAnchorFrame = this.#stableAnchorFrame;
    this.#resizeObserver = null;
    this.#resizeWindow = null;
    this.#resizeFrame = 0;
    this.#geometryRefreshFrame = 0;
    this.#stableAnchorFrame = 0;
    this.#resizePending = false;
    this.#pendingComponentSize = null;
    this.#pendingResizeAnchor = null;
    this.#stableComponentAnchor = null;
    this.#componentSize = null;
    try {
      observer?.disconnect();
    } finally {
      ownerWindow?.removeEventListener("resize", this.#handleComponentResize);
      if (frame !== 0) ownerWindow?.cancelAnimationFrame(frame);
      if (geometryRefreshFrame !== 0) {
        ownerWindow?.cancelAnimationFrame(geometryRefreshFrame);
      }
      if (stableAnchorFrame !== 0) {
        ownerWindow?.cancelAnimationFrame(stableAnchorFrame);
      }
    }
  }

  #scheduleComponentResize(): void {
    if (!this.#active) return;
    if (this.#resizeFrame !== 0) return;
    const ownerWindow = this.#resizeWindow;
    if (!ownerWindow) {
      this.#flushComponentResize();
      return;
    }
    this.#resizeFrame = ownerWindow.requestAnimationFrame(() => {
      this.#resizeFrame = 0;
      this.#flushComponentResize();
    });
  }

  #flushComponentResize(): void {
    const view = this.#view;
    if (this.#lifecycle !== "mounted" || !this.#active || !view) return;
    const pendingAnchor = this.#pendingResizeAnchor;
    const observedSize = this.#pendingComponentSize;
    this.#resizePending = false;
    this.#pendingComponentSize = null;
    this.#pendingResizeAnchor = null;
    const nextSize = observedSize ?? this.#measureComponentSize(view.root);
    const previousSize = this.#componentSize;
    if (
      previousSize &&
      Math.abs(nextSize.widthPx - previousSize.widthPx) < 0.01 &&
      Math.abs(nextSize.heightPx - previousSize.heightPx) < 0.01
    ) {
      return;
    }

    const layer = displayLayer(this.#options.displayMode);
    const viewport = this.#viewportForLayer(layer);
    const anchorRow = this.#selectComponentResizeAnchorRow(layer);
    const shouldDockFocus =
      layer === "synced" &&
      this.#scrollOwner.autoFollow &&
      anchorRow === this.#resolveVisualFocusRow(layer);
    const anchor =
      !shouldDockFocus && pendingAnchor?.layer === layer
        ? pendingAnchor.anchor
        : captureScrollAnchor(viewport, anchorRow);

    this.#interaction?.cancelSmoothScroll("component-resize");
    this.#rowMove.cancel("component-resize");
    this.#secondaryLaneTransition.cancel("component-resize");
    this.#foregroundSecondaryLaneTransition.cancel("component-resize");
    // A pre-anchor's semantic target is already committed beneath its FLIP.
    // Keep that ownership through the authored handoff instead of requesting
    // a second motion from geometry that has just been settled.
    if (this.#clickSeekMotionPhase !== null) {
      this.#clearSeekMotion("component-resize");
      if (this.#scrollOwner.pendingSeekLineId !== null) {
        this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
          type: "seek-settled",
        });
      }
    }
    this.#syncComponentHeight(nextSize.heightPx);
    void view.root.offsetHeight;
    // Resize often changes container-query font size. Always remeasure karaoke
    // masks; ResizeObserver alone can lag one frame and leave end-glyph clips.
    this.#invalidateGeometry();
    if (anchor) {
      const currentAnchorRow = this.#rowForLayer(anchor.lineId, layer);
      if (shouldDockFocus && currentAnchorRow) {
        this.#anchorRowToTop(currentAnchorRow);
      } else {
        this.#restoreScrollAnchor(viewport, currentAnchorRow, anchor);
      }
    }
    this.#componentSize = nextSize;
    this.#scheduleGeometryRefresh();
    this.#syncDomState();
    this.#captureStableComponentAnchor();
  }

  #scheduleStableComponentAnchorCapture(): void {
    if (!this.#active) return;
    if (this.#stableAnchorFrame !== 0) return;
    const ownerWindow = this.#resizeWindow;
    if (!ownerWindow) {
      this.#captureStableComponentAnchor();
      return;
    }
    this.#stableAnchorFrame = ownerWindow.requestAnimationFrame(() => {
      this.#stableAnchorFrame = 0;
      this.#captureStableComponentAnchor();
    });
  }

  #captureStableComponentAnchor(): void {
    const view = this.#view;
    if (this.#lifecycle !== "mounted" || !this.#active || !view) return;
    const layer = displayLayer(this.#options.displayMode);
    const viewport = this.#viewportForLayer(layer);
    const row = this.#selectComponentResizeAnchorRow(layer);
    const anchor = captureScrollAnchor(viewport, row);
    this.#stableComponentAnchor = anchor
      ? Object.freeze({ layer, anchor })
      : null;
  }

  #measureComponentSize(root: HTMLElement): ComponentSize {
    // The fallback is intentionally layout-based: client* cannot be polluted
    // by a host transform. ResizeObserver supplies fractional dimensions on
    // browsers that support container queries.
    return this.#normalizeComponentSize(root.clientWidth, root.clientHeight);
  }

  #normalizeComponentSize(widthPx: number, heightPx: number): ComponentSize {
    return Object.freeze({
      widthPx: Number.isFinite(widthPx) ? Math.max(0, widthPx) : 0,
      heightPx: Number.isFinite(heightPx) ? Math.max(0, heightPx) : 0,
    });
  }

  #syncComponentHeight(heightPx: number): void {
    const host = this.#view?.instanceHost;
    if (!host) return;
    if (!Number.isFinite(heightPx) || heightPx <= 0) {
      host.style.removeProperty("--am-lp-component-height");
      return;
    }
    host.style.setProperty(
      "--am-lp-component-height",
      `${Number(heightPx.toFixed(3))}px`,
    );
  }

  #cancelComponentFrames(): void {
    const ownerWindow = this.#resizeWindow;
    if (this.#resizeFrame !== 0) {
      ownerWindow?.cancelAnimationFrame(this.#resizeFrame);
      this.#resizeFrame = 0;
    }
    if (this.#stableAnchorFrame !== 0) {
      ownerWindow?.cancelAnimationFrame(this.#stableAnchorFrame);
      this.#stableAnchorFrame = 0;
    }
    if (this.#geometryRefreshFrame !== 0) {
      ownerWindow?.cancelAnimationFrame(this.#geometryRefreshFrame);
      this.#geometryRefreshFrame = 0;
    }
    this.#resizePending = false;
    this.#pendingComponentSize = null;
    this.#pendingResizeAnchor = null;
  }

  #scheduleGeometryRefresh(): void {
    if (!this.#active || this.#geometryRefreshFrame !== 0) return;
    const ownerWindow = this.#resizeWindow;
    if (!ownerWindow) {
      this.#invalidateGeometry();
      return;
    }
    this.#geometryRefreshFrame = ownerWindow.requestAnimationFrame(() => {
      this.#geometryRefreshFrame = 0;
      if (this.#lifecycle !== "mounted" || !this.#active) return;
      void this.#view?.root.offsetHeight;
      this.#invalidateGeometry();
    });
  }

  #refreshComponentSizeForActivation(): void {
    const root = this.#view?.root;
    if (!root) return;
    this.#resizePending = true;
    this.#pendingComponentSize = this.#measureComponentSize(root);
    this.#pendingResizeAnchor = null;
    this.#flushComponentResize();
    this.#captureStableComponentAnchor();
  }

  #schedulerMayRun(): boolean {
    return (
      this.#lifecycle === "mounted" &&
      this.#active &&
      this.#visibilityDocument?.visibilityState !== "hidden"
    );
  }

  #backgroundMayRun(): boolean {
    return (
      this.#lifecycle === "mounted" &&
      this.#active &&
      this.#surfaceMode !== "transparent"
    );
  }

  #requestPlaybackFrame(callback: FrameRequestCallback): number {
    const ownerWindow = this.#view?.root.ownerDocument.defaultView;
    if (!ownerWindow) {
      throw new Error("Lyrics player mount window is unavailable");
    }
    return ownerWindow.requestAnimationFrame(callback);
  }

  #cancelPlaybackFrame(handle: number): void {
    const ownerWindow = this.#view?.root.ownerDocument.defaultView;
    if (!ownerWindow) {
      throw new Error("Lyrics player mount window is unavailable");
    }
    ownerWindow.cancelAnimationFrame(handle);
  }

  #runSchedulerOperation(operation: () => void, message: string): void {
    if (this.#schedulerOperationErrors) {
      operation();
      return;
    }

    const errors: unknown[] = [];
    this.#schedulerOperationErrors = errors;
    try {
      operation();
    } catch (error) {
      errors.push(error);
    } finally {
      this.#schedulerOperationErrors = null;
    }
    throwCollectedErrors(errors, message);
  }

  #samplePlaybackAfterMutation(): void {
    if (this.#lifecycle !== "mounted") return;
    const schedulerState = this.#scheduler.getState();
    if (!schedulerState.hasClock || !this.#schedulerMayRun()) return;
    this.#runSchedulerOperation(
      () => {
        if (this.#scheduler.getState().enabled) this.#scheduler.sample();
        else this.#scheduler.setEnabled(true);
      },
      "Lyrics playback sample failed",
    );
  }

  #handleSchedulerError(error: unknown): void {
    const playbackError = new PlaybackSampleError(error);
    if (this.#schedulerOperationErrors) {
      this.#schedulerOperationErrors.push(playbackError);
      return;
    }
    const errors: unknown[] = [playbackError];
    this.#settlePlaybackFailure(errors);
  }

  #settlePlaybackFailure(errors: unknown[]): void {
    this.#playbackError = true;
    this.#playbackSnapshot = null;
    this.#playbackFrame = null;
    this.#focusPolicy = null;
    this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
      type: "reset",
      reason: "playback-failure",
    });
    this.#nextFrameMode = "reset";
    this.#settlePlaybackMotion("playback-failure", errors);
    try {
      this.#scheduler.setEnabled(false);
    } catch (error) {
      errors.push(error);
    }
    this.#resetRendererPlaybackState(errors);
    try {
      this.#syncDomState();
    } catch (error) {
      errors.push(error);
    }
  }

  #syncViewDocument(): void {
    this.#secondaryLaneSyncKey = null;
    this.#secondaryLaneStateByLineId.clear();
    this.#lineTimedRenderer?.setDocument(this.#lyrics, this.#layoutPlan);
    this.#plaintextRenderer?.setDocument(this.#lyrics, this.#layoutPlan);
    this.#karaokeRenderer?.setDocument(this.#lyrics);
    this.#backgroundTrackRenderer?.setDocument(this.#lyrics);
    this.#duetRenderer?.setDocument(this.#lyrics);
    this.#instrumentalRenderer?.setDocument(this.#lyrics, this.#layoutPlan);
    const visibility = this.#secondaryVisibility();
    this.#lineTimedRenderer?.setSecondaryVisibility(visibility);
    this.#plaintextRenderer?.setSecondaryVisibility(visibility);
    this.#syncLineActionability();
    this.#karaokeRenderer?.setPaintMode(
      this.#syncedDisplayMode === "lrc" ? "line" : "karaoke",
    );
    this.#backgroundTrackRenderer?.setPaintMode(
      this.#syncedDisplayMode === "lrc" ? "line" : "karaoke",
    );
    this.#syncSecondaryLaneTargets(this.#playbackFrame, true);
    this.#syncForegroundSecondaryLaneTargets(true);
  }

  #syncViewOptions(
    animateDisplayChange: boolean,
    forceSettle = false,
    previousOptions: LyricsPlayerOptions = this.#options,
  ): void {
    const view = this.#view;
    if (!view) return;
    const previousLayer = displayLayer(previousOptions.displayMode);
    const layer = displayLayer(this.#options.displayMode);
    const secondaryChanged =
      previousOptions.translationVisible !== this.#options.translationVisible ||
      previousOptions.pronunciationVisible !==
        this.#options.pronunciationVisible;
    const anchorRow = this.#selectLayoutAnchorRow(previousLayer);
    const anchor = captureScrollAnchor(
      this.#viewportForLayer(previousLayer),
      anchorRow,
    );
    const rowHosts = secondaryChanged
      ? this.#collectRowMoveHosts(
          previousLayer,
          anchorRow?.dataset.lineId ? [anchorRow.dataset.lineId] : [],
        )
      : [];
    // forceSettle (settings-panel source) skips the FLIP pipeline for cost,
    // but if a row FLIP is already mid-flight, begin() cancels it and a
    // non-animated complete() teleports the rows to their end positions.
    // Continue with a short animation instead: capture-before-cancel means
    // the continuation starts from the current interpolated position.
    const rowMoveWasRunning = this.#rowMove.getState().animationCount > 0;
    const animateLayout =
      secondaryChanged &&
      this.#active &&
      !this.#options.reducedMotion &&
      (rowMoveWasRunning ||
        (!forceSettle &&
          this.#canAnimatePlaybackTransition(
            this.#playbackFrame?.mode ?? "bind",
          )));
    const rowTransaction = secondaryChanged
      ? this.#rowMove.begin(rowHosts, {
          reason: "secondary-text-layout",
          animate: animateLayout,
          durationMs: forceSettle && rowMoveWasRunning
            ? Math.round(SECONDARY_TEXT_LAYOUT_DURATION_MS / 2)
            : SECONDARY_TEXT_LAYOUT_DURATION_MS,
          anchorAdapterIndex: this.#adapterIndexForRow(anchorRow),
        })
      : null;
    const secondaryFocusLineId =
      this.#karaokePreAnchorMotion?.visualStyleFocusLineId ??
      this.#focusPolicy?.visualStyleFocusLineId ??
      this.#playbackFrame?.focusLineId ??
      null;
    const allForegroundLaneHosts = secondaryChanged
      ? this.#collectForegroundSecondaryLaneHosts()
      : [];
    const focusForegroundLaneHosts = secondaryFocusLineId
      ? allForegroundLaneHosts.filter(
          (host) => host.lineId === secondaryFocusLineId,
        )
      : allForegroundLaneHosts;
    // During an instrumental gap the focus row has no foreground lane, so the
    // focus filter came back empty and every lane settled instantly — toggling
    // translation/pronunciation mid-interlude showed no 420ms transition.
    // Fall back to the viewport window (same bound as row-move capture) so the
    // visible rows still animate without paying for the whole document.
    const foregroundLaneHosts =
      focusForegroundLaneHosts.length > 0 || allForegroundLaneHosts.length === 0
        ? focusForegroundLaneHosts
        : (() => {
            const visibleLineIds = new Set(
              this.#collectRowMoveHosts("synced", []).map(
                (host) => host.lineId,
              ),
            );
            return allForegroundLaneHosts.filter((host) =>
              visibleLineIds.has(host.lineId),
            );
          })();
    const foregroundAnimatedLineIds = new Set(
      foregroundLaneHosts.map((host) => host.lineId),
    );
    const directForegroundLaneHosts = allForegroundLaneHosts.filter(
      (host) => !foregroundAnimatedLineIds.has(host.lineId),
    );
    const foregroundLanePresentation = secondaryChanged
      ? this.#foregroundSecondaryLaneTransition.capture(foregroundLaneHosts)
      : undefined;
    const laneLineIds = secondaryChanged
      ? this.#pendingSecondaryLaneLineIds(
          this.#playbackFrame,
          secondaryFocusLineId,
        )
      : new Set<string>();
    const animatedLaneLineIds =
      animateLayout && layer === "synced"
        ? this.#animatableSecondaryLaneLineIds(
            this.#playbackFrame,
            secondaryFocusLineId,
            laneLineIds,
          )
        : new Set<string>();
    const directLaneLineIds = new Set(
      [...laneLineIds].filter((lineId) => !animatedLaneLineIds.has(lineId)),
    );
    const laneHosts = secondaryChanged
      ? this.#collectSecondaryLaneHosts(animatedLaneLineIds)
      : [];
    const directLaneHosts = secondaryChanged
      ? this.#collectSecondaryLaneHosts(directLaneLineIds)
      : [];
    const lanePresentation = secondaryChanged
      ? this.#secondaryLaneTransition.capture(laneHosts)
      : undefined;
    const visibility = this.#secondaryVisibility();
    this.#artworkBackgroundRenderer?.setActive(this.#backgroundMayRun());
    view.setReducedMotion(this.#options.reducedMotion);
    this.#artworkBackgroundRenderer?.setReducedMotion(
      this.#options.reducedMotion,
    );
    this.#artworkBackgroundRenderer?.setAppearance(
      this.#options.backgroundAppearance,
    );
    view.setSecondaryVisibility(
      visibility.translationVisible,
      visibility.pronunciationVisible,
    );
    this.#lineTimedRenderer?.setSecondaryVisibility(visibility);
    this.#plaintextRenderer?.setSecondaryVisibility(visibility);
    // Display mode affects seek affordance (plaintext never seekable).
    if (previousOptions.displayMode !== this.#options.displayMode) {
      this.#syncLineActionability();
    }
    const targetSyncedMode =
      this.#options.displayMode === "plaintext"
        ? this.#syncedDisplayMode
        : this.#options.displayMode;
    const syncedModeChanged = targetSyncedMode !== this.#syncedDisplayMode;
    const paintMode = targetSyncedMode === "lrc" ? "line" : "karaoke";
    // 整行 uses a fixed move interval; morph karaoke→line with that same
    // fixed window so the mode switch cadence matches native whole-line.
    const paintModeOptions = {
      // Animate paint morph even when paused; karaoke renderer drives a short
      // rAF loop so the transition does not stall without playback frames.
      animate:
        this.#active &&
        syncedModeChanged &&
        !forceSettle &&
        this.#contentRegionLayoutChange === null,
      playing: this.#playbackSnapshot?.playing ?? false,
      reducedMotion: this.#options.reducedMotion,
      durationMs:
        paintMode === "line"
          ? LINE_MOVE_MAX_DURATION_MS
          : Math.round(LINE_MOVE_MAX_DURATION_MS * 0.48),
    };
    const shouldSyncPaintMode =
      syncedModeChanged ||
      forceSettle ||
      (this.#options.reducedMotion && !previousOptions.reducedMotion);
    if (shouldSyncPaintMode) {
      this.#karaokeRenderer?.setPaintMode(
        paintMode,
        paintModeOptions,
      );
      this.#backgroundTrackRenderer?.setPaintMode(
        paintMode,
        paintModeOptions,
      );
    }
    this.#syncedDisplayMode = targetSyncedMode;

    if (secondaryChanged) {
      const update = this.#prepareSecondaryLaneUpdate(
        this.#playbackFrame,
        secondaryFocusLineId,
        lanePresentation,
        laneHosts,
        directLaneHosts,
      );
      const anchorDocumentIndex = anchor
        ? this.#layoutPlan?.getByLineId(anchor.lineId)?.documentIndex ?? 0
        : 0;
      const foregroundTargets = this.#foregroundSecondaryLaneTargets(
        allForegroundLaneHosts,
      );
      const foregroundPlan = this.#foregroundSecondaryLaneTransition.prepare(
        foregroundLaneHosts,
        foregroundTargets,
        foregroundLanePresentation,
      );
      const futureLaneDelta =
        animateLayout && layer === "synced"
          ? (update?.prepared.layoutDeltaBefore(anchorDocumentIndex) ?? 0) +
            foregroundPlan.layoutDeltaBefore(anchorDocumentIndex)
          : 0;
      this.#commitSecondaryLaneUpdate(update, {
        durationMs: SECONDARY_TEXT_LAYOUT_DURATION_MS,
        frameMode: animateLayout
          ? "playback"
          : this.#playbackFrame?.mode ?? "bind",
        ...(animateLayout ? { playing: true } : {}),
      });
      this.#foregroundSecondaryLaneTransition.transition(foregroundPlan, {
        playing: animateLayout || (this.#playbackSnapshot?.playing ?? false),
        frameMode: animateLayout
          ? "playback"
          : this.#playbackFrame?.mode ?? "bind",
        reducedMotion: this.#options.reducedMotion,
        durationMs: SECONDARY_TEXT_LAYOUT_DURATION_MS,
        directTargets: {
          hosts: directForegroundLaneHosts,
          targets: foregroundTargets,
          invalidateLineIds: directForegroundLaneHosts.map(
            (host) => host.lineId,
          ),
        },
        onGeometryInvalidated: (lineIds) => this.#invalidateGeometry(lineIds),
      });
      if (
        anchor &&
        this.#interaction?.getState().smoothScrollRunning !== true
      ) {
        // A running auto-scroll re-resolves its target every frame from
        // offsetTop layout coordinates, so it absorbs the lane-height change
        // by itself. Writing scrollTop here would go through
        // setProgrammaticScrollTop -> cancelSmoothScroll and freeze the
        // animation at its midpoint (the visible mid-scroll jump).
        const targetRow = this.#rowForLayer(anchor.lineId, layer);
        this.#interaction?.setViewport(this.#viewportForLayer(layer));
        this.#restoreScrollAnchor(
          this.#viewportForLayer(layer),
          targetRow,
          anchor,
          futureLaneDelta,
        );
      }
    }

    const targetViewport = this.#viewportForLayer(layer);
    this.#interaction?.setViewport(targetViewport);
    if (
      anchor &&
      !secondaryChanged &&
      this.#interaction?.getState().smoothScrollRunning !== true
    ) {
      const targetRow = this.#rowForLayer(anchor.lineId, layer);
      this.#restoreScrollAnchor(targetViewport, targetRow, anchor);
    }
    if (rowTransaction) {
      this.#rowMove.complete(
        rowTransaction,
        this.#collectRowMoveHosts(
          previousLayer,
          anchorRow?.dataset.lineId ? [anchorRow.dataset.lineId] : [],
        ),
        {
          forceZeroDelay: true,
          onSettled: () => this.#captureStableComponentAnchor(),
        },
      );
    }

    if (forceSettle || !this.#active || this.#options.reducedMotion) {
      this.#crossfade?.settle(layer);
    } else if (animateDisplayChange) {
      this.#crossfade?.transitionTo(layer, {
        reducedMotion: this.#options.reducedMotion,
      });
    }

    if (this.#playbackFrame) {
      this.#lineTimedRenderer?.renderFrame(this.#playbackFrame, {
        reducedMotion: this.#options.reducedMotion,
        ...(this.#karaokePreAnchorMotion
          ? {
              scaleActiveLineIds:
                this.#karaokePreAnchorMotion.scaleActiveLineIds,
            }
          : {}),
      });
      this.#karaokeRenderer?.renderFrame(this.#playbackFrame, {
        reducedMotion: this.#options.reducedMotion,
        playing: this.#playbackSnapshot?.playing ?? false,
      });
      this.#backgroundTrackRenderer?.renderFrame(this.#playbackFrame, {
        reducedMotion: this.#options.reducedMotion,
        playing: this.#playbackSnapshot?.playing ?? false,
      });
      this.#duetRenderer?.renderFrame(this.#playbackFrame);
      this.#instrumentalRenderer?.renderFrame(this.#playbackFrame, {
        reducedMotion: this.#options.reducedMotion,
        playing: this.#playbackSnapshot?.playing ?? false,
      });
    }
  }

  #secondaryVisibility(): SecondaryTextVisibility {
    return Object.freeze({
      translationVisible: this.#options.translationVisible,
      pronunciationVisible: this.#options.pronunciationVisible,
    });
  }

  #syncLineActionability(): void {
    const document = this.#lyrics;
    if (!document) return;
    const commandsAvailable = this.#playbackCommands !== null;
    // Plaintext is a static poem view: never seekable and never press-styled.
    const plaintextSeekEnabled = false;
    const syncedSeekEnabled =
      commandsAvailable && this.#options.displayMode !== "plaintext";
    for (const line of document.lines) {
      const syncedActionable =
        syncedSeekEnabled && isClickSeekEligible(line);
      setRowSeekActionable(
        this.#lineTimedRenderer?.getRow(line.id) ?? null,
        syncedActionable,
      );
      // Karaoke rows live under line-timed hosts in the synced layer.
      setRowSeekActionable(
        this.#plaintextRenderer?.getRow(line.id) ?? null,
        plaintextSeekEnabled,
      );
    }
  }

  #resetRendererPlaybackState(errors: unknown[]): void {
    for (const renderer of [
      this.#lineTimedRenderer,
      this.#karaokeRenderer,
      this.#backgroundTrackRenderer,
      this.#duetRenderer,
      this.#instrumentalRenderer,
    ]) {
      try {
        renderer?.resetPlaybackState();
      } catch (error) {
        errors.push(error);
      }
    }
  }

  #settlePlaybackMotion(reason: string, errors: unknown[]): void {
    this.#karaokePreAnchorMotion = null;
    this.#secondaryLaneSyncKey = null;
    this.#secondaryLaneStateByLineId.clear();
    for (const settle of [
      () => this.#rowMove.cancel(reason),
      () => this.#secondaryLaneTransition.cancel(reason),
      () => this.#foregroundSecondaryLaneTransition.cancel(reason),
      () => this.#syncSecondaryLaneTargets(null, true),
      () => this.#syncForegroundSecondaryLaneTargets(true),
      () => this.#crossfade?.settle(displayLayer(this.#options.displayMode)),
      () =>
        this.#karaokeRenderer?.setPaintMode(
          this.#syncedDisplayMode === "lrc" ? "line" : "karaoke",
          { animate: false, playing: false, reducedMotion: true },
        ),
      () =>
        this.#backgroundTrackRenderer?.setPaintMode(
          this.#syncedDisplayMode === "lrc" ? "line" : "karaoke",
          { animate: false, playing: false, reducedMotion: true },
        ),
    ]) {
      try {
        settle();
      } catch (error) {
        errors.push(error);
      }
    }
  }

  #syncDomState(): void {
    const root = this.#view?.root;
    if (!root) return;
    const set = (key: string, value: string | undefined): void =>
      setDatasetValue(root, key, value);

    set("state", this.#lyrics ? "ready" : "empty");
    set("active", String(this.#active));
    set("displayMode", this.#options.displayMode);
    set("surfaceMode", this.#surfaceMode);
    set("backgroundAppearance", this.#options.backgroundAppearance);
    set("backgroundPerformanceMode", this.#backgroundPerformanceMode);
    set(
      "backgroundArtwork",
      this.#backgroundArtworkPresent ? "present" : "none",
    );
    this.#syncSheetComposite(root);
    const karaokeTrackCount = this.#karaokeRenderer?.getTrackCount() ?? 0;
    const karaokeFallbackTrackCount =
      this.#karaokeRenderer?.getFallbackTrackCount() ?? 0;
    const backgroundTrackCount =
      this.#backgroundTrackRenderer?.getTrackCount() ?? 0;
    const backgroundFallbackTrackCount =
      this.#backgroundTrackRenderer?.getFallbackTrackCount() ?? 0;
    set(
      "effectiveRenderer",
      this.#options.displayMode === "plaintext"
        ? "plaintext"
        : this.#options.displayMode === "lrc"
          ? "line-timed"
          : karaokeTrackCount > 0
            ? karaokeFallbackTrackCount > 0
              ? "karaoke-with-line-fallback"
              : "karaoke"
            : "line-timed-fallback",
    );
    set("translationVisible", String(this.#options.translationVisible));
    set(
      "pronunciationVisible",
      String(this.#options.pronunciationVisible),
    );
    set("reducedMotion", String(this.#options.reducedMotion));
    set("reducedMotionPreference", String(this.#reducedMotionPreference));
    set(
      "translationCooldownActive",
      isTranslationToggleCooldownActive(
        this.#secondaryTextState,
        monotonicNow(root.ownerDocument.defaultView),
      ).toString(),
    );
    set(
      "translationCooldownUntilMs",
      String(this.#secondaryTextState.cooldownUntilMs),
    );
    set("lineCount", String(this.#lyrics?.lines.length ?? 0));
    set(
      "syncedRowCount",
      String(this.#lineTimedRenderer?.getRowCount() ?? 0),
    );
    set("karaokeTrackCount", String(karaokeTrackCount));
    set("karaokeFallbackTrackCount", String(karaokeFallbackTrackCount));
    set("backgroundTrackCount", String(backgroundTrackCount));
    set("backgroundFallbackTrackCount", String(backgroundFallbackTrackCount));
    set(
      "plaintextRowCount",
      String(this.#plaintextRenderer?.getRowCount() ?? 0),
    );
    set(
      "agentMapAvailable",
      String(this.#layoutPlan?.agentMapAvailable ?? false),
    );
    const schedulerState = this.#scheduler.getState();
    set("schedulerEnabled", String(schedulerState.enabled));
    set("playbackError", String(this.#playbackError));
    const instrumentalState = this.#instrumentalRenderer?.getState();
    set(
      "instrumentalPresence",
      instrumentalState?.session.presence ?? "absent",
    );
    set("instrumentalPhase", instrumentalState?.animation?.phase ?? "hidden");
    const crossfadeState = this.#crossfade?.getState();
    set("activeLayer", crossfadeState?.targetLayer ?? "synced");
    set("scrollOwner", this.#scrollOwner.owner);
    set("autoFollow", String(this.#scrollOwner.autoFollow));
    set("manualScrollLocked", String(this.#scrollOwner.manualScrollLocked));
    set(
      "manualScrollOutOfSync",
      String(this.#scrollOwner.manualScrollOutOfSync),
    );
    set("pendingSeekLineId", this.#scrollOwner.pendingSeekLineId ?? "");
    set("scrollReason", this.#scrollOwner.lastReason);
    set(
      "clickSeekScrollRunning",
      String(this.#clickSeekScrollLineId !== null),
    );
    set("seekMotionOrigin", this.#seekMotionOrigin ?? "");
    set(
      "clickSeekForcedFocusLineId",
      this.#clickSeekOwnership.forcedFocusLineId ?? "",
    );
    set(
      "karaokePreAnchorLineId",
      this.#karaokePreAnchorMotion?.targetLineId ?? "",
    );
    set(
      "karaokePreAnchorBeginMs",
      this.#karaokePreAnchorMotion
        ? String(this.#karaokePreAnchorMotion.authoredBeginMs)
        : "",
    );
    const interactionState = this.#interaction?.getState();
    set(
      "manualScrollActive",
      String(interactionState?.manualScrollActive ?? false),
    );
    const rowMoveState = this.#rowMove.getState();
    set("rowMoveRunning", String(rowMoveState.running));
    set("rowMoveAnimationCount", String(rowMoveState.animationCount));
    set("rowMoveReason", rowMoveState.reason);
    const laneAnimationCount =
      this.#secondaryLaneTransition.getAnimationCount();
    set("secondaryLaneRunning", String(laneAnimationCount > 0));
    set("secondaryLaneAnimationCount", String(laneAnimationCount));
    const displayTransition =
      this.#karaokeRenderer?.getDisplayModeTransitionState();
    set(
      "displayModeTransitionRunning",
      String(displayTransition?.running ?? false),
    );
    set(
      "displayModeLineMix",
      String(
        displayTransition?.lineMix ??
          (this.#syncedDisplayMode === "lrc" ? 1 : 0),
      ),
    );
    set("visualFocusLineId", this.#focusPolicy?.visualFocusLineId ?? "");
    set(
      "visualStyleFocusLineId",
      this.#focusPolicy?.visualStyleFocusLineId ?? "",
    );
    set("focusPolicyReason", this.#focusPolicy?.reason ?? "none");

    if (this.#playbackSnapshot) {
      set("playing", String(this.#playbackSnapshot.playing));
      set("playbackRevision", String(this.#playbackSnapshot.revision));
    } else {
      set("playing", undefined);
      set("playbackRevision", undefined);
    }

    if (this.#playbackFrame) {
      set(
        "playbackPositionMs",
        String(Math.round(this.#playbackFrame.playbackPositionMs)),
      );
      set(
        "activeLineCount",
        String(this.#playbackFrame.activeLineIds.size),
      );
      set(
        "focusLineId",
        this.#focusPolicy?.visualFocusLineId ??
          this.#playbackFrame.focusLineId ??
          "",
      );
      set("frameMode", this.#playbackFrame.mode);
    } else {
      set("playbackPositionMs", undefined);
      set("activeLineCount", undefined);
      set("focusLineId", undefined);
      set("frameMode", undefined);
    }
  }

  #syncSheetComposite(root: HTMLElement): void {
    // AM sheet composite (plus-lighter gain): plain light solid → normal;
    // artwork or dark → add. mix-blend-mode is not transitionable; prior
    // defer/brightness-ramp attempts did not fix solid→cover and are reverted.
    const plainLight =
      !this.#backgroundArtworkPresent &&
      this.#options.backgroundAppearance === "light";
    this.#sheetCompositePlainLight = plainLight;
    this.#sheetCompositeMode = plainLight ? "normal" : "add";
    setDatasetValue(root, "sheetComposite", this.#sheetCompositeMode);
  }

  #handlePlaybackSample(
    snapshot: PlaybackSnapshot,
    cause: FrameSampleCause,
  ): void {
    const visibilityResume =
      this.#visibilityResumePending &&
      this.#visibilityDocument?.visibilityState !== "hidden";
    if (visibilityResume) this.#visibilityResumePending = false;
    const context = this.#frameContext;
    let nextFrame: PlaybackFrame | null = null;
    let nextFocusPolicy: FocusPolicyState | null = null;
    let linePreAnchor: KaraokeLinePreAnchor | null = null;
    let sameSourceReplay = false;
    let sameSourceReplayViewport: HTMLElement | null = null;
    let sameSourceReplayAnchor: ScrollAnchorSnapshot | null = null;
    if (context) {
      const previousFrame = this.#playbackFrame;
      const discontinuity = snapshot.discontinuity;
      sameSourceReplay = Boolean(
        !visibilityResume &&
          this.#options.displayMode !== "plaintext" &&
          !this.#options.reducedMotion &&
          this.#scrollOwner.autoFollow &&
          !this.#scrollOwner.manualScrollLocked &&
          this.#scrollOwner.pendingSeekLineId === null &&
          this.#clickSeekScrollLineId === null &&
          previousFrame !== null &&
          previousFrame.documentId === context.document.id &&
          discontinuity !== null &&
          discontinuity.reason === "loop" &&
          discontinuity.sequence !== previousFrame.discontinuity?.sequence &&
          previousFrame.playbackPositionMs > snapshot.positionMs + 0.5,
      );
      if (sameSourceReplay) {
        if (!this.#view) {
          sameSourceReplay = false;
        } else {
          sameSourceReplayViewport = this.#viewportForLayer("synced");
          sameSourceReplayAnchor = captureScrollAnchor(
            sameSourceReplayViewport,
            this.#selectLayoutAnchorRow("synced"),
          );
          // Without a stable pre-reset row there is nothing to preserve. Let
          // the normal reset anchoring policy handle an empty/unmounted view.
          if (sameSourceReplayAnchor === null) sameSourceReplay = false;
        }
      }
      const explicitMode =
        this.#nextFrameMode ??
        (cause === "clock-replaced" ? "bind" : undefined);
      nextFrame = createPlaybackFrame(context, {
        snapshot,
        previousFrame,
        ...(explicitMode ? { mode: explicitMode } : {}),
      });
      // A loop discontinuity can coexist with an explicitly requested seek or
      // bind frame. Only the normal reset classification owns replay motion;
      // other transactions keep their existing ownership rules.
      if (sameSourceReplay && nextFrame.mode !== "reset") {
        sameSourceReplay = false;
        sameSourceReplayViewport = null;
        sameSourceReplayAnchor = null;
      }
      // Pre-anchor is word-karaoke only: geometry leads while the word clock
      // stays real. Forced / native 整行 (displayMode lrc) hands off at the
      // authored line boundary with a fixed FLIP — early lead would feel like
      // karaoke intervals and desync from native whole-line cadence.
      const preAnchorDisplayMode = this.#options.displayMode === "karaoke";
      if (
        nextFrame.mode !== "playback" ||
        !snapshot.playing ||
        snapshot.rate <= 0 ||
        !preAnchorDisplayMode ||
        this.#options.reducedMotion
      ) {
        this.#karaokePreAnchorMotion = null;
      }
      if (
        !visibilityResume &&
        nextFrame.mode === "playback" &&
        snapshot.playing &&
        snapshot.rate > 0 &&
        preAnchorDisplayMode &&
        !this.#options.reducedMotion &&
        this.#clickSeekScrollLineId === null
      ) {
        linePreAnchor = resolveKaraokeLinePreAnchor(
          context.document,
          context.timeIndex,
          nextFrame.playbackPositionMs,
        );
      }
      const seekTransactionActive =
        this.#clickSeekScrollLineId !== null &&
        this.#clickSeekMotionPhase !== null;
      const navigationDiscontinuity = snapshot.discontinuity;
      const navigationDiscontinuitySequence =
        navigationDiscontinuity &&
        (navigationDiscontinuity.reason === "seek" ||
          navigationDiscontinuity.reason === "loop")
          ? navigationDiscontinuity.sequence
          : null;
      const ownsInitialSeekFrame =
        seekTransactionActive &&
        this.#clickSeekMotionPhase === "pending" &&
        (this.#nextFrameMode === "seek" ||
          this.#seekMotionOrigin === "external" ||
          nextFrame.mode === "seek");
      if (
        ownsInitialSeekFrame &&
        navigationDiscontinuitySequence !== null &&
        navigationDiscontinuitySequence > this.#clickSeekDiscontinuityBaseline
      ) {
        this.#clickSeekDiscontinuitySequence =
          navigationDiscontinuitySequence;
      }
      const ownsContinuingSeekFrame =
        seekTransactionActive &&
        (this.#seekMotionOrigin === "external"
          ? // Continuous host scrub emits a new seek discontinuity sequence on
            // each confirmed jump; keep the FLIP path and retarget below.
            nextFrame.mode === "seek" ||
            navigationDiscontinuitySequence ===
              this.#clickSeekDiscontinuitySequence ||
            snapshot.seeking
          : this.#clickSeekDiscontinuitySequence !== null
            ? navigationDiscontinuitySequence ===
              this.#clickSeekDiscontinuitySequence
            : snapshot.seeking);
      const ownsCurrentSeekFrame =
        ownsInitialSeekFrame || ownsContinuingSeekFrame;
      if (
        (nextFrame.mode === "seek" || nextFrame.mode === "reset") &&
        !ownsCurrentSeekFrame
      ) {
        this.#clickSeekOwnership = clearClickSeekOwnership(
          `frame-mode-${nextFrame.mode}`,
        );
        if (this.#clickSeekMotionPhase !== null) {
          this.#interaction?.cancelSmoothScroll(
            `frame-mode-${nextFrame.mode}`,
          );
          this.#clearSeekMotion(`frame-mode-${nextFrame.mode}`);
          if (this.#scrollOwner.pendingSeekLineId !== null) {
            this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
              type: "seek-settled",
            });
          }
        }
      }
      // Host progress-bar / timeline seeks arrive as seek-mode frames without a
      // prior click-seek transaction. Arm the shared smooth path so the lyric
      // viewport does not hard-jump (focus line is resolved after focus policy).
      const canArmExternalSeekMotion =
        nextFrame.mode === "seek" &&
        this.#scrollOwner.autoFollow &&
        !this.#options.reducedMotion &&
        this.#options.displayMode !== "plaintext" &&
        !visibilityResume &&
        (this.#seekMotionOrigin === null ||
          this.#seekMotionOrigin === "external");
      // Treat an imminent external-seek arm as animating so we do not cancel an
      // in-flight playback FLIP before the seek capture can read its geometry.
      const clickSeekAnimating =
        this.#clickSeekScrollLineId !== null || canArmExternalSeekMotion;
      // LRC and karaoke share the synchronized-layer row FLIP. Only the
      // static plaintext layer should settle playback motion every frame.
      if (
        !clickSeekAnimating &&
        (nextFrame.mode !== "playback" ||
          !snapshot.playing ||
          snapshot.rate <= 0 ||
          this.#options.displayMode === "plaintext")
      ) {
        this.#rowMove.cancel(`frame-mode-${nextFrame.mode}`);
        this.#secondaryLaneTransition.cancel(`frame-mode-${nextFrame.mode}`);
        this.#foregroundSecondaryLaneTransition.cancel(
          `frame-mode-${nextFrame.mode}`,
        );
      }
      const focusContext = this.#focusPolicyContext;
      const focusFrame = this.#frameForFocusPolicy(nextFrame, snapshot.playing);
      nextFocusPolicy = focusContext
        ? advanceFocusPolicy(focusContext, this.#focusPolicy, focusFrame)
        : null;
      const ownershipAtFrameStart = this.#clickSeekOwnership;
      const rawActiveLineIds = Object.freeze(
        context.timeIndex
          .findActiveAt(nextFrame.playbackPositionMs)
          .map(({ line }) => line)
          .filter(
            (line) =>
              line.type !== "instrumental" &&
              line.type !== "credit" &&
              !isPaintSuppressedByClickSeekOwnership(
                ownershipAtFrameStart,
                context.document,
                line.id,
              ),
          )
          .map((line) => line.id),
      );
      this.#clickSeekOwnership = maybeExpireClickSeekOwnership(
        this.#clickSeekOwnership,
        context.document,
        nextFrame.playbackPositionMs,
      );
      this.#clickSeekOwnership = maybeExpireSeekScrollFloor(
        this.#clickSeekOwnership,
        context.document,
        nextFrame.playbackPositionMs,
        rawActiveLineIds,
      );
      const residualFocusLineId =
        resolveClickSeekSecondaryResidualFocusLineId(
          this.#clickSeekOwnership,
          context.document,
          nextFrame.playbackPositionMs,
          rawActiveLineIds,
        );
      if (residualFocusLineId) {
        this.#clickSeekOwnership = clearForcedClickSeekOwnership(
          this.#clickSeekOwnership,
          "released-after-foreground-done-later-main-live",
        );
      }
      const forcedFocusLineId = resolveForcedFocusLineId(
        this.#clickSeekOwnership,
        context.document,
      );
      if (forcedFocusLineId && nextFocusPolicy) {
        const focusChanged =
          this.#focusPolicy?.focusLineId !== forcedFocusLineId;
        const highlightedChanged =
          this.#focusPolicy?.highlightedLineId !== forcedFocusLineId;
        nextFocusPolicy = Object.freeze({
          ...nextFocusPolicy,
          focusLineId: forcedFocusLineId,
          highlightedLineId: forcedFocusLineId,
          visualFocusLineId: forcedFocusLineId,
          visualStyleFocusLineId: forcedFocusLineId,
          lineMoveAnchorLineId: forcedFocusLineId,
          reason: "click-seek-forced-focus-line",
          visualFocusReason: "click-seek-forced-focus-line",
          focusChanged,
          highlightedChanged,
        }) as FocusPolicyState;
      } else if (forcedFocusLineId) {
        const focusChanged =
          this.#focusPolicy?.focusLineId !== forcedFocusLineId;
        const highlightedChanged =
          this.#focusPolicy?.highlightedLineId !== forcedFocusLineId;
        nextFocusPolicy = Object.freeze({
          documentId: context.document.id,
          focusLineId: forcedFocusLineId,
          highlightedLineId: forcedFocusLineId,
          visualFocusLineId: forcedFocusLineId,
          visualStyleFocusLineId: forcedFocusLineId,
          visualFocusReason: "click-seek-forced-focus-line",
          notifyStartLineId: forcedFocusLineId,
          notifyEndLineId: forcedFocusLineId,
          lineMoveAnchorLineId: forcedFocusLineId,
          previousActiveLineIds: Object.freeze([]),
          currentActiveLineIds: Object.freeze([forcedFocusLineId]),
          intersectionLineIds: Object.freeze([]),
          currentSubsetOfPrevious: false,
          currentIsConsecutive: true,
          focusChanged,
          highlightedChanged,
          reason: "click-seek-forced-focus-line",
        }) as FocusPolicyState;
      }
      if (!forcedFocusLineId && residualFocusLineId && nextFocusPolicy) {
        const residualNotifyEndLineId =
          rawActiveLineIds.at(-1) ?? residualFocusLineId;
        const focusChanged =
          this.#focusPolicy?.focusLineId !== residualFocusLineId;
        const highlightedChanged =
          this.#focusPolicy?.highlightedLineId !== residualFocusLineId;
        nextFocusPolicy = Object.freeze({
          ...nextFocusPolicy,
          focusLineId: residualFocusLineId,
          highlightedLineId: residualFocusLineId,
          visualFocusLineId: residualFocusLineId,
          visualStyleFocusLineId: residualFocusLineId,
          notifyStartLineId: residualFocusLineId,
          notifyEndLineId: residualNotifyEndLineId,
          lineMoveAnchorLineId: residualNotifyEndLineId,
          reason: "post-forced-release-secondary-residual-redock",
          visualFocusReason:
            "post-forced-release-secondary-residual-redock",
          focusChanged,
          highlightedChanged,
        }) as FocusPolicyState;
      }
      if (!forcedFocusLineId && nextFocusPolicy) {
        const floorResolution = applySeekScrollFloor(
          this.#clickSeekOwnership,
          context.document,
          nextFocusPolicy.visualFocusLineId,
          nextFocusPolicy.visualStyleFocusLineId,
          nextFrame.playbackPositionMs,
          rawActiveLineIds,
          this.#playbackFrame?.eventActiveLineIdsInSourceOrder ?? [],
          nextFocusPolicy.focusLineId,
        );
        const floorFocusLineId = floorResolution.scrollLineId;
        if (floorResolution.reason && floorFocusLineId) {
          const floorStyleLineId =
            floorResolution.styleLineId ?? floorFocusLineId;
          const focusChanged =
            this.#focusPolicy?.focusLineId !== floorStyleLineId;
          const highlightedChanged =
            this.#focusPolicy?.highlightedLineId !== floorFocusLineId;
          nextFocusPolicy = Object.freeze({
            ...nextFocusPolicy,
            focusLineId: floorStyleLineId,
            highlightedLineId: floorFocusLineId,
            visualFocusLineId: floorFocusLineId,
            visualStyleFocusLineId: floorStyleLineId,
            reason: floorResolution.reason,
            visualFocusReason: floorResolution.reason,
            focusChanged,
            highlightedChanged,
          }) as FocusPolicyState;
        }
      }
      const instrumentalFocusHold = this.#resolveInstrumentalFocusHold(
        context.document,
        nextFrame,
        snapshot.playing,
      );
      if (instrumentalFocusHold && nextFocusPolicy) {
        const focusChanged =
          this.#focusPolicy?.focusLineId !== instrumentalFocusHold.lineId;
        const highlightedChanged =
          this.#focusPolicy?.highlightedLineId !== instrumentalFocusHold.lineId;
        nextFocusPolicy = Object.freeze({
          ...nextFocusPolicy,
          focusLineId: instrumentalFocusHold.lineId,
          highlightedLineId: instrumentalFocusHold.lineId,
          visualFocusLineId: instrumentalFocusHold.lineId,
          visualStyleFocusLineId: instrumentalFocusHold.lineId,
          notifyStartLineId: instrumentalFocusHold.lineId,
          notifyEndLineId: instrumentalFocusHold.lineId,
          lineMoveAnchorLineId: instrumentalFocusHold.lineId,
          reason: instrumentalFocusHold.reason,
          visualFocusReason: instrumentalFocusHold.reason,
          focusChanged,
          highlightedChanged,
        }) as FocusPolicyState;
      } else if (instrumentalFocusHold) {
        nextFocusPolicy = Object.freeze({
          documentId: context.document.id,
          focusLineId: instrumentalFocusHold.lineId,
          highlightedLineId: instrumentalFocusHold.lineId,
          visualFocusLineId: instrumentalFocusHold.lineId,
          visualStyleFocusLineId: instrumentalFocusHold.lineId,
          visualFocusReason: instrumentalFocusHold.reason,
          notifyStartLineId: instrumentalFocusHold.lineId,
          notifyEndLineId: instrumentalFocusHold.lineId,
          lineMoveAnchorLineId: instrumentalFocusHold.lineId,
          previousActiveLineIds: Object.freeze([]),
          currentActiveLineIds: Object.freeze([instrumentalFocusHold.lineId]),
          intersectionLineIds: Object.freeze([]),
          currentSubsetOfPrevious: false,
          currentIsConsecutive: true,
          focusChanged:
            this.#focusPolicy?.focusLineId !== instrumentalFocusHold.lineId,
          highlightedChanged:
            this.#focusPolicy?.highlightedLineId !==
            instrumentalFocusHold.lineId,
          reason: instrumentalFocusHold.reason,
        }) as FocusPolicyState;
      }
      // A click keeps its selected row as the paint/focus owner until that
      // row's authored end. That must not also suppress the next row's
      // geometry-only lead when the clicked row is its direct predecessor.
      // Keeping this allowance narrow preserves concurrent/residual ownership.
      const forcedPreAnchorCompatible = Boolean(
        linePreAnchor &&
          forcedFocusLineId === linePreAnchor.previousLineId &&
          this.#clickSeekScrollLineId === null,
      );
      const projectedPreAnchorPolicy =
        linePreAnchor &&
        focusContext &&
        (forcedFocusLineId === null || forcedPreAnchorCompatible) &&
        instrumentalFocusHold === null
          ? advanceFocusPolicy(
              focusContext,
              this.#focusPolicy,
              Object.freeze({
                ...nextFrame,
                callbackPlaybackPositionMs: linePreAnchor.authoredBeginMs,
                activeLineIdsInSourceOrder:
                  linePreAnchor.startingLineIdsInSourceOrder,
              }),
            )
          : null;
      const preAnchorAtAuthoredBegin = Boolean(
        this.#karaokePreAnchorMotion &&
          nextFrame.playbackPositionMs >=
            this.#karaokePreAnchorMotion.authoredBeginMs &&
          nextFrame.activeLineIds.has(
            this.#karaokePreAnchorMotion.targetLineId,
          ),
      )
        ? this.#karaokePreAnchorMotion
        : null;
      const preAnchorBlocked =
        (forcedFocusLineId !== null && !forcedPreAnchorCompatible) ||
        instrumentalFocusHold !== null;
      if (
        this.#karaokePreAnchorMotion &&
        (preAnchorBlocked ||
          (!preAnchorAtAuthoredBegin &&
            (!linePreAnchor ||
              linePreAnchor.targetLineId !==
                this.#karaokePreAnchorMotion.targetLineId)))
      ) {
        this.#karaokePreAnchorMotion = null;
      }
      const preAnchorNeedsRestart = Boolean(
        linePreAnchor &&
          this.#karaokePreAnchorMotion?.targetLineId ===
            linePreAnchor.targetLineId &&
          (this.#karaokePreAnchorMotion.playbackRate !== snapshot.rate ||
            this.#karaokePreAnchorMotion.restartRequested),
      );
      const preAnchorShouldStart = Boolean(
        linePreAnchor &&
          projectedPreAnchorPolicy?.visualFocusLineId &&
          !preAnchorBlocked &&
          this.#scrollOwner.autoFollow &&
          (this.#karaokePreAnchorMotion?.targetLineId !==
            linePreAnchor.targetLineId ||
            this.#karaokePreAnchorMotion.playbackRate !== snapshot.rate ||
            this.#karaokePreAnchorMotion.restartRequested),
      );
      if (preAnchorNeedsRestart) {
        this.#secondaryLaneSyncKey = null;
      }
      if (
        preAnchorShouldStart &&
        linePreAnchor &&
        projectedPreAnchorPolicy?.visualFocusLineId
      ) {
        // Row-move WAAPI interpolates scale from capture → target at complete().
        // If the outgoing line stays "active scale" for the whole pre-anchor,
        // fromScale === toScale and only translate runs; when the line later
        // becomes past (at authored begin / motion settle) the underlying CSS
        // scale snaps with no WAAPI channel → post-scroll scale jump.
        // Line-timed handoff avoids this by writing rest/active scale *before*
        // complete(). Mirror that: demote previousLineId now; keep concurrent
        // partners + the incoming target at active scale. Do not touch CSS
        // transition:none on motion-owner (that fights FLIP in all modes).
        const preAnchorScaleIds = new Set<string>([
          ...nextFrame.concurrentPrimaryTailLineIds,
          projectedPreAnchorPolicy.visualStyleFocusLineId ??
            linePreAnchor.targetLineId,
          linePreAnchor.targetLineId,
        ]);
        for (const lineId of nextFrame.activeLineIds) {
          if (lineId !== linePreAnchor.previousLineId) {
            preAnchorScaleIds.add(lineId);
          }
        }
        this.#karaokePreAnchorMotion = Object.freeze({
          targetLineId: linePreAnchor.targetLineId,
          authoredBeginMs: linePreAnchor.authoredBeginMs,
          visualFocusLineId: projectedPreAnchorPolicy.visualFocusLineId,
          visualStyleFocusLineId:
            projectedPreAnchorPolicy.visualStyleFocusLineId ??
            linePreAnchor.targetLineId,
          lineMoveAnchorLineId:
            projectedPreAnchorPolicy.lineMoveAnchorLineId ??
            linePreAnchor.targetLineId,
          scaleActiveLineIds: preAnchorScaleIds,
          playbackRate: snapshot.rate,
          restartRequested: false,
        });
      }
      const activePreAnchorMotion =
        this.#karaokePreAnchorMotion &&
        nextFrame.playbackPositionMs <
          this.#karaokePreAnchorMotion.authoredBeginMs
          ? this.#karaokePreAnchorMotion
          : null;
      let preAnchorHandoff =
        preAnchorAtAuthoredBegin && !preAnchorBlocked
          ? preAnchorAtAuthoredBegin
          : null;
      const preAnchorHandoffMatches = Boolean(
        preAnchorHandoff &&
          nextFocusPolicy?.visualFocusLineId ===
            preAnchorHandoff.visualFocusLineId &&
          (nextFocusPolicy.visualStyleFocusLineId ??
            nextFocusPolicy.visualFocusLineId) ===
            preAnchorHandoff.visualStyleFocusLineId &&
          (nextFocusPolicy.lineMoveAnchorLineId ??
            nextFocusPolicy.visualFocusLineId) ===
            preAnchorHandoff.lineMoveAnchorLineId,
      );
      if (preAnchorHandoff && !preAnchorHandoffMatches) {
        this.#karaokePreAnchorMotion = null;
        preAnchorHandoff = null;
      }
      const motionVisualFocusLineId = activePreAnchorMotion
        ? activePreAnchorMotion.visualFocusLineId
        : nextFocusPolicy?.visualFocusLineId ?? focusFrame.focusLineId;
      const motionLineMoveAnchorLineId = activePreAnchorMotion
        ? activePreAnchorMotion.lineMoveAnchorLineId
        : nextFocusPolicy?.lineMoveAnchorLineId ?? null;
      const resolvedVisualFocusLineId =
        nextFocusPolicy?.visualFocusLineId ?? focusFrame.focusLineId;
      // Host timeline seeks can land on a new focus line while an external
      // seek FLIP is still pending/running. Retarget instead of aborting so
      // continuous scrubbing stays one continuous cascade.
      if (
        canArmExternalSeekMotion &&
        resolvedVisualFocusLineId !== null &&
        this.#seekMotionOrigin !== "click"
      ) {
        if (this.#clickSeekScrollLineId === null) {
          this.#armSeekMotion(
            resolvedVisualFocusLineId,
            "external",
            navigationDiscontinuitySequence,
          );
        } else if (
          this.#seekMotionOrigin === "external" &&
          resolvedVisualFocusLineId !== this.#clickSeekScrollLineId
        ) {
          this.#retargetSeekMotion(
            resolvedVisualFocusLineId,
            navigationDiscontinuitySequence,
          );
        }
      } else if (
        this.#clickSeekScrollLineId !== null &&
        resolvedVisualFocusLineId !== null &&
        resolvedVisualFocusLineId !== this.#clickSeekScrollLineId
      ) {
        // Click-seek keeps forced paint ownership on the clicked line; if
        // focus policy already moved on, settle the click motion path.
        if (this.#clickSeekMotionPhase === "scroll") {
          this.#interaction?.cancelSmoothScroll("click-seek-focus-handoff");
        }
        this.#clearSeekMotion("click-seek-focus-handoff");
        if (this.#scrollOwner.pendingSeekLineId !== null) {
          this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
            type: "seek-settled",
          });
        }
      }
      const resolvedFrameFocusLineId =
        nextFocusPolicy?.visualStyleFocusLineId ?? focusFrame.focusLineId;
      const resolvedCommittedScrollLineId =
        nextFocusPolicy?.visualFocusLineId ?? focusFrame.committedScrollLineId;
      if (
        nextFrame.focusLineId !== resolvedFrameFocusLineId ||
        nextFrame.committedScrollLineId !== resolvedCommittedScrollLineId
      ) {
        nextFrame = Object.freeze({
          ...nextFrame,
          focusLineId: resolvedFrameFocusLineId,
          committedScrollLineId: resolvedCommittedScrollLineId,
        });
      }
      const visualStyleFocusLineId =
        nextFocusPolicy?.visualStyleFocusLineId ?? nextFrame.focusLineId;
      const layoutVisualStyleFocusLineId =
        activePreAnchorMotion?.visualStyleFocusLineId ??
        visualStyleFocusLineId;
      const laneWillChange =
        this.#secondaryLaneKey(layoutVisualStyleFocusLineId) !==
        this.#secondaryLaneSyncKey;
      const focusWillMove =
        preAnchorShouldStart ||
        (!preAnchorHandoffMatches &&
          (nextFocusPolicy?.highlightedChanged === true ||
            nextFocusPolicy?.focusChanged === true ||
            this.#focusPolicy === null));
      const lineMembershipChanged =
        !preAnchorHandoffMatches &&
        (nextFrame.enteredLineIds.length > 0 ||
          nextFrame.exitedLineIds.length > 0);
      // A background/synced tail can expire after the next foreground row has
      // already taken over focus. Its exit changes playback membership but not
      // the layout or docking target. While the original handoff FLIP is still
      // running, starting another one cancels it and leaves a small second
      // movement at the tail's end.
      const motionAnchorUnchanged =
        motionVisualFocusLineId ===
          (this.#focusPolicy?.visualFocusLineId ?? null) &&
        motionLineMoveAnchorLineId ===
          (this.#focusPolicy?.lineMoveAnchorLineId ?? null);
      const exitedRowsAlreadyPast = nextFrame.exitedLineIds.every(
        (lineId) =>
          this.#lineTimedRenderer?.getRow(lineId)?.dataset.visualState ===
          "past",
      );
      const residualOnlyExitDuringRowMove =
        lineMembershipChanged &&
        this.#rowMove.getState().running &&
        !focusWillMove &&
        !laneWillChange &&
        motionAnchorUnchanged &&
        exitedRowsAlreadyPast &&
        nextFrame.enteredLineIds.length === 0 &&
        nextFrame.exitedLineIds.length > 0;
      const rowMoveMembershipChanged =
        lineMembershipChanged && !residualOnlyExitDuringRowMove;
      const instrumentalWillLeave = this.#instrumentalWillLeave(nextFrame);
      const clickSeekLineId = this.#clickSeekScrollLineId;
      const clickSeekGeneration = this.#clickSeekScrollGeneration;
      const clickSeekPending = clickSeekLineId !== null;
      // A seek frame can be followed by ordinary playback frames before the
      // target row is mounted/focused. Keep the pending request alive until
      // the focus policy and rendered row agree on the clicked line.
      const clickSeekTargetReady =
        clickSeekPending &&
        this.#clickSeekMotionPhase === "pending" &&
        (nextFocusPolicy?.visualFocusLineId === clickSeekLineId ||
          nextFrame.focusLineId === clickSeekLineId);
      const clickSeekFrame = clickSeekTargetReady;
      const clickSeekInstrumentalAdapterMove =
        clickSeekFrame && this.#instrumentalAdapterWillChange(nextFrame);
      const instrumentalWillEnter = this.#instrumentalWillEnter(nextFrame);
      const canAnimatePlaybackTransition =
        !visibilityResume &&
        this.#canAnimatePlaybackTransition(nextFrame.mode, snapshot.playing);
      // Capture ALL rows on instrumental enter AND leave so the height change
      // FLIPs remaining lyrics instead of hard-jumping them into place.
      const playbackInstrumentalAdapterMove =
        this.#clickSeekScrollLineId === null &&
        canAnimatePlaybackTransition &&
        (instrumentalWillEnter || instrumentalWillLeave);
      const playbackRowMove =
        this.#clickSeekScrollLineId === null &&
        canAnimatePlaybackTransition &&
        (laneWillChange ||
          focusWillMove ||
          rowMoveMembershipChanged ||
          instrumentalWillLeave ||
          instrumentalWillEnter);
      // Ordinary click-seek needs the Wa.C-style row FLIP cascade so nearby
      // lines stagger into place. Viewport-only smooth scroll looks like one
      // rigid slab. Instrumental adapter removal still uses the same path so
      // remaining rows keep continuity when the interlude node disappears.
      const clickSeekRowMove =
        clickSeekFrame && !this.#options.reducedMotion;
      const clickSeekAdapterRowMove =
        clickSeekRowMove && clickSeekInstrumentalAdapterMove;
      const adapterRowMove =
        clickSeekAdapterRowMove || playbackInstrumentalAdapterMove;
      const shouldCaptureRowMove = playbackRowMove || clickSeekRowMove;
      const layer = displayLayer(this.#options.displayMode);
      const beforeHosts = shouldCaptureRowMove
        ? this.#collectRowMoveHosts(
            layer,
            [
              this.#focusPolicy?.visualFocusLineId,
              motionVisualFocusLineId,
              motionLineMoveAnchorLineId,
            ].filter(
              (lineId): lineId is string =>
                lineId !== null && lineId !== undefined,
            ),
            adapterRowMove,
          )
        : [];
      const targetAnchorAdapterIndex = this.#adapterIndexForLine(
        motionLineMoveAnchorLineId ?? layoutVisualStyleFocusLineId,
        beforeHosts,
      );
      const previousFocusAdapterIndex = this.#adapterIndexForLine(
        this.#focusPolicy?.visualFocusLineId ?? null,
        beforeHosts,
      );
      // Keep the first visible forward step perceptible: the clicked row gets
      // 25ms, followed by 44/56/63ms for the rows beneath it. Reverse seeks
      // are collision-prone and are forced onto one clock at completion.
      const rowMoveAnchorAdapterIndex =
        clickSeekFrame && targetAnchorAdapterIndex > previousFocusAdapterIndex
          ? Math.max(0, targetAnchorAdapterIndex - 1)
          : targetAnchorAdapterIndex;
      // Match the ordinary focus-handoff clock: gap-based line move duration
      // keeps long reverse/forward jumps from feeling glued to a fixed 650ms
      // viewport slab while still letting nearby rows cascade with stagger.
      const clickSeekMoveDurationMs = clickSeekFrame
        ? this.#resolveLineMoveDurationMs(
            context.document,
            nextFocusPolicy?.lineMoveAnchorLineId ?? visualStyleFocusLineId,
          )
        : 0;
      const playbackMoveDurationMs =
        (preAnchorShouldStart
          ? linePreAnchor
            ? linePreAnchor.remainingMediaDurationMs / snapshot.rate
            : undefined
          : undefined) ??
        this.#resolveLineMoveDurationMs(
          context.document,
          nextFocusPolicy?.lineMoveAnchorLineId ?? visualStyleFocusLineId,
        );
      const rowTransaction: RowMoveTransaction | null = shouldCaptureRowMove
        ? this.#rowMove.begin(beforeHosts, {
            reason: clickSeekFrame
              ? clickSeekAdapterRowMove
                ? this.#seekMotionOrigin === "external"
                  ? "external-seek-instrumental-removal"
                  : "click-seek-instrumental-removal"
                : this.#seekMotionOrigin === "external"
                  ? "external-seek-focus"
                  : "click-seek-focus"
              : playbackInstrumentalAdapterMove
                ? "playback-instrumental-insertion"
                : preAnchorShouldStart
                  ? "playback-karaoke-pre-anchor"
                  : "playback-focus",
            animate: true,
            durationMs: clickSeekFrame
              ? clickSeekMoveDurationMs
              : playbackMoveDurationMs,
            anchorAdapterIndex: rowMoveAnchorAdapterIndex,
          })
        : null;
      const laneLineIds = laneWillChange
        ? this.#pendingSecondaryLaneLineIds(
            nextFrame,
            layoutVisualStyleFocusLineId,
          )
        : new Set<string>();
      const animatedLaneLineIds =
        !visibilityResume &&
        !this.#options.reducedMotion &&
        layer === "synced" &&
        (this.#canAnimatePlaybackTransition(nextFrame.mode, snapshot.playing) ||
          clickSeekFrame)
          ? this.#animatableSecondaryLaneLineIds(
              nextFrame,
              layoutVisualStyleFocusLineId,
              laneLineIds,
            )
          : new Set<string>();
      const directLaneLineIds = new Set(
        [...laneLineIds].filter(
          (lineId) => !animatedLaneLineIds.has(lineId),
        ),
      );
      const laneHosts = laneWillChange
        ? this.#collectSecondaryLaneHosts(animatedLaneLineIds)
        : [];
      const directLaneHosts = laneWillChange
        ? this.#collectSecondaryLaneHosts(directLaneLineIds)
        : [];
      const lanePresentation = laneWillChange
        ? this.#secondaryLaneTransition.capture(laneHosts)
        : undefined;
      const paintSuppressedLineIds = this.#paintSuppressedLineIds(
        context.document,
        nextFrame,
        visualStyleFocusLineId,
      );

      // Focus handoff fill profile (user/AM frame analysis):
      //   上移开始 → plateau dim → 动画开始 → ~45ms linear ramp → 动画完成
      //   → longer bright plateau → 上移结束
      // Fill is a short linear ramp inside the row-move, front-loaded:
      // short pre-hold (时长更短), 75ms linear ramp, longer post-hold (时长更长).
      // Switch visual primary at move start so delay clocks from 上移开始.
      // Skip paint lead during karaoke geometry-only pre-anchor.
      const moveDurationForFill = clickSeekFrame
        ? clickSeekMoveDurationMs
        : playbackMoveDurationMs;
      const motionPaintFocusLineId = visibilityResume || activePreAnchorMotion
        ? null
        : (shouldCaptureRowMove && focusWillMove
          ? (motionVisualFocusLineId ?? visualStyleFocusLineId)
          : null);
      // Concurrent / overlapping lines must all stay primary+active-scale during
      // focus handoff. Painting only the focus line demotes partners → shrink,
      // then they re-activate when motion ends → grow jump (user report on
      // multi-line simultaneous line-timed lyrics).
      const visualPrimaryLineIds = motionPaintFocusLineId
        ? new Set<string>([
          ...nextFrame.activeLineIds,
          ...nextFrame.concurrentPrimaryTailLineIds,
          motionPaintFocusLineId,
        ])
        : null;
      const motionScaleActiveLineIds = visualPrimaryLineIds
        ?? (activePreAnchorMotion
          ? activePreAnchorMotion.scaleActiveLineIds
          : null);
      /** Linear luminance ramp; pre-hold shorter than post-hold within the move. */
      const LINE_FILL_DURATION_MS = 90;
      /** Fraction of (move − fill) used as pre-hold before the ramp (rest is post-hold). */
      const LINE_FILL_PRE_HOLD_FRACTION = 1 / 3;
      const midMoveFill =
        motionPaintFocusLineId !== null
        && moveDurationForFill > 0
        && !this.#options.reducedMotion
        && !visibilityResume
          ? {
              alphaDurationMs: LINE_FILL_DURATION_MS,
              alphaDelayMs: Math.max(
                0,
                Math.round(
                  Math.max(0, moveDurationForFill - LINE_FILL_DURATION_MS)
                    * LINE_FILL_PRE_HOLD_FRACTION,
                ),
              ),
              // Only the newly focused line runs the mid-move fill ramp.
              alphaTimingLineIds: new Set<string>([motionPaintFocusLineId]),
            }
          : null;

      try {
        this.#lineTimedRenderer?.renderFrame(nextFrame, {
          reducedMotion: this.#options.reducedMotion || visibilityResume,
          paintSuppressedLineIds,
          visualStyleFocusLineId,
          ...(activePreAnchorMotion
            ? { scaleActiveLineIds: activePreAnchorMotion.scaleActiveLineIds }
            : motionScaleActiveLineIds
              ? { scaleActiveLineIds: motionScaleActiveLineIds }
              : {}),
          ...(visualPrimaryLineIds ? { visualPrimaryLineIds } : {}),
          ...(midMoveFill ?? {}),
        });
        this.#duetRenderer?.renderFrame(nextFrame);
        this.#instrumentalRenderer?.renderFrame(nextFrame, {
          reducedMotion: this.#options.reducedMotion || visibilityResume,
          playing: snapshot.playing,
        });

        const laneUpdate = laneWillChange
          ? this.#prepareSecondaryLaneUpdate(
              nextFrame,
              layoutVisualStyleFocusLineId,
              lanePresentation,
              laneHosts,
              directLaneHosts,
            )
          : null;
        const focusDocumentIndex =
          this.#layoutPlan?.getByLineId(
            motionVisualFocusLineId ?? nextFrame.focusLineId ?? "",
          )?.documentIndex ?? 0;
        const futureLaneDelta =
          shouldCaptureRowMove && layer === "synced" && laneUpdate
            ? laneUpdate.prepared.layoutDeltaBefore(focusDocumentIndex)
            : 0;
        this.#commitSecondaryLaneUpdate(laneUpdate, {
          durationMs: clickSeekFrame
            ? clickSeekMoveDurationMs
            : playbackMoveDurationMs,
          frameMode: nextFrame.mode,
          playing: snapshot.playing || clickSeekFrame,
          allowSeekAnimation: clickSeekFrame,
        });

        const focusRow = this.#rowForLayer(
          motionVisualFocusLineId ?? nextFrame.focusLineId,
          layer,
        );
        const focusChanged =
          preAnchorShouldStart ||
          (!preAnchorHandoffMatches &&
            (nextFocusPolicy?.highlightedChanged ??
              this.#playbackFrame?.focusLineId !== nextFrame.focusLineId));
        const shouldMeasureFocusVisibility =
          this.#scrollOwner.manualScrollLocked &&
          this.#scrollOwner.manualScrollIdle &&
          snapshot.playing &&
          focusChanged;
        const focusVisible =
          shouldMeasureFocusVisibility && focusRow
            ? isElementFullyVisible(focusRow, this.#viewportForLayer(layer))
            : false;
        let nextScrollOwner = advanceScrollOwner(this.#scrollOwner, {
          type: "playback-focus",
          focusLineId: motionVisualFocusLineId ?? nextFrame.focusLineId,
          focusChanged,
          focusVisible,
          playing: snapshot.playing,
        });
        const pendingSeekLineId = nextScrollOwner.pendingSeekLineId;
        const seekReached =
          pendingSeekLineId !== null &&
          nextFrame.activeLineIds.has(pendingSeekLineId);
        const shouldAnchor =
          layer === "synced" &&
          this.#clickSeekScrollLineId === null &&
          nextScrollOwner.autoFollow &&
          focusRow !== null &&
          (visibilityResume ||
            preAnchorShouldStart ||
            (!preAnchorHandoffMatches &&
              (this.#focusPolicy === null ||
                nextFocusPolicy?.highlightedChanged === true ||
                seekReached ||
                nextFrame.mode === "seek" ||
                nextFrame.mode === "bind" ||
                nextFrame.mode === "reset")));
        let clickSeekAnchorDeltaPx = 0;
        if (
          clickSeekFrame &&
          focusRow &&
          focusRow.dataset.lineId === clickSeekLineId
        ) {
          const seekLineId = clickSeekLineId as string;
          const shouldSettleDirectly =
            clickSeekRowMove || this.#options.reducedMotion;
          const smoothScrollRunning =
            this.#interaction?.getState().smoothScrollRunning === true;
          if (shouldSettleDirectly) {
            if (clickSeekRowMove) {
              this.#clickSeekMotionPhase = "row";
            }
            clickSeekAnchorDeltaPx = this.#anchorRowToTop(
              focusRow,
              clickSeekRowMove ? futureLaneDelta : 0,
            );
            if (this.#clickSeekScrollLineId === seekLineId) {
              if (!clickSeekRowMove) {
                // Immediate settle (zero delta / reduced motion path).
                this.#seekMotionOrigin = null;
                this.#clickSeekScrollLineId = null;
                this.#clickSeekMotionPhase = null;
                this.#clickSeekDiscontinuitySequence = null;
              }
              nextScrollOwner = advanceScrollOwner(nextScrollOwner, {
                type: "seek-settled",
              });
            }
          } else if (!smoothScrollRunning) {
            this.#clickSeekMotionPhase = "scroll";
            const scrollStarted = this.#startClickSeekScroll(
              focusRow,
              seekLineId,
            );
            if (!scrollStarted) {
              this.#anchorRowToTop(focusRow, 0);
              if (this.#clickSeekScrollLineId === seekLineId) {
                this.#seekMotionOrigin = null;
                this.#clickSeekScrollLineId = null;
                this.#clickSeekMotionPhase = null;
                this.#clickSeekDiscontinuitySequence = null;
                nextScrollOwner = advanceScrollOwner(nextScrollOwner, {
                  type: "seek-settled",
                });
              }
            }
          }
        } else if (
          sameSourceReplay &&
          sameSourceReplayViewport &&
          sameSourceReplayAnchor
        ) {
          // Reset rendering may collapse the terminal row's secondary lane or
          // the opening instrumental lane. Restore the pre-reset row first so
          // the replay motion starts from the actual visible presentation.
          this.#restoreScrollAnchor(
            sameSourceReplayViewport,
            this.#rowForLayer(sameSourceReplayAnchor.lineId, "synced"),
            sameSourceReplayAnchor,
          );
        } else if (
          shouldAnchor
          && focusRow
          // Instrumental leave already FLIPs every row via adapterRowMove.
          // Hard anchoring here snaps the viewport and cancels the cascade.
          && !(instrumentalWillLeave && shouldCaptureRowMove)
        ) {
          this.#anchorRowToTop(focusRow, futureLaneDelta);
        }

        const rowMoveHosts = rowTransaction
          ? this.#collectRowMoveHosts(
              layer,
              [
                this.#focusPolicy?.visualFocusLineId,
                motionVisualFocusLineId,
                motionLineMoveAnchorLineId,
              ].filter(
                (lineId): lineId is string =>
                  lineId !== null && lineId !== undefined,
              ),
              adapterRowMove,
            )
          : [];
        const laneReflowLineIds = new Set(
          rowMoveHosts.flatMap((host) => {
            const documentIndex = this.#layoutPlan?.getByLineId(
              host.lineId,
            )?.documentIndex;
            return laneUpdate &&
              documentIndex !== undefined &&
              Math.abs(
                laneUpdate.prepared.layoutDeltaBefore(documentIndex),
              ) >= 0.5
              ? [host.lineId]
              : [];
          }),
        );
        if (rowTransaction) {
          this.#rowMove.complete(
            rowTransaction,
            rowMoveHosts,
            {
              // Moving the viewport toward an earlier row sends the visual
              // batch downward. Delaying lower rows in that direction lets
              // the expanding focus row catch them, so reverse takeovers use
              // one shared clock while forward moves retain native stagger.
              forceZeroDelay:
                clickSeekFrame && clickSeekAnchorDeltaPx < -0.5,
              // Rows below an animated secondary lane are already moving in
              // normal flow. Start their FLIP on the same clock so stagger
              // cannot make them move down first and then reverse upward.
              forceZeroDelayLineIds: laneReflowLineIds,
              onSettled: () => {
                if (clickSeekFrame && clickSeekRowMove && clickSeekLineId) {
                  this.#settleClickSeekRowMove(
                    clickSeekLineId,
                    clickSeekGeneration,
                  );
                }
                if (this.#scrollOwner.manualScrollLocked) {
                  this.#captureStableComponentAnchor();
                }
              },
            },
          );
        }
        if (sameSourceReplay && nextScrollOwner.autoFollow) {
          const replayTargetRow = this.#rowForLayer(
            nextFocusPolicy?.visualFocusLineId ?? nextFrame.focusLineId,
            "synced",
          );
          if (replayTargetRow) {
            this.#startSameSourceReplayScroll(replayTargetRow);
          }
        }
        if (seekReached && this.#clickSeekScrollLineId === null) {
          if (seekReached || nextScrollOwner.pendingSeekLineId !== null) {
            nextScrollOwner = advanceScrollOwner(nextScrollOwner, {
              type: "seek-settled",
            });
          }
        }

        // Line-timed (lrc) paint must share visual primary + mid-move alpha
        // timing with the row renderer so whole-line fill matches native LRC.
        const lineTimedKaraokeOptions =
          this.#options.displayMode === "lrc"
            ? {
                ...(visualPrimaryLineIds
                  ? { visualPrimaryLineIds }
                  : {}),
                ...(midMoveFill ?? {}),
              }
            : {};
        this.#karaokeRenderer?.renderFrame(nextFrame, {
          reducedMotion: this.#options.reducedMotion || visibilityResume,
          playing: snapshot.playing,
          paintSuppressedLineIds,
          ...lineTimedKaraokeOptions,
        });
        this.#backgroundTrackRenderer?.renderFrame(nextFrame, {
          reducedMotion: this.#options.reducedMotion || visibilityResume,
          playing: snapshot.playing,
          paintSuppressedLineIds,
          ...lineTimedKaraokeOptions,
        });
        this.#scrollOwner = nextScrollOwner;
        if (preAnchorHandoffMatches) {
          this.#karaokePreAnchorMotion = null;
        }
      } catch (error) {
        this.#karaokePreAnchorMotion = null;
        this.#rowMove.cancel("playback-transaction-failed");
        this.#secondaryLaneTransition.cancel("playback-transaction-failed");
        this.#foregroundSecondaryLaneTransition.cancel(
          "playback-transaction-failed",
        );
        throw error;
      }
    }
    this.#playbackSnapshot = snapshot;
    this.#playbackFrame = nextFrame;
    this.#focusPolicy = nextFocusPolicy;
    if (context) this.#nextFrameMode = null;
    this.#playbackError = false;
    this.#syncDomState();
  }

  #suspendPlaybackMotionForVisibility(): void {
    this.#karaokePreAnchorMotion = null;
    this.#interaction?.cancelSmoothScroll("document-hidden");
    this.#rowMove.cancel("document-hidden");
    this.#secondaryLaneTransition.cancel("document-hidden");
    this.#foregroundSecondaryLaneTransition.cancel("document-hidden");
    if (
      this.#clickSeekMotionPhase !== null ||
      this.#clickSeekScrollLineId !== null
    ) {
      this.#clearSeekMotion("document-hidden");
    }
    if (this.#scrollOwner.pendingSeekLineId !== null) {
      this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
        type: "seek-settled",
      });
    }
  }

  #clearSeekMotion(_reason: string): void {
    this.#clickSeekScrollLineId = null;
    this.#clickSeekScrollGeneration += 1;
    this.#clickSeekMotionPhase = null;
    this.#seekMotionOrigin = null;
    this.#clickSeekDiscontinuityBaseline = 0;
    this.#clickSeekDiscontinuitySequence = null;
  }

  /**
   * Arms the shared seek FLIP / smooth-scroll transaction for either a
   * lyric-row click or a host progress/timeline discontinuity.
   */
  #armSeekMotion(
    lineId: string,
    origin: "click" | "external",
    navigationDiscontinuitySequence: number | null = null,
  ): void {
    this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
      type: "click-seek",
      lineId,
    });
    this.#clickSeekScrollLineId = lineId;
    this.#clickSeekScrollGeneration += 1;
    this.#clickSeekMotionPhase = "pending";
    this.#seekMotionOrigin = origin;
    // Click-seek arms before the host reports a discontinuity, so baseline is
    // the last observed sequence. External seeks arm on the seek frame itself
    // and can pin the live sequence immediately.
    if (
      origin === "external" &&
      navigationDiscontinuitySequence !== null
    ) {
      this.#clickSeekDiscontinuityBaseline = Math.max(
        0,
        navigationDiscontinuitySequence - 1,
      );
      this.#clickSeekDiscontinuitySequence = navigationDiscontinuitySequence;
    } else {
      this.#clickSeekDiscontinuityBaseline =
        this.#playbackSnapshot?.discontinuity?.sequence ?? 0;
      this.#clickSeekDiscontinuitySequence = null;
    }
    this.#karaokePreAnchorMotion = null;
    this.#interaction?.cancelSmoothScroll(
      origin === "external" ? "external-seek-restart" : "click-seek-restart",
    );
  }

  /**
   * Mid-scrub retarget: keep seek ownership, point at the new focus line, and
   * restart the pending phase so row capture re-runs from the current FLIP
   * presentation instead of hard-anchoring.
   */
  #retargetSeekMotion(
    lineId: string,
    navigationDiscontinuitySequence: number | null,
  ): void {
    if (this.#clickSeekMotionPhase === "scroll") {
      this.#interaction?.cancelSmoothScroll("external-seek-retarget");
    }
    this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
      type: "click-seek",
      lineId,
    });
    this.#clickSeekScrollLineId = lineId;
    this.#clickSeekScrollGeneration += 1;
    this.#clickSeekMotionPhase = "pending";
    this.#seekMotionOrigin = "external";
    if (
      navigationDiscontinuitySequence !== null &&
      navigationDiscontinuitySequence > this.#clickSeekDiscontinuityBaseline
    ) {
      this.#clickSeekDiscontinuitySequence = navigationDiscontinuitySequence;
    }
  }

  #secondaryLaneKey(focusLineId: string | null): string | null {
    const document = this.#lyrics;
    if (!document) return null;
    const visibility = this.#secondaryVisibility();
    return [
      document.id,
      focusLineId ?? "",
      visibility.translationVisible ? "1" : "0",
      visibility.pronunciationVisible ? "1" : "0",
    ].join("\u0000");
  }

  #prepareSecondaryLaneUpdate(
    frame: PlaybackFrame | null,
    focusLineId: string | null,
    presentation?: SecondaryLanePresentation,
    hosts: readonly SecondaryLaneHost[] = this.#collectSecondaryLaneHosts(),
    directHosts: readonly SecondaryLaneHost[] = [],
  ): SecondaryLaneUpdate | null {
    const document = this.#lyrics;
    if (!document) return null;
    const syncKey = this.#secondaryLaneKey(focusLineId);
    if (syncKey === null || syncKey === this.#secondaryLaneSyncKey) return null;
    const layoutFrame =
      frame &&
      frame.documentId === document.id &&
      frame.focusLineId !== focusLineId
        ? ({ ...frame, focusLineId } as PlaybackFrame)
        : frame;
    const plan = createSecondaryLaneLayoutPlan(
      document,
      layoutFrame,
      this.#secondaryVisibility(),
    );
    const directGeometryLineIds = directHosts.flatMap((host) => {
      const target = plan.getByLineId(host.lineId)?.target ?? "none";
      const previousState = this.#secondaryLaneStateByLineId.get(host.lineId);
      const previousTarget = previousState?.split("\u0000", 1)[0] ?? null;
      return target === "expanded" || previousTarget === "expanded"
        ? [host.lineId]
        : [];
    });
    for (const state of plan.states) {
      const row = this.#lineTimedRenderer?.getRow(state.lineId);
      if (!row) continue;
      row.dataset.secondaryLaneTarget = state.target;
      row.dataset.secondaryLaneReason = state.reason;
    }
    return Object.freeze({
      key: syncKey,
      layoutPlan: plan,
      prepared: this.#secondaryLaneTransition.prepare(
        hosts,
        plan.states,
        presentation,
      ),
      directHosts: Object.freeze([...directHosts]),
      directGeometryLineIds: Object.freeze(directGeometryLineIds),
    });
  }

  #commitSecondaryLaneUpdate(
    update: SecondaryLaneUpdate | null,
    options: {
      readonly durationMs: number;
      readonly frameMode: PlaybackFrameMode;
      readonly playing?: boolean;
      readonly allowSeekAnimation?: boolean;
    },
  ): void {
    if (!update) return;
    this.#secondaryLaneTransition.transition(update.prepared, {
      playing: options.playing ?? this.#playbackSnapshot?.playing ?? false,
      frameMode: options.frameMode,
      reducedMotion: this.#options.reducedMotion,
      durationMs: options.durationMs,
      allowSeekAnimation: options.allowSeekAnimation ?? false,
      directTargets: {
        hosts: update.directHosts,
        targets: update.layoutPlan.states,
        invalidateLineIds: update.directGeometryLineIds,
      },
      onGeometryInvalidated: (lineIds) => this.#invalidateGeometry(lineIds),
    });
    this.#secondaryLaneStateByLineId = new Map(
      update.layoutPlan.states.map((state) => [
        state.lineId,
        secondaryLaneStateKey(state),
      ]),
    );
    this.#secondaryLaneSyncKey = update.key;
  }

  #syncSecondaryLaneTargets(
    frame: PlaybackFrame | null,
    forceSettle = false,
  ): void {
    const focusLineId =
      this.#focusPolicy?.visualStyleFocusLineId ?? frame?.focusLineId ?? null;
    const directHosts = this.#collectSecondaryLaneHosts(
      this.#pendingSecondaryLaneLineIds(frame, focusLineId),
    );
    const hosts: readonly SecondaryLaneHost[] = [];
    const presentation = this.#secondaryLaneTransition.capture(hosts);
    const update = this.#prepareSecondaryLaneUpdate(
      frame,
      focusLineId,
      presentation,
      hosts,
      directHosts,
    );
    this.#commitSecondaryLaneUpdate(update, {
      durationMs: forceSettle
        ? 0
        : this.#lyrics
          ? this.#resolveLineMoveDurationMs(this.#lyrics, focusLineId)
          : 0,
      frameMode: forceSettle ? "bind" : frame?.mode ?? "bind",
      ...(forceSettle ? { playing: false } : {}),
    });
  }

  /**
   * Row-move interval policy:
   * - 逐字 (karaoke): gap-scale 480–750ms (word-timed AM behavior)
   * - 整行 (lrc): fixed 750ms even when the document is word-timed (UI force)
   */
  #resolveLineMoveDurationMs(
    document: LyricDocument,
    focusLineId: string | null,
  ): number {
    return resolveLineMoveDuration(document, focusLineId, {
      gapScale: this.#options.displayMode === "karaoke",
    });
  }

  #canAnimatePlaybackTransition(
    frameMode: PlaybackFrameMode,
    playing = this.#playbackSnapshot?.playing ?? false,
  ): boolean {
    return (
      this.#active &&
      !this.#options.reducedMotion &&
      this.#contentRegionLayoutChange === null &&
      playing &&
      frameMode === "playback"
    );
  }

  #beginContentRegionLayoutChange(
    originRegion: LyricsContentRegion,
  ): ContentRegionLayoutChange {
    this.#interaction?.cancelSmoothScroll("content-region-layout");
    this.#rowMove.cancel("content-region-layout");
    this.#secondaryLaneTransition.cancel("content-region-layout");
    this.#foregroundSecondaryLaneTransition.cancel("content-region-layout");
    this.#karaokePreAnchorMotion = null;

    if (
      this.#clickSeekMotionPhase !== null ||
      this.#clickSeekScrollLineId !== null
    ) {
      this.#clearSeekMotion("content-region-layout");
    }
    if (this.#scrollOwner.pendingSeekLineId !== null) {
      this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
        type: "seek-settled",
      });
    }
    // Keep click-seek paint/focus ownership. Like manual lyric scrolling, this
    // gesture interrupts motion without changing which line owns the seek.

    const layer = displayLayer(this.#options.displayMode);
    const anchorRow = this.#selectLayoutAnchorRow(layer);
    return Object.freeze({
      layer,
      anchor: captureScrollAnchor(
        this.#viewportForLayer(layer),
        anchorRow,
      ),
      originRegion,
    });
  }

  #applyContentRegionLayoutChange(
    change: ContentRegionLayoutChange,
    requestedRegion: LyricsContentRegion,
  ): void {
    const view = this.#view;
    if (!view) return;
    const next = normalizeLyricsContentRegion(
      requestedRegion,
      CONTENT_REGION_MIN_SPAN_RATIO,
    );
    const previous = this.#contentRegion;
    if (contentRegionsEqual(previous, next)) return;

    const widthChanged =
      Math.abs(contentRegionSpan(previous) - contentRegionSpan(next)) > 1e-6;
    view.setContentRegion(next);
    this.#contentRegion = next;
    if (!widthChanged) return;

    void view.root.offsetHeight;
    this.#invalidateContentRegionGeometry();
    if (change.anchor) {
      const viewport = this.#viewportForLayer(change.layer);
      const anchorRow = this.#rowForLayer(change.anchor.lineId, change.layer);
      this.#restoreScrollAnchor(viewport, anchorRow, change.anchor);
    }
  }

  #completeContentRegionLayoutChange(
    change: ContentRegionLayoutChange,
  ): void {
    if (this.#contentRegionLayoutChange === change) {
      this.#contentRegionLayoutChange = null;
    }
    this.#scheduleStableComponentAnchorCapture();
    this.#syncDomState();
  }

  #beginContentRegionControlInteraction(
    event: LyricsContentRegionControlEvent,
  ): void {
    if (this.#lifecycle !== "mounted") return;
    if (this.#contentRegionLayoutChange) {
      this.#completeContentRegionLayoutChange(this.#contentRegionLayoutChange);
    }
    this.#contentRegionLayoutChange = this.#beginContentRegionLayoutChange(
      event.originRegion,
    );
    this.#syncDomState();
  }

  #updateContentRegionControlInteraction(
    event: LyricsContentRegionControlEvent,
  ): void {
    if (this.#lifecycle !== "mounted") return;
    const change =
      this.#contentRegionLayoutChange ??
      this.#beginContentRegionLayoutChange(event.originRegion);
    this.#contentRegionLayoutChange = change;
    try {
      this.#applyContentRegionLayoutChange(change, event.region);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        this.#applyContentRegionLayoutChange(change, change.originRegion);
        this.#contentRegionControl?.setRegion(change.originRegion);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      this.#completeContentRegionLayoutChange(change);
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Lyrics content region interaction failed and rollback failed",
        );
      }
      throw error;
    }
  }

  #commitContentRegionControlInteraction(
    event: LyricsContentRegionControlEvent,
  ): void {
    if (this.#lifecycle !== "mounted") return;
    this.#updateContentRegionControlInteraction(event);
    const change = this.#contentRegionLayoutChange;
    if (change) this.#completeContentRegionLayoutChange(change);
  }

  #cancelContentRegionControlInteraction(
    event: LyricsContentRegionControlEvent,
  ): void {
    if (this.#lifecycle !== "mounted") return;
    const change = this.#contentRegionLayoutChange;
    if (!change) {
      this.setContentRegion(event.region);
      return;
    }
    const errors: unknown[] = [];
    try {
      this.#applyContentRegionLayoutChange(change, change.originRegion);
    } catch (error) {
      errors.push(error);
      try {
        this.#view?.setContentRegion(change.originRegion);
        this.#contentRegion = change.originRegion;
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
    }
    try {
      this.#contentRegionControl?.setRegion(change.originRegion);
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#completeContentRegionLayoutChange(change);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Lyrics content region cancellation failed",
      );
    }
  }

  #beginFontLayoutChange(): FontLayoutChange {
    this.#interaction?.cancelSmoothScroll("font-profile-layout");
    this.#rowMove.cancel("font-profile-layout");
    this.#secondaryLaneTransition.cancel("font-profile-layout");
    this.#foregroundSecondaryLaneTransition.cancel("font-profile-layout");
    const layer = displayLayer(this.#options.displayMode);
    const anchorRow = this.#selectLayoutAnchorRow(layer);
    const anchor = captureScrollAnchor(
      this.#viewportForLayer(layer),
      anchorRow,
    );
    const anchorLineId = anchorRow?.dataset.lineId ?? null;
    const rowTransaction = this.#rowMove.begin(
      this.#collectRowMoveHosts(
        layer,
        anchorLineId ? [anchorLineId] : [],
      ),
      {
        reason: "font-profile-layout",
        // Token reflow already updates paint; FLIP on every visible row is the
        // settings-toggle hitch that freezes large karaoke documents.
        animate: false,
        durationMs: 0,
        anchorAdapterIndex: this.#adapterIndexForRow(anchorRow),
      },
    );
    return Object.freeze({
      layer,
      anchor,
      anchorLineId,
      rowTransaction,
    });
  }

  #completeFontLayoutChange(change: FontLayoutChange): void {
    try {
      void this.#view?.root.offsetHeight;
      const hosts = this.#collectRowMoveHosts(
        change.layer,
        change.anchorLineId ? [change.anchorLineId] : [],
      );
      // Font-size / layout-profile changes invalidate every karaoke mask.
      // Measuring only the on-screen neighborhood left off-screen (and even
      // some visible) lines with stale line widths → trailing glyph clip.
      this.#invalidateGeometry();
      if (change.anchor) {
        const viewport = this.#viewportForLayer(change.layer);
        const anchorRow = this.#rowForLayer(change.anchor.lineId, change.layer);
        this.#restoreScrollAnchor(viewport, anchorRow, change.anchor);
      }
      this.#rowMove.complete(change.rowTransaction, hosts, {
        forceZeroDelay: true,
        onSettled: () => this.#captureStableComponentAnchor(),
      });
      // Second pass after style/layout fully settle (container queries, fonts).
      this.#scheduleGeometryRefresh();
      this.#syncDomState();
    } catch (error) {
      this.#rowMove.cancel("font-profile-layout-failed");
      throw error;
    }
  }

  #rollbackFontLayoutChange(change: FontLayoutChange): void {
    this.#rowMove.cancel("font-profile-rollback");
    this.#secondaryLaneTransition.cancel("font-profile-rollback");
    this.#foregroundSecondaryLaneTransition.cancel("font-profile-rollback");
    void this.#view?.root.offsetHeight;
    this.#invalidateGeometry();
    if (change.anchor) {
      const viewport = this.#viewportForLayer(change.layer);
      const anchorRow = this.#rowForLayer(change.anchor.lineId, change.layer);
      this.#restoreScrollAnchor(viewport, anchorRow, change.anchor);
    }
    this.#scheduleStableComponentAnchorCapture();
    this.#syncDomState();
  }

  #instrumentalWillLeave(frame: PlaybackFrame): boolean {
    const session = this.#instrumentalRenderer?.getState().session;
    if (!session || session.presence !== "exiting") return false;
    const lastPositionMs = session.lastPlaybackPositionMs;
    const deltaMs =
      lastPositionMs === null || !Number.isFinite(frame.playbackPositionMs)
        ? 0
        : Math.max(0, frame.playbackPositionMs - lastPositionMs);
    return (
      session.exitElapsedMs + deltaMs >= INSTRUMENTAL_EXIT_TOTAL_DURATION_MS
    );
  }

  #instrumentalWillEnter(frame: PlaybackFrame): boolean {
    const rendererState = this.#instrumentalRenderer?.getState();
    if (!rendererState || rendererState.mountedLineId !== null) return false;
    const document = this.#lyrics;
    if (!document) return false;
    return frame.activeLineIdsInSourceOrder.some((lineId) =>
      document.lines.some(
        (line) => line.id === lineId && line.type === "instrumental",
      ),
    );
  }

  #instrumentalAdapterWillChange(frame: PlaybackFrame): boolean {
    const mountedLineId = this.#instrumentalRenderer?.getState().mountedLineId;
    const document = this.#lyrics;
    if (!document) return mountedLineId !== null;
    const nextLineId = frame.activeLineIdsInSourceOrder.find((lineId) =>
      document.lines.some(
        (line) => line.id === lineId && line.type === "instrumental",
      ),
    ) ?? null;
    return mountedLineId !== nextLineId;
  }

  #collectRowMoveHosts(
    layer: PlayerViewLayer,
    includeLineIds: readonly string[] = [],
    captureAll = false,
  ): readonly RowMoveHost[] {
    const view = this.#view;
    const layoutPlan = this.#layoutPlan;
    if (!view || !layoutPlan) return [];
    const container =
      layer === "synced" ? view.syncedRows : view.plaintextRows;
    const children = Array.from(container.children) as HTMLElement[];
    const selectedIndexes = new Set<number>();
    const viewport = this.#viewportForLayer(layer);
    const viewportHeight = viewport.clientHeight;
    if (captureAll) {
      // Adapter removal can displace every visible row around a long interlude.
      for (let index = 0; index < children.length; index += 1) {
        selectedIndexes.add(index);
      }
    } else if (children.length > 0 && viewportHeight > 0) {
      const minimumTop = Math.max(0, viewport.scrollTop - viewportHeight);
      const maximumTop = viewport.scrollTop + viewportHeight * 2;
      let low = 0;
      let high = children.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const row = children[middle];
        const bottom = row
          ? row.offsetTop + Math.max(1, row.offsetHeight)
          : Number.POSITIVE_INFINITY;
        if (bottom < minimumTop) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < children.length; index += 1) {
        const row = children[index];
        if (!row || row.offsetTop > maximumTop) break;
        selectedIndexes.add(index);
      }
    } else {
      for (let index = 0; index < Math.min(children.length, 16); index += 1) {
        selectedIndexes.add(index);
      }
    }
    const include = new Set(includeLineIds);
    children.forEach((row, index) => {
      if (!include.has(row.dataset.lineId ?? "")) return;
      for (
        let candidate = Math.max(0, index - 5);
        candidate <= Math.min(children.length - 1, index + 5);
        candidate += 1
      ) {
        selectedIndexes.add(candidate);
      }
    });

    const hosts: RowMoveHost[] = [];
    [...selectedIndexes]
      .sort((left, right) => left - right)
      .forEach((adapterIndex) => {
        const element = children[adapterIndex];
        if (!element) return;
        const lineId = element.dataset.lineId;
        if (!lineId) return;
        const layout = layoutPlan.getByLineId(lineId);
        if (!layout) return;
        hosts.push(
          Object.freeze({
            lineId,
            element,
            adapterIndex,
            sourceIndex: layout.sourceIndex,
          }),
        );
      });
    return Object.freeze(hosts);
  }

  #collectSecondaryLaneHosts(
    lineIds?: ReadonlySet<string>,
  ): readonly SecondaryLaneHost[] {
    const layoutPlan = this.#layoutPlan;
    if (!layoutPlan) return [];
    const hosts: SecondaryLaneHost[] = [];
    for (const layout of layoutPlan.lines) {
      if (lineIds && !lineIds.has(layout.lineId)) continue;
      const rowElement = this.#lineTimedRenderer?.getRow(layout.lineId);
      const laneElement = this.#lineTimedRenderer?.getSecondaryLane(
        layout.lineId,
      );
      if (!rowElement || !laneElement) continue;
      hosts.push(
        Object.freeze({
          lineId: layout.lineId,
          documentIndex: layout.documentIndex,
          rowElement,
          laneElement,
        }),
      );
    }
    return Object.freeze(hosts);
  }

  #collectForegroundSecondaryLaneHosts(
    lineIds?: ReadonlySet<string>,
  ): readonly SecondaryLaneHost[] {
    const layoutPlan = this.#layoutPlan;
    if (!layoutPlan) return [];
    const hosts: SecondaryLaneHost[] = [];
    for (const layout of layoutPlan.lines) {
      if (lineIds && !lineIds.has(layout.lineId)) continue;
      const rowElement = this.#lineTimedRenderer?.getRow(layout.lineId);
      const laneElement = this.#lineTimedRenderer?.getForegroundSecondaryLane(
        layout.lineId,
      );
      if (!rowElement || !laneElement) continue;
      hosts.push(
        Object.freeze({
          lineId: layout.lineId,
          documentIndex: layout.documentIndex,
          rowElement,
          laneElement,
        }),
      );
    }
    return Object.freeze(hosts);
  }

  #foregroundSecondaryLaneTargets(
    hosts: readonly SecondaryLaneHost[],
  ): readonly SecondaryLaneLayoutState[] {
    return Object.freeze(
      hosts.map((host) => {
        const visible = Array.from(host.laneElement.children).some(
          (child) => !(child as HTMLElement).hidden,
        );
        return foregroundSecondaryLaneState(
          host.lineId,
          visible ? "expanded" : "none",
        );
      }),
    );
  }

  #syncForegroundSecondaryLaneTargets(forceSettle = false): void {
    const hosts = this.#collectForegroundSecondaryLaneHosts();
    const targets = this.#foregroundSecondaryLaneTargets(hosts);
    const prepared = this.#foregroundSecondaryLaneTransition.prepare(
      hosts,
      targets,
    );
    this.#foregroundSecondaryLaneTransition.transition(prepared, {
      playing: !forceSettle && (this.#playbackSnapshot?.playing ?? false),
      frameMode: forceSettle ? "bind" : this.#playbackFrame?.mode ?? "bind",
      reducedMotion: this.#options.reducedMotion,
      durationMs: forceSettle ? 0 : SECONDARY_TEXT_LAYOUT_DURATION_MS,
      onGeometryInvalidated: (lineIds) => this.#invalidateGeometry(lineIds),
    });
  }

  #pendingSecondaryLaneLineIds(
    frame: PlaybackFrame | null,
    focusLineId: string | null,
  ): ReadonlySet<string> {
    const document = this.#lyrics;
    if (!document) return new Set<string>();
    const layoutFrame =
      frame &&
      frame.documentId === document.id &&
      frame.focusLineId !== focusLineId
        ? ({ ...frame, focusLineId } as PlaybackFrame)
        : frame;
    const plan = createSecondaryLaneLayoutPlan(
      document,
      layoutFrame,
      this.#secondaryVisibility(),
    );
    const pending = new Set<string>();
    for (const state of plan.states) {
      const stateKey = secondaryLaneStateKey(state);
      if (this.#secondaryLaneStateByLineId.get(state.lineId) !== stateKey) {
        pending.add(state.lineId);
      }
    }
    for (const state of this.#secondaryLaneTransition.getState().lines) {
      if (state.animationCount > 0) pending.add(state.lineId);
    }
    return pending;
  }

  #animatableSecondaryLaneLineIds(
    frame: PlaybackFrame | null,
    focusLineId: string | null,
    pendingLineIds: ReadonlySet<string>,
  ): ReadonlySet<string> {
    const document = this.#lyrics;
    if (!document || pendingLineIds.size === 0) return new Set<string>();
    const layoutFrame =
      frame &&
      frame.documentId === document.id &&
      frame.focusLineId !== focusLineId
        ? ({ ...frame, focusLineId } as PlaybackFrame)
        : frame;
    const plan = createSecondaryLaneLayoutPlan(
      document,
      layoutFrame,
      this.#secondaryVisibility(),
    );
    const nearbyLineIds = new Set(
      this.#collectRowMoveHosts(
        "synced",
        focusLineId ? [focusLineId] : [],
      ).map((host) => host.lineId),
    );
    const animatable = new Set<string>();
    for (const state of plan.states) {
      if (
        !pendingLineIds.has(state.lineId) ||
        !nearbyLineIds.has(state.lineId)
      ) {
        continue;
      }
      const previousState = this.#secondaryLaneStateByLineId.get(state.lineId);
      const previousTarget = previousState?.split("\u0000", 1)[0] ?? null;
      if (state.target === "expanded" || previousTarget === "expanded") {
        animatable.add(state.lineId);
      }
    }
    return animatable;
  }

  #adapterIndexForLine(
    lineId: string | null,
    hosts: readonly RowMoveHost[],
  ): number {
    if (!lineId) return 0;
    return hosts.find((host) => host.lineId === lineId)?.adapterIndex ?? 0;
  }

  #adapterIndexForRow(row: HTMLElement | null): number {
    const lineId = row?.dataset.lineId ?? null;
    return this.#adapterIndexForLine(
      lineId,
      this.#collectRowMoveHosts(
        displayLayer(this.#options.displayMode),
        lineId ? [lineId] : [],
      ),
    );
  }

  #viewportForLayer(layer: PlayerViewLayer): HTMLElement {
    const view = this.#view;
    if (!view) throw new Error("Lyrics player view is not mounted");
    return layer === "synced" ? view.syncedLayer : view.plaintextLayer;
  }

  #rowForLayer(
    lineId: string | null,
    layer: PlayerViewLayer,
  ): HTMLElement | null {
    if (!lineId) return null;
    if (layer === "plaintext") {
      return this.#plaintextRenderer?.getRow(lineId) ?? null;
    }
    const textRow = this.#lineTimedRenderer?.getRow(lineId);
    if (textRow) return textRow;
    const rows = this.#view?.syncedRows.children ?? [];
    return (
      (Array.from(rows) as HTMLElement[]).find(
        (row) => row.dataset.lineId === lineId,
      ) ?? null
    );
  }

  #rowsForLayer(layer: PlayerViewLayer): readonly HTMLElement[] {
    const view = this.#view;
    if (!view) return [];
    const container =
      layer === "synced" ? view.syncedRows : view.plaintextRows;
    return Object.freeze(
      (Array.from(container.children) as HTMLElement[]).filter(
        (row) =>
          row.dataset.lineId !== undefined &&
          row.dataset.lineType !== "instrumental",
      ),
    );
  }

  #selectLayoutAnchorRow(layer: PlayerViewLayer): HTMLElement | null {
    const viewport = this.#viewportForLayer(layer);
    const rows = this.#rowsForLayer(layer);
    const fullyVisible = findFirstFullyVisibleRow(viewport, rows);
    const viewportRect = viewport.getBoundingClientRect();
    const intersecting =
      rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.bottom > viewportRect.top &&
          rect.top < viewportRect.bottom
        );
      }) ?? null;
    const focusRow = this.#resolveVisualFocusRow(layer);
    return this.#scrollOwner.manualScrollLocked
      ? fullyVisible ?? intersecting ?? focusRow
      : focusRow ?? fullyVisible ?? intersecting;
  }

  #selectComponentResizeAnchorRow(
    layer: PlayerViewLayer,
  ): HTMLElement | null {
    if (layer === "synced" && !this.#scrollOwner.manualScrollLocked) {
      return this.#selectLayoutAnchorRow(layer);
    }
    const viewport = this.#viewportForLayer(layer);
    const rows = this.#rowsForLayer(layer);
    const fullyVisible = findFirstFullyVisibleRow(viewport, rows);
    const viewportRect = viewport.getBoundingClientRect();
    const intersecting =
      rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.bottom > viewportRect.top &&
          rect.top < viewportRect.bottom
        );
      }) ?? null;
    return fullyVisible ?? intersecting ?? this.#resolveVisualFocusRow(layer);
  }

  #resolveVisualFocusRow(
    layer: PlayerViewLayer = displayLayer(this.#options.displayMode),
  ): HTMLElement | null {
    const lineId =
      this.#focusPolicy?.visualFocusLineId ??
      this.#playbackFrame?.focusLineId ??
      null;
    return this.#rowForLayer(lineId, layer);
  }

  #restoreScrollAnchor(
    viewport: HTMLElement,
    row: HTMLElement | null,
    anchor: ScrollAnchorSnapshot,
    futureLayoutDeltaPx = 0,
  ): number {
    if (!row || row.dataset.lineId !== anchor.lineId) return 0;
    const viewportRect = viewport.getBoundingClientRect();
    const currentOffset = row.getBoundingClientRect().top - viewportRect.top;
    const delta =
      currentOffset - anchor.viewportOffsetPx + futureLayoutDeltaPx;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return 0;
    return this.#setProgrammaticScrollTop(viewport, viewport.scrollTop + delta);
  }

  #setProgrammaticScrollTop(
    viewport: HTMLElement,
    scrollTop: number,
  ): number {
    const activeViewport = this.#viewportForLayer(
      displayLayer(this.#options.displayMode),
    );
    if (viewport === activeViewport && this.#interaction) {
      return this.#interaction.setProgrammaticScrollTop(scrollTop);
    }
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const target = Number.isFinite(scrollTop)
      ? Math.min(maxScrollTop, Math.max(0, scrollTop))
      : viewport.scrollTop;
    const previous = viewport.scrollTop;
    viewport.scrollTop = target;
    return viewport.scrollTop - previous;
  }

  #anchorRowToTop(row: HTMLElement, futureLayoutDeltaPx = 0): number {
    const layer = displayLayer(this.#options.displayMode);
    const viewport = this.#viewportForLayer(layer);
    const viewportRect = viewport.getBoundingClientRect();
    const rowOffset = row.getBoundingClientRect().top - viewportRect.top;
    const target =
      viewport.scrollTop +
      rowOffset -
      resolveLyricTopOffset(viewport.clientHeight) +
      futureLayoutDeltaPx;
    return this.#setProgrammaticScrollTop(viewport, target);
  }

  #resolveRowTop(row: HTMLElement): number {
    const layer = displayLayer(this.#options.displayMode);
    const viewport = this.#viewportForLayer(layer);
    if (!row.isConnected) return viewport.scrollTop;
    // Use layout coordinates whenever possible. A row FLIP/scale transform must
    // never become part of the next click-seek target; only the secondary lane's
    // real height should move this coordinate.
    let layoutTop = 0;
    let current: HTMLElement | null = row;
    while (current && current !== viewport) {
      layoutTop += current.offsetTop;
      current = current.offsetParent as HTMLElement | null;
    }
    if (current === viewport) {
      return Math.max(
        0,
        layoutTop - resolveLyricTopOffset(viewport.clientHeight),
      );
    }
    const viewportRect = viewport.getBoundingClientRect();
    const rowOffset = row.getBoundingClientRect().top - viewportRect.top;
    return (
      viewport.scrollTop +
      rowOffset -
      resolveLyricTopOffset(viewport.clientHeight)
    );
  }

  #startClickSeekScroll(row: HTMLElement, lineId: string): boolean {
    const interaction = this.#interaction;
    if (!interaction) return false;
    const viewport = this.#viewportForLayer(
      displayLayer(this.#options.displayMode),
    );
    if (Math.abs(this.#resolveRowTop(row) - viewport.scrollTop) < 0.5) {
      return false;
    }
    const generation = this.#clickSeekScrollGeneration;
    interaction.animateProgrammaticScroll({
      resolveTargetTop: () => this.#resolveRowTop(row),
      durationMs: CLICK_SEEK_SCROLL_DURATION_MS,
      ease: clickSeekScrollEase,
      trackTargetChanges: true,
      onSettled: () => this.#settleClickSeekScroll(lineId, generation),
    });
    return true;
  }

  #startSameSourceReplayScroll(row: HTMLElement): void {
    const interaction = this.#interaction;
    if (!interaction) return;
    interaction.animateProgrammaticScroll({
      resolveTargetTop: () => this.#resolveRowTop(row),
      durationMs: SAME_SOURCE_REPLAY_SCROLL_DURATION_MS,
      ease: clickSeekScrollEase,
      // Secondary lanes and the opening interlude can settle during the
      // replay. Re-resolve the target each frame so the motion remains one
      // continuous curve instead of restarting after a layout change.
      trackTargetChanges: true,
      onSettled: () => this.#captureStableComponentAnchor(),
    });
  }

  #settleClickSeekScroll(lineId: string, generation: number): void {
    if (
      generation !== this.#clickSeekScrollGeneration ||
      this.#clickSeekScrollLineId !== lineId
    ) {
      return;
    }
    this.#clearSeekMotion("seek-scroll-settled");
    if (this.#scrollOwner.pendingSeekLineId !== null) {
      this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
        type: "seek-settled",
      });
    }
    this.#syncDomState();
  }

  #settleClickSeekRowMove(lineId: string, generation: number): void {
    if (
      generation !== this.#clickSeekScrollGeneration ||
      this.#clickSeekScrollLineId !== lineId ||
      this.#clickSeekMotionPhase !== "row"
    ) {
      return;
    }
    this.#clearSeekMotion("seek-row-settled");
    if (this.#scrollOwner.pendingSeekLineId !== null) {
      this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
        type: "seek-settled",
      });
    }
    this.#syncDomState();
  }

  #handleManualScroll(): void {
    if (this.#lifecycle !== "mounted") return;
    // Manual input takes viewport ownership, but the independent row FLIP
    // keeps settling just as RecyclerView item motion does during a drag.
    if (this.#clickSeekMotionPhase !== null) {
      this.#clearSeekMotion("manual-scroll");
    }
    this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
      type: "manual-scroll",
    });
    this.#syncDomState();
  }

  #handleManualScrollIdle(): void {
    if (this.#lifecycle !== "mounted") return;
    const layer = displayLayer(this.#options.displayMode);
    const focusRow = this.#resolveVisualFocusRow(layer);
    this.#scrollOwner = advanceScrollOwner(this.#scrollOwner, {
      type: "manual-idle",
      focusVisible: focusRow
        ? isElementFullyVisible(focusRow, this.#viewportForLayer(layer))
        : false,
    });
    this.#scheduleStableComponentAnchorCapture();
    this.#syncDomState();
  }

  #handleLineClick(lineId: string): void {
    const document = this.#lyrics;
    const commands = this.#playbackCommands;
    if (!document || !commands) return;
    const request = createClickSeekRequest(
      document,
      lineId,
      this.#playbackSnapshot,
    );
    if (!request) return;
    const previousScrollOwner = this.#scrollOwner;
    const previousNextFrameMode = this.#nextFrameMode;
    const previousSeekScrollLineId = this.#clickSeekScrollLineId;
    const previousSeekMotionPhase = this.#clickSeekMotionPhase;
    const previousSeekMotionOrigin = this.#seekMotionOrigin;
    const previousSeekDiscontinuityBaseline =
      this.#clickSeekDiscontinuityBaseline;
    const previousSeekDiscontinuitySequence =
      this.#clickSeekDiscontinuitySequence;
    let seekCommandCompleted = false;
    // The seek frame anchors the real viewport, then RowMove preserves the
    // current presentation and animates rows into that layout. Do not cancel
    // RowMove here: a repeated click must capture its in-flight presentation.
    this.#armSeekMotion(lineId, "click");
    const optimisticScrollOwner = this.#scrollOwner;
    this.#nextFrameMode = "seek";
    this.#clickSeekOwnership = setClickSeekOwnership(document, lineId);
    try {
      executeClickSeek(request, {
        seekTo: (positionMs) => {
          commands.seekTo(positionMs);
          seekCommandCompleted = true;
        },
        ...(commands.play
          ? { play: () => commands.play?.() }
          : {}),
      });
      this.#syncDomState();
    } catch (error) {
      const seekWasNotConsumed =
        !seekCommandCompleted &&
        this.#scrollOwner === optimisticScrollOwner &&
        this.#nextFrameMode === "seek";
      if (seekWasNotConsumed) {
        this.#scrollOwner = previousScrollOwner;
        this.#nextFrameMode = previousNextFrameMode;
        // The previous smooth scroll was cancelled before executing the new
        // command; restoring its pending id would leave auto-follow blocked
        // without a live animation to settle it.
        this.#clickSeekScrollLineId = previousSeekScrollLineId;
        this.#clickSeekScrollGeneration += 1;
        this.#clickSeekMotionPhase = previousSeekMotionPhase;
        this.#seekMotionOrigin = previousSeekMotionOrigin;
        this.#clickSeekDiscontinuityBaseline =
          previousSeekDiscontinuityBaseline;
        this.#clickSeekDiscontinuitySequence =
          previousSeekDiscontinuitySequence;
        this.#clickSeekOwnership = clearClickSeekOwnership("click-seek-failed");
        this.#interaction?.cancelSmoothScroll("click-seek-failed");
      }
      this.#syncDomState();
      throw error;
    }
  }

  #resolveInstrumentalFocusHold(
    document: LyricDocument,
    frame: PlaybackFrame,
    playing: boolean,
  ): { readonly lineId: string; readonly reason: FocusPolicyReason } | null {
    if (this.#clickSeekOwnership.forcedFocusLineId) return null;
    const positionMs = frame.playbackPositionMs;
    for (const line of document.lines) {
      if (line.type !== "instrumental") continue;
      if (!this.#instrumentalMayParticipate(line.id, playing)) continue;
      const beginMs = line.begin.valueMs;
      const endMs = line.end.valueMs;
      if (
        beginMs === null ||
        endMs === null ||
        !Number.isFinite(beginMs) ||
        !Number.isFinite(endMs)
      ) {
        continue;
      }
      const exitStartMs = Math.max(
        beginMs,
        endMs - INSTRUMENTAL_EXIT_TOTAL_DURATION_MS,
      );
      if (
        positionMs >= exitStartMs &&
        positionMs < endMs
      ) {
        return {
          lineId: line.id,
          reason: "instrumental-exit-focus-hold",
        };
      }
    }
    const hasLyricActive = frame.requestedActiveLineIdsInSourceOrder.some(
      (lineId) => {
        const line = document.lines.find((candidate) => candidate.id === lineId);
        return Boolean(
          line && line.type !== "instrumental" && line.type !== "credit",
        );
      },
    );
    if (hasLyricActive) return null;
    for (const line of document.lines) {
      if (line.type !== "instrumental") continue;
      if (!this.#instrumentalMayParticipate(line.id, playing)) continue;
      const beginMs = line.begin.valueMs;
      const endMs = line.end.valueMs;
      if (
        beginMs === null ||
        endMs === null ||
        !Number.isFinite(beginMs) ||
        !Number.isFinite(endMs)
      ) {
        continue;
      }
      const exitStartMs = Math.max(
        beginMs,
        endMs - INSTRUMENTAL_EXIT_TOTAL_DURATION_MS,
      );
      if (positionMs >= beginMs && positionMs < exitStartMs) {
        return {
          lineId: line.id,
          reason: "instrumental-breathing-focus-hold",
        };
      }
    }
    return null;
  }

  #instrumentalMayParticipate(lineId: string, playing: boolean): boolean {
    const session = this.#instrumentalRenderer?.getState().session;
    if (playing) {
      // Historic behavior: a playing frame lets the row participate at once
      // (the session enters on this same render pass). The one exception is
      // the DEFERRED intro gap: before the clock has ever advanced, the
      // session deliberately stays absent, and focus must not scroll to a
      // row whose adapter slot is empty.
      if (
        session &&
        !session.playbackHasAdvanced &&
        session.presence === "absent" &&
        this.#isIntroInstrumentalLine(lineId)
      ) {
        return false;
      }
      return true;
    }
    return Boolean(
      session && session.presence !== "absent" && session.lineId === lineId,
    );
  }

  /** Intro gap = no lyric (non-credit) line precedes it in document order. */
  #isIntroInstrumentalLine(lineId: string): boolean {
    const document = this.#lyrics;
    if (!document) return false;
    for (const line of document.lines) {
      if (line.id === lineId) return line.type === "instrumental";
      if (line.type !== "instrumental" && line.type !== "credit") return false;
    }
    return false;
  }

  #frameForFocusPolicy(frame: PlaybackFrame, playing: boolean): PlaybackFrame {
    if (playing) return frame;
    const document = this.#lyrics;
    if (!document) return frame;
    const excludedInstrumentalLineIds = new Set<string>();
    const activeLineIdsInSourceOrder = frame.activeLineIdsInSourceOrder.filter(
      (lineId) => {
        const line = document.lines.find((candidate) => candidate.id === lineId);
        const participates =
          line?.type !== "instrumental" ||
          this.#instrumentalMayParticipate(lineId, false);
        if (!participates) excludedInstrumentalLineIds.add(lineId);
        return participates;
      },
    );
    const focusLineId =
      frame.focusLineId && excludedInstrumentalLineIds.has(frame.focusLineId)
        ? null
        : frame.focusLineId;
    const committedScrollLineId =
      frame.committedScrollLineId &&
      excludedInstrumentalLineIds.has(frame.committedScrollLineId)
        ? null
        : frame.committedScrollLineId;
    if (excludedInstrumentalLineIds.size === 0) return frame;
    return Object.freeze({
      ...frame,
      activeLineIdsInSourceOrder: Object.freeze(activeLineIdsInSourceOrder),
      focusLineId,
      committedScrollLineId,
    });
  }

  #paintSuppressedLineIds(
    document: LyricDocument,
    frame: PlaybackFrame,
    visualStyleFocusLineId: string | null,
  ): ReadonlySet<string> {
    const suppressed = new Set<string>();
    if (this.#clickSeekOwnership.forcedFocusLineId) {
      for (const line of document.lines) {
        if (
          isPaintSuppressedByClickSeekOwnership(
            this.#clickSeekOwnership,
            document,
            line.id,
          )
        ) {
          suppressed.add(line.id);
        }
      }
      // Also suppress concurrent tails that would keep earlier partners white.
      for (const lineId of frame.concurrentPrimaryTailLineIdsInSourceOrder) {
        if (
          isPaintSuppressedByClickSeekOwnership(
            this.#clickSeekOwnership,
            document,
            lineId,
          )
        ) {
          suppressed.add(lineId);
        }
      }
    }

    const positionMs = frame.playbackPositionMs;
    for (const lineId of frame.activeLineIdsInSourceOrder) {
      if (
        lineId === visualStyleFocusLineId ||
        frame.concurrentPrimaryTailLineIds.has(lineId)
      ) {
        continue;
      }
      const line = document.lines.find((candidate) => candidate.id === lineId);
      if (!line || line.type === "instrumental" || line.type === "credit") {
        continue;
      }
      const beginMs = line.begin.valueMs;
      const foregroundEndMs = resolveLineForegroundEndMs(line);
      const foregroundLive =
        beginMs !== null &&
        foregroundEndMs !== null &&
        Number.isFinite(beginMs) &&
        Number.isFinite(foregroundEndMs) &&
        positionMs >= beginMs &&
        positionMs < foregroundEndMs;
      if (!foregroundLive) suppressed.add(lineId);
    }
    return suppressed.size > 0 ? suppressed : EMPTY_LINE_ID_SET;
  }

  #invalidateGeometry(lineIds?: readonly string[]): void {
    if (lineIds && lineIds.length === 0) return;
    this.#karaokeRenderer?.invalidateGeometry(lineIds);
    this.#backgroundTrackRenderer?.invalidateGeometry(lineIds);
  }

  #invalidateContentRegionGeometry(): void {
    const karaokeRenderer = this.#karaokeRenderer;
    if (karaokeRenderer && !karaokeRenderer.hasGeometryObserver()) {
      karaokeRenderer.invalidateGeometry();
    }
    const backgroundRenderer = this.#backgroundTrackRenderer;
    if (backgroundRenderer && !backgroundRenderer.hasGeometryObserver()) {
      backgroundRenderer.invalidateGeometry();
    }
  }
}

export function createLyricsPlayer(
  options: Partial<LyricsPlayerOptionsInput> = {},
): LyricsPlayerController {
  return new LyricsPlayerControllerImpl(options);
}
