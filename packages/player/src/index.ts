export {
  createLyricsPlayer,
  type LyricsDisplayMode,
  type LyricsOptionsUpdateContext,
  type LyricsOptionsUpdateResult,
  type LyricsPlayerController,
  type LyricsPlayerOptions,
  type LyricsPlayerOptionsInput,
  type LyricsReducedMotionPreference,
} from "./controller/lyrics-player-controller.js";
export type { LyricsSurfaceMode } from "./view/surface-mode.js";
export type {
  LyricsBackgroundAppearance,
  LyricsBackgroundArtworkSource,
  LyricsBackgroundArtworkUpdateOptions,
  LyricsBackgroundArtworkUpdateResult,
  LyricsBackgroundPerformanceMode,
  LyricsBackgroundPerformanceTier,
} from "./background/artwork-background.js";
export type {
  LyricsFontKindMap,
  LyricsFontOverrideMap,
  LyricsFontProfileKind,
  LyricsFontProfiles,
  LyricsFontSource,
  LyricsFontTarget,
  LyricsFontUpdateOptions,
  LyricsFontUpdateResult,
} from "./view/font-profile.js";
export { lyricFontTargets } from "./view/font-profile.js";
export {
  lyricsLayoutProfiles,
  type LyricsLayoutProfile,
} from "./view/layout-profile.js";
export {
  DEFAULT_LYRICS_FONT_WEIGHT_TIER,
  isLyricsFontWeightTier,
  lyricsFontWeightTiers,
  type LyricsFontWeightTier,
} from "./view/font-weight-tier.js";
export {
  DEFAULT_LYRICS_CONTENT_REGION,
  isLyricsContentRegion,
  moveIndependentLyricsContentRegionHandle,
  moveLinkedLyricsContentRegionHandle,
  normalizeLyricsContentRegion,
  translateLyricsContentRegion,
  type LyricsContentRegion,
  type LyricsContentRegionHandle,
} from "./view/content-region.js";
export {
  deriveLyricDocumentCapabilities,
  type LyricDocumentCapabilities,
  type LyricTrackCapabilities,
} from "./domain/capabilities.js";
export {
  createAgentId,
  createDerivedLineId,
  createDocumentId,
  createJoinGroupId,
  createLineId,
  createStableId,
  createWordId,
  type LyricTrackRole,
  type StableIdPart,
} from "./domain/ids.js";
export {
  deriveInstrumentalGaps,
  type InsertedInstrumentalGap,
  type InstrumentalGapOptions,
  type InstrumentalGapResult,
  type SuppressedInstrumentalGap,
} from "./domain/instrumental-gaps.js";
export {
  createLyricLanguage,
  inferLyricLanguage,
  inferSecondaryLyricLanguage,
  normalizeLanguageTag,
  UNDETERMINED_LANGUAGE_TAG,
  type CreateLyricLanguageInput,
  type LyricSecondaryTextRole,
} from "./domain/language.js";
export { normalizeLyricDocument } from "./domain/normalize-document.js";
export {
  createLyricTimeIndex,
  type LyricTimeIndex,
  type LyricTimeIndexEntry,
} from "./domain/time-index.js";
export type {
  InstrumentalLyricLine,
  LyricAgent,
  LyricDocument,
  LyricDocumentSource,
  LyricFormat,
  LyricLanguage,
  LyricLine,
  LyricLineType,
  LyricText,
  LyricTimestamp,
  LyricTrack,
  LyricTracks,
  LyricWord,
  LyricWordJoinGroup,
  KnownLyricTimestampSource,
  NonMonotonicLineOrderSample,
  TextLyricLine,
} from "./domain/types.js";
export {
  createLyricAgentSidePlan,
  type LyricAgentSidePlan,
  type LyricLineSide,
  type LyricLineSideResolution,
  type LyricSideCode,
  type LyricSideReason,
} from "./layout/agent-side.js";
export {
  resolveLyricDirection,
  resolveLyricLineDirection,
  type LyricDirectionResolution,
  type LyricDirectionSource,
  type LyricLayoutDirection,
  type ResolveLyricDirectionInput,
} from "./layout/direction.js";
export {
  createLyricLayoutPlan,
  type LyricLayoutPlan,
  type LyricLineLayout,
  type LyricLineLayoutPlan,
} from "./layout/layout-plan.js";
export {
  createLyricLineWidthPlan,
  type LyricLineWidthPlan,
  type LyricLineWidthRatio,
  type LyricLineWidthReason,
  type LyricLineWidthResolution,
} from "./layout/line-width.js";
export {
  createSecondaryLaneLayoutPlan,
  type SecondaryLaneLayoutPlan,
  type SecondaryLaneLayoutState,
  type SecondaryLaneTarget,
  type SecondaryLaneTargetReason,
  type SecondaryLaneVisibility,
} from "./layout/secondary-lane.js";
export {
  captureScrollAnchor,
  findFirstFullyVisibleRow,
  isElementFullyVisible,
  lineMoveDurationForGap,
  LINE_MOVE_MAX_DURATION_MS,
  LINE_MOVE_MAX_GAP_MS,
  LINE_MOVE_MIN_DURATION_MS,
  LINE_MOVE_MIN_GAP_MS,
  LYRIC_TEXT_PADDING_TOP_PX,
  LYRIC_TOP_RATIO,
  resolveLineMoveDuration,
  resolveLyricTopOffset,
  resolveRowMoveDelay,
  restoreScrollAnchor,
  ROW_MOVE_STAGGER_MS,
  type ResolveLineMoveDurationOptions,
  type ScrollAnchorSnapshot,
} from "./navigation/auto-scroll.js";
export {
  createClickSeekRequest,
  executeClickSeek,
  isClickSeekEligible,
  type ClickSeekExecution,
  type ClickSeekRequest,
  type PlaybackCommands,
} from "./navigation/click-seek.js";
export {
  clearClickSeekOwnership,
  createClickSeekOwnershipState,
  isPaintSuppressedByClickSeekOwnership,
  maybeExpireClickSeekOwnership,
  resolveForcedFocusLineId,
  setClickSeekOwnership,
  type ClickSeekOwnershipState,
} from "./navigation/click-seek-ownership.js";
export {
  advanceFocusPolicy,
  createFocusPolicyContext,
  type FocusPolicyContext,
  type FocusPolicyReason,
  type FocusPolicyState,
} from "./navigation/focus-policy.js";
export {
  advanceScrollOwner,
  createScrollOwnerState,
  type ScrollOwner,
  type ScrollOwnerEvent,
  type ScrollOwnerState,
} from "./navigation/scroll-owner.js";
export {
  CLICK_SEEK_SCROLL_DURATION_MS,
  clickSeekScrollEase,
  sampleSmoothScrollTop,
} from "./navigation/smooth-scroll.js";
export {
  INSTRUMENTAL_BREATHING_BASE_CYCLE_MS,
  INSTRUMENTAL_BREATHING_TARGET_SCALE,
  INSTRUMENTAL_DOT_COUNT,
  INSTRUMENTAL_DOT_ENTRANCE_DURATION_MS,
  INSTRUMENTAL_DOT_ENTRANCE_STAGGER_MS,
  INSTRUMENTAL_EXIT_TARGET_SCALE,
  INSTRUMENTAL_DOT_FINAL_TINT_MS,
  INSTRUMENTAL_PROGRESS_SEGMENT_COUNT,
  INSTRUMENTAL_REST_OUTER_INSET_PX,
  INSTRUMENTAL_CHAIN_CENTER_TO_OUTER_EDGE_PX,
  sampleInstrumentalAnimation,
  type InstrumentalAnimationOptions,
  type InstrumentalAnimationPhase,
  type InstrumentalAnimationState,
} from "./instrumental/animation.js";
export {
  advanceInstrumentalSession,
  createIdleInstrumentalSession,
  INSTRUMENTAL_EXIT_COLLAPSE_DURATION_MS,
  INSTRUMENTAL_EXIT_EXPAND_DURATION_MS,
  INSTRUMENTAL_EXIT_TOTAL_DURATION_MS,
  INSTRUMENTAL_SAME_LINE_RETRIGGER_THROTTLE_MS,
  type InstrumentalPlaybackState,
  type InstrumentalSessionInput,
  type InstrumentalSessionPhase,
  type InstrumentalSessionPresence,
  type InstrumentalSessionState,
  type InstrumentalSessionTransition,
} from "./instrumental/session.js";
export {
  createInstrumentalTimingContext,
  findActiveInstrumentalTiming,
  INSTRUMENTAL_END_BUFFER_MS,
  INSTRUMENTAL_MINIMUM_VISIBLE_DURATION_MS,
  sampleInstrumentalTimeline,
  type InstrumentalTimelinePhase,
  type InstrumentalTimelineSample,
  type InstrumentalTiming,
  type InstrumentalTimingContext,
  type InstrumentalTimingIssue,
  type InstrumentalTimingIssueReason,
  type InstrumentalTimingOptions,
} from "./instrumental/timing.js";
export {
  compileKaraokeBindingGroups,
  reconstructLyricTrackText,
  type CompileKaraokeBindingGroupsInput,
  type InvalidParserJoinGroupIssue,
  type KaraokeBindingFallbackReason,
  type KaraokeBindingLane,
  type KaraokeEmphasisSplitEligibility,
  type KaraokeEmphasisSplitReason,
  type KaraokeParserJoinGroupPlan,
  type KaraokeParserJoinGroupReference,
  type KaraokeTextBinding,
  type KaraokeTrackBindingCompilation,
  type KaraokeTrackBindingFallback,
  type KaraokeTrackBindingPlan,
  type KaraokeWordBindingPlan,
} from "./karaoke/binding-groups.js";
export {
  createKaraokeEmphasisSpread,
  createKaraokeGlowMaskState,
  sampleKaraokeEmphasis,
  type KaraokeEmphasisInput,
  type KaraokeEmphasisPhase,
  type KaraokeEmphasisSpreadDirection,
  type KaraokeEmphasisSpreadState,
  type KaraokeEmphasisState,
  type KaraokeGlowMaskPhase,
  type KaraokeGlowMaskState,
} from "./karaoke/glow.js";
export {
  createIdleKaraokeLiftState,
  sampleKaraokeLift,
  type KaraokeLiftMotionProfile,
  type KaraokeLiftPhase,
  type KaraokeLiftSampleInput,
  type KaraokeLiftState,
} from "./karaoke/lift.js";
export {
  createKaraokeMaskLayout,
  VISUAL_LINE_TOP_TOLERANCE_PX,
  type KaraokeBindingMaskGeometry,
  type KaraokeBindingRectInput,
  type KaraokeMaskLayout,
  type KaraokeMaskLayoutOptions,
  type KaraokeVisualLineGeometry,
} from "./karaoke/mask-layout.js";
export {
  createKaraokeSweepState,
  DEFAULT_SWEEP_FEATHER_PX,
  DEFAULT_SWEEP_MAX_FEATHER_RATIO,
  HAN_KANA_SWEEP_MAX_FEATHER_GLYPH_RATIO,
  HAN_KANA_SWEEP_MAX_VISUAL_DURATION_MS,
  HAN_KANA_TERMINAL_CONTINUATION_MS,
  type CreateKaraokeSweepStateInput,
  type KaraokeSweepBindingInput,
  type KaraokeSweepCharacterClass,
  type KaraokeSweepContinuation,
  type KaraokeSweepContinuationStatus,
  type KaraokeSweepCursorBounds,
  type KaraokeSweepDirection,
  type KaraokeSweepLane,
  type KaraokeSweepMaskAlphas,
  type KaraokeSweepPhase,
  type KaraokeSweepState,
  type KaraokeSweepStops,
  type KaraokeSweepVisualLineInput,
} from "./karaoke/sweep.js";
export {
  classifyKaraokeGrapheme,
  countLetterOrNumberGraphemes,
  createKaraokeTextUnitPlan,
  hasEmphasisSplitExcludedScript,
  isCjkOrKanaGrapheme,
  isLetterOrNumberGrapheme,
  segmentKaraokeGraphemes,
  shouldSplitKaraokeText,
  type KaraokeScriptFamily,
  type KaraokeTextUnit,
  type KaraokeTextUnitOptions,
  type KaraokeTextUnitPlan,
  type KaraokeTextUnitStrategy,
} from "./karaoke/text-units.js";
export {
  KARAOKE_CJK_CONTINUATION_DURATION_MS,
  sampleKaraokeTimeline,
  type KaraokeTimelineInput,
  type KaraokeTimelinePhase,
  type KaraokeTimelineSample,
} from "./karaoke/timeline.js";
export { parseEslrc } from "./parsers/eslrc-parser.js";
export { parseLrc } from "./parsers/lrc-parser.js";
export { parseLys } from "./parsers/lys-parser.js";
export { parsePlaintext } from "./parsers/plaintext-parser.js";
export { parseQrc } from "./parsers/qrc-parser.js";
export {
  createParserRegistry,
  defaultParserRegistry,
  LyricsParserRegistry,
  parseLyrics,
  type LyricsParserRegistration,
} from "./parsers/parser-registry.js";
export type { XmlDocumentReader } from "./parsers/ttml/dom.js";
export {
  createTtmlParser,
  parseTtml,
  type TtmlParserOptions,
} from "./parsers/ttml/ttml-parser.js";
export { parseYrc } from "./parsers/yrc-parser.js";
export type {
  LyricsParseError,
  LyricsParseInput,
  LyricsParseResult,
  LyricsParser,
  ParseDiagnostic,
} from "./parsers/types.js";
export {
  selectConcurrentPrimaryTailLines,
  resolveLineForegroundEndMs,
  isConcurrentPrimaryTailLine,
  type ConcurrentPrimaryTailSelection,
} from "./playback/concurrent-primary-tail.js";
export {
  selectActiveLines,
  type ActiveLineSelection,
} from "./playback/active-lines.js";
export {
  createPlaybackFrame,
  createPlaybackFrameContext,
  type CreatePlaybackFrameInput,
  type PlaybackFrame,
  type PlaybackFrameContext,
  type PlaybackFrameMode,
  type PlaybackFramePositions,
} from "./playback/create-playback-frame.js";
export {
  SHORT_EMPTY_ACTIVE_GAP_MS,
  TRAILING_VISUAL_PRIMARY_GRACE_MS,
  isShortEmptyActiveRetentionGap,
  resolveEmptyActiveGapState,
  shouldReleaseTrailingVisualPrimary,
  type EmptyActiveGapState,
} from "./playback/empty-gap-policy.js";
export {
  createFrameScheduler,
  type FrameSampleCause,
  type FrameScheduler,
  type FrameSchedulerOptions,
  type FrameSchedulerState,
} from "./playback/frame-scheduler.js";
export {
  diffLineNotifications,
  type LineNotificationDiff,
} from "./playback/line-notification-policy.js";
export {
  advanceVisualEventCoordinator,
  createVisualEventCoordinatorState,
  type AdvanceVisualEventCoordinatorInput,
  type VisualEventClocks,
  type VisualEventCoordinatorState,
  type VisualEventRetentionKind,
} from "./playback/visual-event-coordinator.js";
export {
  createLineCohort,
  selectActiveLineCohort,
  type LineCohort,
  type LineCohortMember,
} from "./playback/line-cohorts.js";
export {
  createManualClock,
  type ManualClockOptions,
  type ManualClockSource,
  type ManualPlaybackClock,
} from "./playback/manual-clock.js";
export {
  createMediaElementClock,
  type MediaElementClockOptions,
} from "./playback/media-element-clock.js";
export { projectPosition } from "./playback/project-position.js";
export {
  createTerminalLinePolicy,
  DEFAULT_TERMINAL_COHORT_WINDOW_MS,
  DEFAULT_TERMINAL_EXIT_DURATION_MS,
  resolveTerminalPlaybackState,
  type TerminalBoundarySource,
  type TerminalLineCohort,
  type TerminalLineMember,
  type TerminalLinePolicy,
  type TerminalLinePolicyOptions,
  type TerminalLineRole,
  type TerminalMemberPhase,
  type TerminalMemberState,
  type TerminalPlaybackPhase,
  type TerminalPlaybackState,
} from "./playback/terminal-policy.js";
export type {
  PlaybackClock,
  PlaybackDiscontinuity,
  PlaybackDiscontinuityReason,
  PlaybackNow,
  PlaybackPositionAnchor,
  PlaybackSnapshot,
  ProjectedPlaybackPosition,
  Unsubscribe,
} from "./playback/types.js";
export {
  advanceDisplayModeTransition,
  createDisplayModeTransitionState,
  DISPLAY_MODE_MORPH_DURATION_MS,
  requestDisplayModeTransition,
  type DisplayModeTransitionRequest,
  type DisplayModeTransitionState,
  type SyncedDisplayMode,
} from "./transitions/display-mode.js";
export {
  createRowMoveCoordinator,
  type BeginRowMoveOptions,
  type CompleteRowMoveOptions,
  type RowMoveCaptureEntry,
  type RowMoveCoordinator,
  type RowMoveHost,
  type RowMoveSample,
  type RowMoveState,
  type RowMoveTransaction,
} from "./transitions/row-move.js";
export {
  createSecondaryLaneTransition,
  type PreparedSecondaryLaneChange,
  type PreparedSecondaryLanePlan,
  type SecondaryLaneHost,
  type SecondaryLaneLineState,
  type SecondaryLaneMetrics,
  type SecondaryLanePresentation,
  type SecondaryLaneTransition,
  type SecondaryLaneTransitionOptions,
  type SecondaryLaneTransitionState,
  type SecondaryLaneVisualState,
} from "./transitions/secondary-lane.js";
export {
  createSecondaryTextTransitionState,
  isTranslationToggleCooldownActive,
  requestSecondaryTextTransition,
  resetSecondaryTextTransition,
  SECONDARY_TEXT_LAYOUT_DURATION_MS,
  TRANSLATION_TOGGLE_COOLDOWN_MS,
  type SecondaryTextTransitionRequest,
  type SecondaryTextTransitionResult,
  type SecondaryTextTransitionState,
  type SecondaryTextUpdateSource,
  type SecondaryTextVisibilityState,
} from "./transitions/secondary-text.js";
export {
  classifyWordAt,
  createWordIdsByTrack,
  wordTrackNames,
  type ActiveWordIdsByLine,
  type WordIdsByTrack,
  type WordTimingState,
  type WordTrackName,
} from "./playback/word-state.js";
