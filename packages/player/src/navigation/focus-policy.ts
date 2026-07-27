import type { LyricDocument } from "../domain/types.js";
import type { PlaybackFrame } from "../playback/create-playback-frame.js";
import { resolveLineForegroundEndMs } from "../playback/concurrent-primary-tail.js";

export type FocusPolicyReason =
  | "notify-initial-current-first-last"
  | "notify-current-first-last"
  | "notify-advancing-nonconsecutive-last"
  | "no-notify-current-subset-of-previous"
  | "empty-current-reset-range"
  | "empty-current"
  | "trailing-lyric-style-release"
  | "short-empty-active-retain-dock"
  | "click-seek-forced-focus-line"
  | "notify-advance-past-foreground-done-secondary-residual"
  | "post-forced-release-secondary-residual-redock"
  | "seek-scroll-floor-eligible-active"
  | "seek-scroll-floor-hold-clicked-line"
  | "instrumental-breathing-focus-hold"
  | "instrumental-exit-focus-hold";

export interface FocusPolicyContext {
  readonly documentId: string;
  readonly lineIds: readonly string[];
  getDocumentIndex(lineId: string): number | null;
  isForegroundTimedLive(lineId: string, positionMs: number): boolean;
}

export interface FocusPolicyState {
  readonly documentId: string;
  /** Active/style focus. This always belongs to the current active set. */
  readonly focusLineId: string | null;
  /** Retained notification/scroll focus. It may be a just-finished row. */
  readonly highlightedLineId: string | null;
  readonly visualFocusLineId: string | null;
  readonly visualStyleFocusLineId: string | null;
  readonly visualFocusReason: FocusPolicyReason;
  readonly notifyStartLineId: string | null;
  readonly notifyEndLineId: string | null;
  readonly lineMoveAnchorLineId: string | null;
  readonly previousActiveLineIds: readonly string[];
  readonly currentActiveLineIds: readonly string[];
  readonly intersectionLineIds: readonly string[];
  readonly currentSubsetOfPrevious: boolean;
  readonly currentIsConsecutive: boolean;
  readonly focusChanged: boolean;
  readonly highlightedChanged: boolean;
  readonly reason: FocusPolicyReason;
}

function uniqueKnownLineIds(
  context: FocusPolicyContext,
  lineIds: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  return Object.freeze(
    lineIds.filter((lineId) => {
      if (seen.has(lineId) || context.getDocumentIndex(lineId) === null) {
        return false;
      }
      seen.add(lineId);
      return true;
    }),
  );
}

function isConsecutive(
  context: FocusPolicyContext,
  lineIds: readonly string[],
): boolean {
  if (lineIds.length < 2) return true;
  let previousIndex = context.getDocumentIndex(lineIds[0] as string);
  if (previousIndex === null) return false;
  for (let index = 1; index < lineIds.length; index += 1) {
    const currentIndex = context.getDocumentIndex(lineIds[index] as string);
    if (currentIndex === null || currentIndex !== previousIndex + 1) {
      return false;
    }
    previousIndex = currentIndex;
  }
  return true;
}

function lastDocumentIndex(
  context: FocusPolicyContext,
  lineIds: readonly string[],
): number {
  const lineId = lineIds.at(-1);
  return lineId === undefined ? -1 : (context.getDocumentIndex(lineId) ?? -1);
}

function freezeState(
  context: FocusPolicyContext,
  previous: FocusPolicyState | null,
  currentActiveLineIds: readonly string[],
  values: Omit<
    FocusPolicyState,
    | "documentId"
    | "previousActiveLineIds"
    | "currentActiveLineIds"
    | "intersectionLineIds"
    | "currentSubsetOfPrevious"
    | "currentIsConsecutive"
    | "focusChanged"
    | "highlightedChanged"
  >,
): FocusPolicyState {
  const previousActiveLineIds = previous?.currentActiveLineIds ?? [];
  const previousSet = new Set(previousActiveLineIds);
  const intersectionLineIds = Object.freeze(
    currentActiveLineIds.filter((lineId) => previousSet.has(lineId)),
  );
  const currentSubsetOfPrevious =
    currentActiveLineIds.length > 0 &&
    currentActiveLineIds.every((lineId) => previousSet.has(lineId));
  const currentIsConsecutive = isConsecutive(context, currentActiveLineIds);
  return Object.freeze({
    documentId: context.documentId,
    ...values,
    previousActiveLineIds: Object.freeze([...previousActiveLineIds]),
    currentActiveLineIds: Object.freeze([...currentActiveLineIds]),
    intersectionLineIds,
    currentSubsetOfPrevious,
    currentIsConsecutive,
    focusChanged: previous?.focusLineId !== values.focusLineId,
    highlightedChanged:
      previous?.highlightedLineId !== values.highlightedLineId,
  });
}

export function createFocusPolicyContext(
  document: LyricDocument,
): FocusPolicyContext {
  const lineIds = Object.freeze(document.lines.map((line) => line.id));
  const indexByLineId = new Map(
    lineIds.map((lineId, documentIndex) => [lineId, documentIndex]),
  );
  return Object.freeze({
    documentId: document.id,
    lineIds,
    getDocumentIndex(lineId: string): number | null {
      return indexByLineId.get(lineId) ?? null;
    },
    isForegroundTimedLive(lineId: string, positionMs: number): boolean {
      const documentIndex = indexByLineId.get(lineId);
      const line =
        documentIndex === undefined ? undefined : document.lines[documentIndex];
      if (
        !line ||
        line.type === "instrumental" ||
        line.type === "credit" ||
        !Number.isFinite(positionMs)
      ) {
        return false;
      }
      const beginMs = line.begin.valueMs;
      const foregroundEndMs = resolveLineForegroundEndMs(line);
      return (
        beginMs !== null &&
        foregroundEndMs !== null &&
        Number.isFinite(beginMs) &&
        Number.isFinite(foregroundEndMs) &&
        positionMs >= beginMs &&
        positionMs < foregroundEndMs
      );
    },
  });
}

function advancePastForegroundResidual(
  context: FocusPolicyContext,
  previous: FocusPolicyState | null,
  current: readonly string[],
  frame: PlaybackFrame,
  state: FocusPolicyState,
): FocusPolicyState {
  const leading = current[0];
  if (
    current.length < 2 ||
    leading === undefined ||
    context.isForegroundTimedLive(
      leading,
      frame.callbackPlaybackPositionMs,
    )
  ) {
    return state;
  }
  const preferred = current.find((lineId) =>
    context.isForegroundTimedLive(lineId, frame.callbackPlaybackPositionMs),
  );
  if (!preferred || preferred === state.focusLineId) return state;
  const notifyEnd = current.at(-1) ?? preferred;
  const reason: FocusPolicyReason =
    "notify-advance-past-foreground-done-secondary-residual";
  return freezeState(context, previous, current, {
    focusLineId: preferred,
    highlightedLineId: preferred,
    visualFocusLineId: preferred,
    visualStyleFocusLineId: preferred,
    visualFocusReason: reason,
    notifyStartLineId: preferred,
    notifyEndLineId: notifyEnd,
    lineMoveAnchorLineId: notifyEnd,
    reason,
  });
}

/**
 * Reconstructs the notification-range focus policy independently from row
 * styling. A subset frame retains scroll focus while styling the remaining row.
 */
export function advanceFocusPolicy(
  context: FocusPolicyContext,
  previous: FocusPolicyState | null,
  frame: PlaybackFrame,
): FocusPolicyState {
  const prior = previous?.documentId === context.documentId ? previous : null;
  const current = uniqueKnownLineIds(
    context,
    frame.activeLineIdsInSourceOrder,
  );
  const previousCurrent = prior?.currentActiveLineIds ?? [];
  const previousSet = new Set(previousCurrent);
  const intersection = current.filter((lineId) => previousSet.has(lineId));
  const subset =
    current.length > 0 && current.every((lineId) => previousSet.has(lineId));
  const consecutive = isConsecutive(context, current);

  if (current.length === 0) {
    const retainedDock =
      frame.committedScrollLineId &&
      context.getDocumentIndex(frame.committedScrollLineId) !== null
        ? frame.committedScrollLineId
        : null;
    if (
      retainedDock &&
      (frame.visualEventRetentionKind ===
        "trailing-event-retain-visual-release" ||
        frame.visualEventRetentionKind === "short-empty-active-retain" ||
        frame.visualEventRetentionKind ===
          "trailing-event-retain-visual-hold")
    ) {
      const reason: FocusPolicyReason =
        frame.visualEventRetentionKind ===
        "trailing-event-retain-visual-release"
          ? "trailing-lyric-style-release"
          : "short-empty-active-retain-dock";
      return freezeState(context, prior, current, {
        focusLineId: null,
        highlightedLineId: retainedDock,
        visualFocusLineId: retainedDock,
        visualStyleFocusLineId: null,
        visualFocusReason: reason,
        notifyStartLineId: null,
        notifyEndLineId: null,
        lineMoveAnchorLineId: retainedDock,
        reason,
      });
    }
    const reason: FocusPolicyReason =
      previousCurrent.length > 0
        ? "empty-current-reset-range"
        : "empty-current";
    return freezeState(context, prior, current, {
      focusLineId: null,
      highlightedLineId: null,
      visualFocusLineId: null,
      visualStyleFocusLineId: null,
      visualFocusReason: reason,
      notifyStartLineId: null,
      notifyEndLineId: null,
      lineMoveAnchorLineId: null,
      reason,
    });
  }

  if (prior && subset) {
    const styleFocus =
      prior.focusLineId && current.includes(prior.focusLineId)
        ? prior.focusLineId
        : current[0] ?? null;
    const highlighted = prior.highlightedLineId ?? styleFocus;
    const reason: FocusPolicyReason =
      "no-notify-current-subset-of-previous";
    const state = freezeState(context, prior, current, {
      focusLineId: styleFocus,
      highlightedLineId: highlighted,
      visualFocusLineId: highlighted,
      visualStyleFocusLineId: styleFocus,
      visualFocusReason: reason,
      notifyStartLineId: null,
      notifyEndLineId: null,
      lineMoveAnchorLineId: prior.lineMoveAnchorLineId,
      reason,
    });
    return advancePastForegroundResidual(
      context,
      prior,
      current,
      frame,
      state,
    );
  }

  const advancesNonconsecutively =
    prior !== null &&
    intersection.length > 0 &&
    lastDocumentIndex(context, current) >
      lastDocumentIndex(context, previousCurrent) &&
    !consecutive;
  if (advancesNonconsecutively) {
    const last = current.at(-1) ?? null;
    const reason: FocusPolicyReason =
      "notify-advancing-nonconsecutive-last";
    const state = freezeState(context, prior, current, {
      focusLineId: last,
      highlightedLineId: last,
      visualFocusLineId: last,
      visualStyleFocusLineId: last,
      visualFocusReason: reason,
      notifyStartLineId: last,
      notifyEndLineId: last,
      lineMoveAnchorLineId: last,
      reason,
    });
    return advancePastForegroundResidual(
      context,
      prior,
      current,
      frame,
      state,
    );
  }

  const first = current[0] ?? null;
  const last = current.at(-1) ?? null;
  const reason: FocusPolicyReason = prior
    ? "notify-current-first-last"
    : "notify-initial-current-first-last";
  const state = freezeState(context, prior, current, {
    focusLineId: first,
    highlightedLineId: first,
    visualFocusLineId: first,
    visualStyleFocusLineId: first,
    visualFocusReason: reason,
    notifyStartLineId: first,
    notifyEndLineId: last,
    lineMoveAnchorLineId: last,
    reason,
  });
  return advancePastForegroundResidual(
    context,
    prior,
    current,
    frame,
    state,
  );
}
