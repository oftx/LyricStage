import type { LyricDocument, LyricLine } from "../domain/types.js";
import { resolveLineForegroundEndMs } from "../playback/concurrent-primary-tail.js";

export interface ClickSeekOwnershipState {
  readonly forcedFocusLineId: string | null;
  readonly seekScrollFloorLineId: string | null;
  readonly seekScrollFloorStartMs: number | null;
  readonly reason: string;
}

export type SeekScrollFloorReason =
  | "seek-scroll-floor-eligible-active"
  | "seek-scroll-floor-hold-clicked-line";

export interface SeekScrollFloorResolution {
  readonly scrollLineId: string | null;
  readonly styleLineId: string | null;
  readonly reason: SeekScrollFloorReason | null;
}

export function createClickSeekOwnershipState(): ClickSeekOwnershipState {
  return Object.freeze({
    forcedFocusLineId: null,
    seekScrollFloorLineId: null,
    seekScrollFloorStartMs: null,
    reason: "idle",
  });
}

function lineBeginMs(line: LyricLine): number | null {
  const value = line.begin.valueMs;
  return value !== null && Number.isFinite(value) ? value : null;
}

function lineEndMs(line: LyricLine): number | null {
  const value = line.end.valueMs;
  return value !== null && Number.isFinite(value) ? value : null;
}

function findLine(
  document: LyricDocument,
  lineId: string | null,
): LyricLine | null {
  if (!lineId) return null;
  return document.lines.find((line) => line.id === lineId) ?? null;
}

function findLineIndex(
  document: LyricDocument,
  lineId: string | null,
): number {
  if (!lineId) return -1;
  return document.lines.findIndex((line) => line.id === lineId);
}

function isSeekableTextLine(line: LyricLine | null): line is LyricLine {
  return (
    line !== null && line.type !== "instrumental" && line.type !== "credit"
  );
}

function isForegroundTimedLive(
  line: LyricLine | null,
  positionMs: number,
): boolean {
  if (!isSeekableTextLine(line) || !Number.isFinite(positionMs)) return false;
  const beginMs = lineBeginMs(line);
  const foregroundEndMs = resolveLineForegroundEndMs(line);
  return (
    beginMs !== null &&
    foregroundEndMs !== null &&
    Number.isFinite(foregroundEndMs) &&
    positionMs >= beginMs &&
    positionMs < foregroundEndMs
  );
}

function orderedUniqueKnownLineIds(
  document: LyricDocument,
  lineIds: readonly string[],
): readonly string[] {
  const indexes = new Set<number>();
  for (const lineId of lineIds) {
    const index = findLineIndex(document, lineId);
    if (index >= 0) indexes.add(index);
  }
  return Object.freeze(
    [...indexes]
      .sort((left, right) => left - right)
      .map((index) => document.lines[index]?.id)
      .filter((lineId): lineId is string => lineId !== undefined),
  );
}

function selectFloorEligibleLineId(
  document: LyricDocument,
  currentLineIds: readonly string[],
  previousLineIds: readonly string[],
  previousFocusLineId: string | null,
  positionMs: number,
): string | null {
  const current = orderedUniqueKnownLineIds(document, currentLineIds);
  if (current.length === 0) return null;
  const previous = orderedUniqueKnownLineIds(document, previousLineIds);
  const previousSet = new Set(previous);
  const intersection = current.filter((lineId) => previousSet.has(lineId));
  const currentSubsetOfPrevious = current.every((lineId) =>
    previousSet.has(lineId),
  );
  const currentIndexes = current.map((lineId) =>
    findLineIndex(document, lineId),
  );
  const currentIsConsecutive = currentIndexes.every(
    (lineIndex, index) =>
      index === 0 || lineIndex === (currentIndexes[index - 1] ?? -2) + 1,
  );
  const lastCurrentIndex = currentIndexes.at(-1) ?? -1;
  const lastPreviousIndex = findLineIndex(document, previous.at(-1) ?? null);

  let focusLineId = current[0] ?? null;
  if (
    intersection.length > 0 &&
    lastCurrentIndex > lastPreviousIndex &&
    !currentIsConsecutive
  ) {
    focusLineId = current.at(-1) ?? focusLineId;
  } else if (
    currentSubsetOfPrevious &&
    previousFocusLineId !== null &&
    current.includes(previousFocusLineId)
  ) {
    focusLineId = previousFocusLineId;
  }

  if (current.length > 1) {
    const leadingLine = findLine(document, current[0] ?? null);
    if (!isForegroundTimedLive(leadingLine, positionMs)) {
      const foregroundLiveLineId = current.find((lineId) =>
        isForegroundTimedLive(findLine(document, lineId), positionMs),
      );
      if (foregroundLiveLineId) focusLineId = foregroundLiveLineId;
    }
  }
  return focusLineId;
}

export function setClickSeekOwnership(
  document: LyricDocument,
  lineId: string,
): ClickSeekOwnershipState {
  const line = findLine(document, lineId);
  if (!line || line.type === "instrumental" || line.type === "credit") {
    return createClickSeekOwnershipState();
  }
  const beginMs = lineBeginMs(line);
  return Object.freeze({
    forcedFocusLineId: line.id,
    seekScrollFloorLineId: beginMs === null ? null : line.id,
    seekScrollFloorStartMs: beginMs,
    reason: "click-seek-forced",
  });
}

export function clearClickSeekOwnership(
  reason = "cleared",
): ClickSeekOwnershipState {
  return Object.freeze({
    forcedFocusLineId: null,
    seekScrollFloorLineId: null,
    seekScrollFloorStartMs: null,
    reason,
  });
}

/** Clears focus ownership while preserving the independent scroll floor. */
export function clearForcedClickSeekOwnership(
  state: ClickSeekOwnershipState,
  reason = "forced-focus-cleared",
): ClickSeekOwnershipState {
  if (state.forcedFocusLineId === null) return state;
  return Object.freeze({
    ...state,
    forcedFocusLineId: null,
    reason,
  });
}

/** Clears the scroll floor without disturbing forced focus ownership. */
export function clearSeekScrollFloor(
  state: ClickSeekOwnershipState,
  reason = "seek-scroll-floor-cleared",
): ClickSeekOwnershipState {
  if (
    state.seekScrollFloorLineId === null &&
    state.seekScrollFloorStartMs === null
  ) {
    return state;
  }
  return Object.freeze({
    ...state,
    seekScrollFloorLineId: null,
    seekScrollFloorStartMs: null,
    reason,
  });
}

/**
 * Expire forced click-seek ownership after the clicked line's authored end.
 */
export function maybeExpireClickSeekOwnership(
  state: ClickSeekOwnershipState,
  document: LyricDocument,
  positionMs: number,
): ClickSeekOwnershipState {
  if (!state.forcedFocusLineId) return state;
  const forced = findLine(document, state.forcedFocusLineId);
  if (!forced) return clearForcedClickSeekOwnership(state, "missing-line");
  const endMs = lineEndMs(forced);
  if (endMs !== null && positionMs >= endMs) {
    return clearForcedClickSeekOwnership(state, "past-forced-line-end");
  }
  return state;
}

/**
 * The scroll floor outlives an early forced-focus release. It expires only
 * after the clicked line ends and no earlier active interval can re-dock.
 */
export function maybeExpireSeekScrollFloor(
  state: ClickSeekOwnershipState,
  document: LyricDocument,
  positionMs: number,
  rawActiveLineIds: readonly string[] = [],
): ClickSeekOwnershipState {
  const floorStartMs = state.seekScrollFloorStartMs;
  if (
    state.seekScrollFloorLineId === null ||
    floorStartMs === null ||
    !Number.isFinite(floorStartMs)
  ) {
    return state;
  }
  const floorLine = findLine(document, state.seekScrollFloorLineId);
  if (!floorLine) return clearSeekScrollFloor(state, "missing-floor-line");
  const floorEndMs = lineEndMs(floorLine);
  if (floorEndMs === null || !Number.isFinite(positionMs)) return state;

  const earlierStillLive = rawActiveLineIds.some((lineId) => {
    const line = findLine(document, lineId);
    if (!isSeekableTextLine(line)) return false;
    const beginMs = lineBeginMs(line);
    return beginMs !== null && beginMs < floorStartMs;
  });
  if (positionMs >= floorEndMs && !earlierStillLive) {
    return clearSeekScrollFloor(state, "past-floor-and-no-earlier-live");
  }
  return state;
}

/**
 * Resolves the first later foreground that can take focus from a clicked line
 * whose x-bg residual extends beyond its foreground timing.
 */
export function resolveClickSeekSecondaryResidualFocusLineId(
  state: ClickSeekOwnershipState,
  document: LyricDocument,
  positionMs: number,
  rawActiveLineIds: readonly string[] = [],
): string | null {
  const forcedIndex = findLineIndex(document, state.forcedFocusLineId);
  if (forcedIndex < 0) return null;
  const forced = document.lines[forcedIndex] ?? null;
  if (!isSeekableTextLine(forced)) return null;
  if (isForegroundTimedLive(forced, positionMs)) return null;

  return (
    orderedUniqueKnownLineIds(document, rawActiveLineIds).find((lineId) => {
      const lineIndex = findLineIndex(document, lineId);
      if (lineIndex <= forcedIndex) return false;
      return isForegroundTimedLive(
        document.lines[lineIndex] ?? null,
        positionMs,
      );
    }) ?? null
  );
}

/**
 * Releases a clicked line once its foreground is done and a later foreground
 * is live, even when an x-bg residual extends the clicked line's full end.
 */
export function shouldReleaseClickSeekForceForSecondaryResidual(
  state: ClickSeekOwnershipState,
  document: LyricDocument,
  positionMs: number,
  rawActiveLineIds: readonly string[] = [],
): boolean {
  return (
    resolveClickSeekSecondaryResidualFocusLineId(
      state,
      document,
      positionMs,
      rawActiveLineIds,
    ) !== null
  );
}

/** Blocks a scroll/style target from moving before the click-seek floor. */
export function applySeekScrollFloor(
  state: ClickSeekOwnershipState,
  document: LyricDocument,
  scrollLineId: string | null,
  styleLineId: string | null,
  positionMs: number,
  rawActiveLineIds: readonly string[] = [],
  previousActiveLineIds: readonly string[] = [],
  previousFocusLineId: string | null = null,
): SeekScrollFloorResolution {
  const floorStartMs = state.seekScrollFloorStartMs;
  if (floorStartMs === null || !Number.isFinite(floorStartMs)) {
    return Object.freeze({ scrollLineId, styleLineId, reason: null });
  }
  const candidate = findLine(document, scrollLineId);
  const candidateBeginMs = candidate ? lineBeginMs(candidate) : null;
  if (candidateBeginMs !== null && candidateBeginMs >= floorStartMs) {
    return Object.freeze({ scrollLineId, styleLineId, reason: null });
  }

  const eligibleRawLineIds = rawActiveLineIds.filter((lineId) => {
    const line = findLine(document, lineId);
    if (!isSeekableTextLine(line)) return false;
    const beginMs = lineBeginMs(line);
    return beginMs !== null && beginMs >= floorStartMs;
  });
  const eligibleFocusLineId = selectFloorEligibleLineId(
    document,
    eligibleRawLineIds,
    previousActiveLineIds,
    previousFocusLineId,
    positionMs,
  );
  if (eligibleFocusLineId !== null) {
    return Object.freeze({
      scrollLineId: eligibleFocusLineId,
      styleLineId: eligibleFocusLineId,
      reason: "seek-scroll-floor-eligible-active",
    });
  }

  const floorLineId =
    resolveForcedFocusLineId(state, document) ??
    findLine(document, state.seekScrollFloorLineId)?.id ??
    null;
  if (floorLineId !== null) {
    return Object.freeze({
      scrollLineId: floorLineId,
      styleLineId: floorLineId,
      reason: "seek-scroll-floor-hold-clicked-line",
    });
  }
  return Object.freeze({ scrollLineId, styleLineId, reason: null });
}

function intervalsOverlap(left: LyricLine, right: LyricLine): boolean {
  const leftBegin = lineBeginMs(left);
  const leftEnd = lineEndMs(left);
  const rightBegin = lineBeginMs(right);
  const rightEnd = lineEndMs(right);
  if (
    leftBegin === null ||
    leftEnd === null ||
    rightBegin === null ||
    rightEnd === null
  ) {
    return false;
  }
  return leftBegin < rightEnd && rightBegin < leftEnd;
}

/**
 * Earlier overlapping partners of the click-seek target must not keep primary
 * white / first-hold styling (legacy isPaintSuppressedBySeekOwnership).
 */
export function isPaintSuppressedByClickSeekOwnership(
  state: ClickSeekOwnershipState,
  document: LyricDocument,
  lineId: string,
): boolean {
  if (!state.forcedFocusLineId || lineId === state.forcedFocusLineId) {
    return false;
  }
  const forced = findLine(document, state.forcedFocusLineId);
  const line = findLine(document, lineId);
  if (!forced || !line) return false;
  if (line.type === "instrumental" || line.type === "credit") return false;
  if (!intervalsOverlap(line, forced)) return false;
  const lineBegin = lineBeginMs(line);
  const forcedBegin = lineBeginMs(forced);
  if (lineBegin === null || forcedBegin === null) return false;
  return (
    lineBegin < forcedBegin ||
    (lineBegin === forcedBegin && line.id < forced.id)
  );
}

export function resolveForcedFocusLineId(
  state: ClickSeekOwnershipState,
  document: LyricDocument,
): string | null {
  if (!state.forcedFocusLineId) return null;
  return findLine(document, state.forcedFocusLineId)?.id ?? null;
}
