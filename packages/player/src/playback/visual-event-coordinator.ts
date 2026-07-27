import type { LyricDocument } from "../domain/types.js";
import type { LyricTimeIndex } from "../domain/time-index.js";
import {
  isShortEmptyActiveRetentionGap,
  resolveEmptyActiveGapState,
  shouldReleaseTrailingVisualPrimary,
  type EmptyActiveGapState,
} from "./empty-gap-policy.js";

export type VisualEventRetentionKind =
  | "none"
  | "short-empty-active-retain"
  | "trailing-event-retain-visual-release"
  | "trailing-event-retain-visual-hold"
  | "long-empty-clear";

export interface VisualEventClocks {
  readonly playbackPositionMs: number;
  readonly callbackPlaybackPositionMs: number;
  readonly lineEventPlaybackPositionMs: number;
  readonly wordPlaybackPositionMs: number;
}

export interface VisualEventCoordinatorState {
  readonly documentId: string;
  readonly clocks: VisualEventClocks;
  /** Pure half-open selection at the callback clock. */
  readonly requestedActiveLineIds: readonly string[];
  /**
   * Committed event/adapter vector after short-gap retention and busy gates.
   * Retaining this vector must not by itself keep a terminal row white.
   */
  readonly committedActiveLineIds: readonly string[];
  /** Rows that currently own primary white/active scale paint. */
  readonly visualPrimaryLineIds: readonly string[];
  readonly committedScrollLineId: string | null;
  readonly visualStyleFocusLineId: string | null;
  readonly retentionKind: VisualEventRetentionKind;
  readonly gap: EmptyActiveGapState;
  readonly layoutBusy: boolean;
  readonly pendingRequestedActiveLineIds: readonly string[] | null;
}

export interface AdvanceVisualEventCoordinatorInput {
  readonly document: LyricDocument;
  readonly timeIndex: LyricTimeIndex;
  readonly clocks: VisualEventClocks;
  readonly requestedActiveLineIds: readonly string[];
  readonly previous: VisualEventCoordinatorState | null;
  readonly playing: boolean;
  readonly mode: "playback" | "bind" | "seek" | "reset" | "recycle";
  readonly layoutBusy?: boolean;
}

function freezeIds(lineIds: readonly string[]): readonly string[] {
  return Object.freeze([...lineIds]);
}

function sameIdOrder(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function lyricOnly(lineIds: readonly string[], document: LyricDocument): boolean {
  if (lineIds.length === 0) return false;
  const byId = new Map(document.lines.map((line) => [line.id, line]));
  return lineIds.every((lineId) => {
    const line = byId.get(lineId);
    return line != null && line.type !== "instrumental" && line.type !== "credit";
  });
}

function createIdleState(
  documentId: string,
  clocks: VisualEventClocks,
  requestedActiveLineIds: readonly string[],
  gap: EmptyActiveGapState,
): VisualEventCoordinatorState {
  const requested = freezeIds(requestedActiveLineIds);
  return Object.freeze({
    documentId,
    clocks: Object.freeze({ ...clocks }),
    requestedActiveLineIds: requested,
    committedActiveLineIds: requested,
    visualPrimaryLineIds: requested,
    committedScrollLineId: requested[0] ?? null,
    visualStyleFocusLineId: requested[0] ?? null,
    retentionKind: "none",
    gap,
    layoutBusy: false,
    pendingRequestedActiveLineIds: null,
  });
}

/**
 * Advances requested-versus-committed active vectors for one playback sample.
 *
 * Short mid-song empty gaps retain the previous lyric event vector. Trailing
 * gaps may retain that vector for docking while releasing visual primary after
 * the accepted grace window. Layout-busy distinct active sets stay pending.
 */
export function advanceVisualEventCoordinator(
  input: AdvanceVisualEventCoordinatorInput,
): VisualEventCoordinatorState {
  const {
    document,
    timeIndex,
    clocks,
    requestedActiveLineIds,
    playing,
    mode,
  } = input;
  const layoutBusy = Boolean(input.layoutBusy);
  const gap = resolveEmptyActiveGapState(
    document,
    timeIndex,
    clocks.callbackPlaybackPositionMs,
  );
  const previous =
    input.previous?.documentId === document.id ? input.previous : null;

  if (mode === "reset" || mode === "seek" || mode === "recycle" || !previous) {
    return createIdleState(
      document.id,
      clocks,
      requestedActiveLineIds,
      gap,
    );
  }

  const requested = freezeIds(requestedActiveLineIds);
  let committed = requested;
  let retentionKind: VisualEventRetentionKind = "none";
  let pendingRequestedActiveLineIds: readonly string[] | null = null;

  if (layoutBusy && !sameIdOrder(requested, previous.committedActiveLineIds)) {
    committed = freezeIds(previous.committedActiveLineIds);
    pendingRequestedActiveLineIds = requested;
    retentionKind =
      previous.retentionKind === "none"
        ? "short-empty-active-retain"
        : previous.retentionKind;
  } else if (
    mode === "playback" &&
    playing &&
    requested.length === 0 &&
    previous.committedActiveLineIds.length > 0 &&
    lyricOnly(previous.committedActiveLineIds, document) &&
    isShortEmptyActiveRetentionGap(gap)
  ) {
    committed = freezeIds(previous.committedActiveLineIds);
    retentionKind = gap.trailing
      ? "trailing-event-retain-visual-hold"
      : "short-empty-active-retain";
  } else if (
    mode === "playback" &&
    requested.length === 0 &&
    previous.committedActiveLineIds.length > 0 &&
    gap.inGap &&
    !isShortEmptyActiveRetentionGap(gap)
  ) {
    committed = freezeIds([]);
    retentionKind = "long-empty-clear";
  } else if (pendingRequestedActiveLineIds === null && previous.pendingRequestedActiveLineIds) {
    // Busy cleared: consume the pending distinct active set.
    committed = freezeIds(previous.pendingRequestedActiveLineIds);
  }

  if (
    layoutBusy &&
    pendingRequestedActiveLineIds === null &&
    previous.pendingRequestedActiveLineIds
  ) {
    pendingRequestedActiveLineIds = previous.pendingRequestedActiveLineIds;
  }

  const documentDuration = Number.isFinite(document.duration?.valueMs)
    ? (document.duration?.valueMs as number)
    : null;
  const releaseTrailingVisual = shouldReleaseTrailingVisualPrimary(
    gap,
    clocks.callbackPlaybackPositionMs,
    playing,
    documentDuration,
  );

  let visualPrimary = committed;
  if (
    committed.length > 0 &&
    requested.length === 0 &&
    gap.trailing &&
    releaseTrailingVisual
  ) {
    visualPrimary = freezeIds([]);
    retentionKind = "trailing-event-retain-visual-release";
  }

  const committedScrollLineId =
    visualPrimary[0] ??
    committed[0] ??
    (retentionKind === "trailing-event-retain-visual-release"
      ? previous.committedScrollLineId ?? previous.committedActiveLineIds[0] ?? null
      : null);

  const visualStyleFocusLineId = visualPrimary[0] ?? null;

  return Object.freeze({
    documentId: document.id,
    clocks: Object.freeze({ ...clocks }),
    requestedActiveLineIds: requested,
    committedActiveLineIds: committed,
    visualPrimaryLineIds: visualPrimary,
    committedScrollLineId,
    visualStyleFocusLineId,
    retentionKind,
    gap,
    layoutBusy,
    pendingRequestedActiveLineIds: pendingRequestedActiveLineIds
      ? freezeIds(pendingRequestedActiveLineIds)
      : null,
  });
}

export function createVisualEventCoordinatorState(
  document: LyricDocument,
  clocks: VisualEventClocks,
  requestedActiveLineIds: readonly string[] = [],
  timeIndex: LyricTimeIndex,
): VisualEventCoordinatorState {
  return createIdleState(
    document.id,
    clocks,
    requestedActiveLineIds,
    resolveEmptyActiveGapState(
      document,
      timeIndex,
      clocks.callbackPlaybackPositionMs,
    ),
  );
}
