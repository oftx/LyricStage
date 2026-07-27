import type { LyricDocument, TextLyricLine } from "../domain/types.js";
import type { PlaybackFrame } from "../playback/create-playback-frame.js";

export type SecondaryLaneTarget = "none" | "collapsed" | "expanded";
export type SecondaryLaneTargetReason =
  | "no-secondary-content"
  | "focus-line"
  | "non-focus-line";

export interface SecondaryLaneVisibility {
  readonly translationVisible: boolean;
  readonly pronunciationVisible: boolean;
}

export interface SecondaryLaneLayoutState {
  readonly lineId: string;
  readonly target: SecondaryLaneTarget;
  readonly reason: SecondaryLaneTargetReason;
  readonly hasBackground: boolean;
  readonly hasBackgroundPronunciation: boolean;
  readonly hasBackgroundTranslation: boolean;
  readonly visibleBackgroundPronunciation: boolean;
  readonly visibleBackgroundTranslation: boolean;
}

export interface SecondaryLaneLayoutPlan {
  readonly documentId: string;
  readonly focusLineId: string | null;
  readonly states: readonly SecondaryLaneLayoutState[];
  getByLineId(lineId: string): SecondaryLaneLayoutState | null;
}

const defaultVisibility: SecondaryLaneVisibility = Object.freeze({
  translationVisible: true,
  pronunciationVisible: true,
});

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function createLineState(
  line: TextLyricLine,
  focusLineId: string | null,
  visibility: SecondaryLaneVisibility,
): SecondaryLaneLayoutState {
  const hasBackground = hasText(line.tracks.background?.text);
  const hasBackgroundPronunciation = hasText(
    line.tracks.backgroundPronunciation?.text,
  );
  const hasBackgroundTranslation = hasText(line.backgroundTranslation?.text);
  const visibleBackgroundPronunciation =
    hasBackgroundPronunciation && visibility.pronunciationVisible;
  const visibleBackgroundTranslation =
    hasBackgroundTranslation && visibility.translationVisible;
  const hasSecondaryContent =
    hasBackground ||
    visibleBackgroundPronunciation ||
    visibleBackgroundTranslation;
  const target: SecondaryLaneTarget = !hasSecondaryContent
    ? "none"
    : line.id === focusLineId
      ? "expanded"
      : "collapsed";

  return Object.freeze({
    lineId: line.id,
    target,
    reason: !hasSecondaryContent
      ? "no-secondary-content"
      : line.id === focusLineId
        ? "focus-line"
        : "non-focus-line",
    hasBackground,
    hasBackgroundPronunciation,
    hasBackgroundTranslation,
    visibleBackgroundPronunciation,
    visibleBackgroundTranslation,
  });
}

/**
 * Resolves secondary-lane targets without reading DOM geometry. Phase 6 owns
 * interpolation, mask invalidation, and focus reanchoring between these states.
 */
export function createSecondaryLaneLayoutPlan(
  document: LyricDocument,
  frame: PlaybackFrame | null,
  visibility: SecondaryLaneVisibility = defaultVisibility,
): SecondaryLaneLayoutPlan {
  const focusLineId =
    frame?.documentId === document.id ? frame.focusLineId : null;
  const states = Object.freeze(
    document.lines.flatMap((line) =>
      line.type === "instrumental"
        ? []
        : [createLineState(line, focusLineId, visibility)],
    ),
  );
  const byLineId = new Map(states.map((state) => [state.lineId, state]));

  return Object.freeze({
    documentId: document.id,
    focusLineId,
    states,
    getByLineId(lineId: string): SecondaryLaneLayoutState | null {
      return byLineId.get(lineId) ?? null;
    },
  });
}
