import { createLyricTimeIndex } from "../domain/time-index.js";
import type { LyricTimeIndex } from "../domain/time-index.js";
import type { LyricDocument, LyricLine } from "../domain/types.js";
import {
  createImmutableSet,
  selectActiveLines,
} from "./active-lines.js";
import {
  createConcurrentPrimaryTailIndex,
  selectConcurrentPrimaryTailLinesFromIndex,
  type ConcurrentPrimaryTailIndex,
} from "./concurrent-primary-tail.js";
import { diffLineNotifications } from "./line-notification-policy.js";
import type {
  PlaybackDiscontinuity,
  PlaybackSnapshot,
} from "./types.js";
import {
  advanceVisualEventCoordinator,
  type VisualEventCoordinatorState,
  type VisualEventRetentionKind,
} from "./visual-event-coordinator.js";
import {
  createWordIdsByTrack,
  type ActiveWordIdsByLine,
  type WordIdsByTrack,
} from "./word-state.js";

export type PlaybackFrameMode =
  | "playback"
  | "bind"
  | "seek"
  | "reset"
  | "recycle";

export interface PlaybackFrameContext {
  readonly document: LyricDocument;
  readonly timeIndex: LyricTimeIndex;
  /** Stable source lookup reused by every playback frame. */
  readonly lineById: ReadonlyMap<string, LyricLine>;
}

const concurrentPrimaryTailIndexByFrameContext = new WeakMap<
  PlaybackFrameContext,
  ConcurrentPrimaryTailIndex
>();

export interface PlaybackFramePositions {
  readonly playbackPositionMs?: number;
  readonly lineEventPlaybackPositionMs?: number;
  readonly callbackPlaybackPositionMs?: number;
  readonly wordPlaybackPositionMs?: number;
}

export interface PlaybackFrame {
  readonly documentId: string;
  readonly playbackPositionMs: number;
  readonly lineEventPlaybackPositionMs: number;
  readonly callbackPlaybackPositionMs: number;
  readonly wordPlaybackPositionMs: number;
  readonly playbackRevision: number;
  readonly discontinuity: PlaybackDiscontinuity | null;
  /** Rows owning primary white/active scale paint after visual release policy. */
  readonly activeLineIds: ReadonlySet<string>;
  readonly activeLineIdsInSourceOrder: readonly string[];
  /** Pure half-open selection before retention. */
  readonly requestedActiveLineIdsInSourceOrder: readonly string[];
  /** Committed event/adapter vector; may outlive visual primary paint. */
  readonly eventActiveLineIdsInSourceOrder: readonly string[];
  readonly previousActiveLineIds: ReadonlySet<string>;
  readonly previousActiveLineIdsInSourceOrder: readonly string[];
  readonly enteredLineIds: readonly string[];
  readonly exitedLineIds: readonly string[];
  readonly retainedLineIds: readonly string[];
  readonly focusLineId: string | null;
  readonly committedScrollLineId: string | null;
  readonly visualEventRetentionKind: VisualEventRetentionKind;
  /**
   * Finished lead rows that keep full primary fill while an overlapping partner
   * remains live. Separate from activeLineIds so glow/event ownership do not
   * re-arm as a true current active set.
   */
  readonly concurrentPrimaryTailLineIds: ReadonlySet<string>;
  readonly concurrentPrimaryTailLineIdsInSourceOrder: readonly string[];
  /** Prior frame concurrent tails, used so fill can deactivate after partner ends. */
  readonly previousConcurrentPrimaryTailLineIdsInSourceOrder: readonly string[];
  readonly nextLineId: string | null;
  readonly foregroundWordIds: ActiveWordIdsByLine;
  readonly backgroundWordIds: ActiveWordIdsByLine;
  readonly wordIdsByTrack: WordIdsByTrack;
  readonly mode: PlaybackFrameMode;
}

export interface CreatePlaybackFrameInput {
  readonly snapshot: PlaybackSnapshot;
  readonly previousFrame?: PlaybackFrame | null;
  readonly mode?: PlaybackFrameMode;
  readonly positions?: PlaybackFramePositions;
  readonly layoutBusy?: boolean;
}

/** Creates the reusable document lookup once instead of rebuilding it per frame. */
export function createPlaybackFrameContext(
  document: LyricDocument,
): PlaybackFrameContext {
  const lineById = new Map<string, LyricLine>();
  for (const line of document.lines) {
    if (!lineById.has(line.id)) lineById.set(line.id, line);
  }
  const timeIndex = createLyricTimeIndex(document);
  const context: PlaybackFrameContext = Object.freeze({
    document,
    timeIndex,
    lineById,
  });
  concurrentPrimaryTailIndexByFrameContext.set(
    context,
    createConcurrentPrimaryTailIndex(document, timeIndex),
  );
  return context;
}

function concurrentPrimaryTailIndexForContext(
  context: PlaybackFrameContext,
): ConcurrentPrimaryTailIndex {
  const cached = concurrentPrimaryTailIndexByFrameContext.get(context);
  if (cached) return cached;
  const created = createConcurrentPrimaryTailIndex(
    context.document,
    context.timeIndex,
  );
  // Preserve compatibility with callers that construct the public context by hand.
  concurrentPrimaryTailIndexByFrameContext.set(context, created);
  return created;
}

function resolveFrameMode(
  snapshot: PlaybackSnapshot,
  previousFrame: PlaybackFrame | null,
  explicitMode: PlaybackFrameMode | undefined,
): PlaybackFrameMode {
  if (explicitMode) return explicitMode;
  if (!previousFrame) return "bind";
  if (snapshot.seeking) return "seek";

  const discontinuity = snapshot.discontinuity;
  const isNewDiscontinuity =
    discontinuity !== null &&
    discontinuity.sequence !== previousFrame.discontinuity?.sequence;
  if (isNewDiscontinuity) {
    switch (discontinuity.reason) {
      case "seek":
        return "seek";
      case "loop":
      case "source-change":
      case "unknown":
        return "reset";
      default: {
        const exhaustiveReason: never = discontinuity.reason;
        void exhaustiveReason;
        return "reset";
      }
    }
  }
  return "playback";
}

function cloneDiscontinuity(
  discontinuity: PlaybackDiscontinuity | null,
): PlaybackDiscontinuity | null {
  if (!discontinuity) return null;
  return Object.freeze({
    sequence: discontinuity.sequence,
    reason: discontinuity.reason,
  });
}

function previousVisualEventState(
  previousFrame: PlaybackFrame | null,
): VisualEventCoordinatorState | null {
  if (!previousFrame) return null;
  return Object.freeze({
    documentId: previousFrame.documentId,
    clocks: Object.freeze({
      playbackPositionMs: previousFrame.playbackPositionMs,
      callbackPlaybackPositionMs: previousFrame.callbackPlaybackPositionMs,
      lineEventPlaybackPositionMs: previousFrame.lineEventPlaybackPositionMs,
      wordPlaybackPositionMs: previousFrame.wordPlaybackPositionMs,
    }),
    requestedActiveLineIds: previousFrame.requestedActiveLineIdsInSourceOrder,
    committedActiveLineIds: previousFrame.eventActiveLineIdsInSourceOrder,
    visualPrimaryLineIds: previousFrame.activeLineIdsInSourceOrder,
    committedScrollLineId: previousFrame.committedScrollLineId,
    visualStyleFocusLineId: previousFrame.focusLineId,
    retentionKind: previousFrame.visualEventRetentionKind,
    gap: Object.freeze({
      inGap: false,
      trailing: false,
      gapStartMs: null,
      gapEndMs: null,
      gapMs: null,
      previousLyricLineId: null,
      nextLyricLineId: null,
    }),
    layoutBusy: false,
    pendingRequestedActiveLineIds: null,
  });
}

function linesForIds(
  context: PlaybackFrameContext,
  lineIds: readonly string[],
) {
  return Object.freeze(
    lineIds
      .map((lineId) => context.lineById.get(lineId))
      .filter((line): line is NonNullable<typeof line> => line != null),
  );
}

/** Purely derives line and word state from one clock snapshot. */
export function createPlaybackFrame(
  context: PlaybackFrameContext,
  input: CreatePlaybackFrameInput,
): PlaybackFrame {
  const { snapshot, positions } = input;
  const suppliedPreviousFrame = input.previousFrame ?? null;
  const documentChanged =
    suppliedPreviousFrame !== null &&
    suppliedPreviousFrame.documentId !== context.document.id;
  const previousFrame = documentChanged ? null : suppliedPreviousFrame;
  const explicitMode = input.mode ?? (documentChanged ? "reset" : undefined);
  const mode = resolveFrameMode(snapshot, previousFrame, explicitMode);
  const playbackPositionMs =
    positions?.playbackPositionMs ?? snapshot.positionMs;
  const lineEventPlaybackPositionMs =
    positions?.lineEventPlaybackPositionMs ?? snapshot.positionMs;
  const callbackPlaybackPositionMs =
    positions?.callbackPlaybackPositionMs ?? snapshot.positionMs;
  const wordPlaybackPositionMs =
    positions?.wordPlaybackPositionMs ?? snapshot.positionMs;
  const requested = selectActiveLines(
    context.timeIndex,
    callbackPlaybackPositionMs,
  );
  const visualEvent = advanceVisualEventCoordinator({
    document: context.document,
    timeIndex: context.timeIndex,
    clocks: {
      playbackPositionMs,
      callbackPlaybackPositionMs,
      lineEventPlaybackPositionMs,
      wordPlaybackPositionMs,
    },
    requestedActiveLineIds: requested.orderedLineIds,
    previous: previousVisualEventState(previousFrame),
    playing: snapshot.playing,
    mode,
    layoutBusy: Boolean(input.layoutBusy),
  });
  const previousLineIds = Object.freeze(
    previousFrame ? [...previousFrame.activeLineIdsInSourceOrder] : [],
  );
  const visualPrimaryLineIds = visualEvent.visualPrimaryLineIds;
  const notifications = diffLineNotifications(
    visualPrimaryLineIds,
    previousLineIds,
  );
  const visualPrimaryLines = linesForIds(context, visualPrimaryLineIds);
  const wordIdsByTrack = createWordIdsByTrack(
    visualPrimaryLines,
    wordPlaybackPositionMs,
  );
  const concurrentPrimaryTail = selectConcurrentPrimaryTailLinesFromIndex(
    concurrentPrimaryTailIndexForContext(context),
    callbackPlaybackPositionMs,
  );
  const nextLine = context.timeIndex.findFirstStartingAfter(
    lineEventPlaybackPositionMs,
  );

  return Object.freeze({
    documentId: context.document.id,
    playbackPositionMs,
    lineEventPlaybackPositionMs,
    callbackPlaybackPositionMs,
    wordPlaybackPositionMs,
    playbackRevision: snapshot.revision,
    discontinuity: cloneDiscontinuity(snapshot.discontinuity),
    activeLineIds: createImmutableSet(visualPrimaryLineIds),
    activeLineIdsInSourceOrder: Object.freeze([...visualPrimaryLineIds]),
    requestedActiveLineIdsInSourceOrder: Object.freeze([
      ...visualEvent.requestedActiveLineIds,
    ]),
    eventActiveLineIdsInSourceOrder: Object.freeze([
      ...visualEvent.committedActiveLineIds,
    ]),
    previousActiveLineIds: createImmutableSet(previousLineIds),
    previousActiveLineIdsInSourceOrder: previousLineIds,
    enteredLineIds: notifications.enteredLineIds,
    exitedLineIds: notifications.exitedLineIds,
    retainedLineIds: notifications.retainedLineIds,
    focusLineId:
      visualEvent.visualStyleFocusLineId ??
      visualEvent.committedScrollLineId ??
      null,
    committedScrollLineId: visualEvent.committedScrollLineId,
    visualEventRetentionKind: visualEvent.retentionKind,
    concurrentPrimaryTailLineIds: concurrentPrimaryTail.lineIdSet,
    concurrentPrimaryTailLineIdsInSourceOrder: concurrentPrimaryTail.lineIds,
    previousConcurrentPrimaryTailLineIdsInSourceOrder: Object.freeze(
      previousFrame
        ? [...previousFrame.concurrentPrimaryTailLineIdsInSourceOrder]
        : [],
    ),
    nextLineId: nextLine?.line.id ?? null,
    foregroundWordIds: wordIdsByTrack.foreground,
    backgroundWordIds: wordIdsByTrack.background,
    wordIdsByTrack,
    mode,
  });
}
