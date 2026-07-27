import type {
  PlaybackFrame,
  PlaybackFrameMode,
} from "../playback/create-playback-frame.js";
import {
  sampleInstrumentalTimeline,
  type InstrumentalTiming,
  type InstrumentalTimingContext,
} from "./timing.js";

export const INSTRUMENTAL_EXIT_EXPAND_DURATION_MS = 750;
export const INSTRUMENTAL_EXIT_COLLAPSE_DURATION_MS = 250;
export const INSTRUMENTAL_EXIT_TOTAL_DURATION_MS =
  INSTRUMENTAL_EXIT_EXPAND_DURATION_MS +
  INSTRUMENTAL_EXIT_COLLAPSE_DURATION_MS;
export const INSTRUMENTAL_SAME_LINE_RETRIGGER_THROTTLE_MS = 4_000;

export type InstrumentalSessionPresence = "absent" | "present" | "exiting";
export type InstrumentalPlaybackState = "playing" | "paused";
export type InstrumentalSessionPhase =
  | "idle"
  | "present"
  | "exit-expand"
  | "exit-collapse";
export type InstrumentalSessionTransition =
  | "none"
  | "entered"
  | "retained"
  | "exit-started"
  | "exit-advanced"
  | "exit-completed"
  | "rebased"
  | "reset";

export interface InstrumentalSessionState {
  readonly documentId: string | null;
  readonly lineId: string | null;
  readonly presence: InstrumentalSessionPresence;
  readonly phase: InstrumentalSessionPhase;
  readonly playbackState: InstrumentalPlaybackState;
  readonly runSequence: number;
  /** Monotonic renderer clock used only for same-line trigger throttling. */
  readonly lastTriggerClockMs: number | null;
  /** Time since this row entered the current renderer session. */
  readonly runElapsedMs: number;
  /** Gap-local playback clock, initialized from the playback position. */
  readonly interludeElapsedMs: number;
  readonly remainingAtEntryMs: number;
  readonly exitElapsedMs: number;
  readonly lastPlaybackPositionMs: number | null;
  readonly lastPlaybackRevision: number | null;
  readonly lastDiscontinuitySequence: number | null;
  /**
   * Sticky: the playback clock has genuinely advanced at least once for this
   * document (a playing 'playback' frame whose position moved forward).
   * Gates the intro gap so a track bound mid-warmup does not flash its
   * pre-roll dots before the audio actually starts.
   */
  readonly playbackHasAdvanced: boolean;
  readonly transition: InstrumentalSessionTransition;
}

export interface InstrumentalSessionInput {
  readonly frame: PlaybackFrame;
  readonly playing: boolean;
  /** Optional renderer clock delta. Playback-position delta is the fallback. */
  readonly deltaMs?: number;
  /** Independent monotonic clock; never derived from lyric playback position. */
  readonly triggerClockMs?: number;
}

function safeElapsed(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, value);
}

function safeAdd(left: number, right: number): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    safeElapsed(left) + safeElapsed(right),
  );
}

function playbackState(playing: boolean): InstrumentalPlaybackState {
  return playing ? "playing" : "paused";
}

function freezeState(
  state: InstrumentalSessionState,
): InstrumentalSessionState {
  return Object.freeze(state);
}

export function createIdleInstrumentalSession(
  documentId: string | null = null,
): InstrumentalSessionState {
  return freezeState({
    documentId,
    lineId: null,
    presence: "absent",
    phase: "idle",
    playbackState: "paused",
    runSequence: 0,
    lastTriggerClockMs: null,
    runElapsedMs: 0,
    interludeElapsedMs: 0,
    remainingAtEntryMs: 0,
    exitElapsedMs: 0,
    lastPlaybackPositionMs: null,
    lastPlaybackRevision: null,
    lastDiscontinuitySequence: null,
    playbackHasAdvanced: false,
    transition: "none",
  });
}

function frameDeltaMs(
  previous: InstrumentalSessionState,
  input: InstrumentalSessionInput,
): number {
  if (!input.playing || input.frame.mode !== "playback") return 0;
  if (input.deltaMs !== undefined) return safeElapsed(input.deltaMs);
  const previousPositionMs = previous.lastPlaybackPositionMs;
  const currentPositionMs = input.frame.playbackPositionMs;
  if (
    previousPositionMs === null ||
    !Number.isFinite(currentPositionMs)
  ) {
    return 0;
  }
  return safeElapsed(currentPositionMs - previousPositionMs);
}

function enteredState(
  previous: InstrumentalSessionState,
  context: InstrumentalTimingContext,
  timing: InstrumentalTiming,
  input: InstrumentalSessionInput,
  transition: "entered" | "rebased",
): InstrumentalSessionState {
  const timeline = sampleInstrumentalTimeline(
    timing,
    input.frame.playbackPositionMs,
  );
  return freezeState({
    documentId: context.documentId,
    lineId: timing.lineId,
    presence: "present",
    phase: "present",
    playbackState: playbackState(input.playing),
    runSequence: Math.min(
      Number.MAX_SAFE_INTEGER,
      previous.runSequence + 1,
    ),
    lastTriggerClockMs: Number.isFinite(input.triggerClockMs)
      ? (input.triggerClockMs as number)
      : null,
    runElapsedMs: 0,
    interludeElapsedMs: timeline.elapsedMs,
    remainingAtEntryMs: timeline.remainingMs,
    exitElapsedMs: 0,
    lastPlaybackPositionMs: Number.isFinite(input.frame.playbackPositionMs)
      ? input.frame.playbackPositionMs
      : null,
    lastPlaybackRevision: input.frame.playbackRevision,
    lastDiscontinuitySequence: input.frame.discontinuity?.sequence ?? null,
    playbackHasAdvanced: previous.playbackHasAdvanced,
    transition,
  });
}

function absentState(
  previous: InstrumentalSessionState,
  documentId: string,
  input: InstrumentalSessionInput,
  transition: "none" | "exit-completed" | "reset",
): InstrumentalSessionState {
  return freezeState({
    documentId,
    lineId: null,
    presence: "absent",
    phase: "idle",
    playbackState: playbackState(input.playing),
    runSequence: previous.runSequence,
    lastTriggerClockMs: previous.lastTriggerClockMs,
    runElapsedMs: 0,
    interludeElapsedMs: 0,
    remainingAtEntryMs: 0,
    exitElapsedMs: 0,
    lastPlaybackPositionMs: Number.isFinite(input.frame.playbackPositionMs)
      ? input.frame.playbackPositionMs
      : null,
    lastPlaybackRevision: input.frame.playbackRevision,
    lastDiscontinuitySequence: input.frame.discontinuity?.sequence ?? null,
    playbackHasAdvanced: previous.playbackHasAdvanced,
    transition,
  });
}

function isDirectRebaseMode(mode: PlaybackFrameMode): boolean {
  return mode !== "playback";
}


function shouldRetainSameLineRun(
  previous: InstrumentalSessionState,
  timing: InstrumentalTiming,
  input: InstrumentalSessionInput,
): boolean {
  const frame = input.frame;
  if (
    previous.presence === "absent" ||
    previous.lineId !== timing.lineId ||
    (frame.mode !== "bind" && frame.mode !== "seek")
  ) {
    return false;
  }
  const previousClockMs = previous.lastTriggerClockMs;
  const currentClockMs = input.triggerClockMs;
  if (
    previousClockMs === null ||
    currentClockMs === undefined ||
    !Number.isFinite(currentClockMs)
  ) {
    return true;
  }
  const elapsedMs = currentClockMs - previousClockMs;
  return (
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs < INSTRUMENTAL_SAME_LINE_RETRIGGER_THROTTLE_MS
  );
}

function retainedRebaseState(
  previous: InstrumentalSessionState,
  context: InstrumentalTimingContext,
  timing: InstrumentalTiming,
  input: InstrumentalSessionInput,
): InstrumentalSessionState {
  const timeline = sampleInstrumentalTimeline(
    timing,
    input.frame.playbackPositionMs,
  );
  return freezeState({
    ...previous,
    documentId: context.documentId,
    presence: "present",
    phase: "present",
    playbackState: playbackState(input.playing),
    interludeElapsedMs: timeline.elapsedMs,
    exitElapsedMs: 0,
    lastPlaybackPositionMs: Number.isFinite(input.frame.playbackPositionMs)
      ? input.frame.playbackPositionMs
      : previous.lastPlaybackPositionMs,
    lastPlaybackRevision: input.frame.playbackRevision,
    lastDiscontinuitySequence: input.frame.discontinuity?.sequence ?? null,
    transition: "retained",
  });
}

function resolveTimelineInstrumentalTiming(
  context: InstrumentalTimingContext,
  positionMs: number,
): { readonly timing: InstrumentalTiming; readonly phase: "present" | "exiting" } | null {
  if (!Number.isFinite(positionMs)) return null;
  for (const timing of context.timings) {
    const exitStartMs = Math.max(
      timing.beginMs,
      timing.endMs - INSTRUMENTAL_EXIT_TOTAL_DURATION_MS,
    );
    if (positionMs >= timing.beginMs && positionMs < exitStartMs) {
      return { timing, phase: "present" };
    }
    if (
      positionMs >= exitStartMs &&
      positionMs < timing.endMs
    ) {
      return { timing, phase: "exiting" };
    }
  }
  return null;
}

/**
 * Advances adapter membership from the authored gap timeline. Visual paint and
 * focus policy must not feed back into this reducer.
 */
export function advanceInstrumentalSession(
  context: InstrumentalTimingContext,
  previous: InstrumentalSessionState | null,
  input: InstrumentalSessionInput,
): InstrumentalSessionState {
  const rawPrior = previous ?? createIdleInstrumentalSession(context.documentId);
  const positionMs = input.frame.playbackPositionMs;
  // Sticky truth: a playing playback frame whose clock moved forward. A new
  // document starts over (contextChanged below resets via idle session).
  const advancedNow =
    input.frame.mode === "playback" &&
    input.playing &&
    input.frame.documentId === context.documentId &&
    rawPrior.documentId === context.documentId &&
    rawPrior.lastPlaybackPositionMs !== null &&
    Number.isFinite(positionMs) &&
    positionMs > rawPrior.lastPlaybackPositionMs;
  const prior: InstrumentalSessionState =
    advancedNow && !rawPrior.playbackHasAdvanced
      ? Object.freeze({ ...rawPrior, playbackHasAdvanced: true })
      : rawPrior;
  const timeline =
    input.frame.documentId === context.documentId
      ? resolveTimelineInstrumentalTiming(context, positionMs)
      : null;
  const activeTiming = timeline?.timing ?? null;
  const timelinePhase = timeline?.phase ?? null;
  const contextChanged =
    prior.documentId !== null && prior.documentId !== context.documentId;
  const directRebase =
    contextChanged ||
    input.frame.documentId !== context.documentId ||
    isDirectRebaseMode(input.frame.mode);
  const deferredPausedEntry =
    activeTiming !== null &&
    (!input.playing ||
      // Intro gap before the clock has ever advanced: a bind at position 0
      // sits inside [0, firstLyric) but the song has not audibly started.
      // Keep the row collapsed until a real playback frame moves the clock;
      // mid-song gaps and post-playback seeks back into the intro enter
      // normally. The second conjunct keeps an already-present row present.
      (activeTiming.isIntro && !prior.playbackHasAdvanced && !advancedNow)) &&
    (prior.documentId !== context.documentId ||
      prior.presence === "absent" ||
      prior.lineId !== activeTiming.lineId);

  if (directRebase) {
    if (input.frame.mode === "recycle") {
      return absentState(prior, context.documentId, input, "reset");
    }
    if (!activeTiming || timelinePhase === null || deferredPausedEntry) {
      return absentState(prior, context.documentId, input, "reset");
    }
    if (timelinePhase === "exiting") {
      const exitStartMs = Math.max(
        activeTiming.beginMs,
        activeTiming.endMs - INSTRUMENTAL_EXIT_TOTAL_DURATION_MS,
      );
      return freezeState({
        documentId: context.documentId,
        lineId: activeTiming.lineId,
        presence: "exiting",
        phase:
          positionMs - exitStartMs < INSTRUMENTAL_EXIT_EXPAND_DURATION_MS
            ? "exit-expand"
            : "exit-collapse",
        playbackState: playbackState(input.playing),
        playbackHasAdvanced: prior.playbackHasAdvanced,
        runSequence: Math.min(
          Number.MAX_SAFE_INTEGER,
          prior.runSequence + 1,
        ),
        lastTriggerClockMs: Number.isFinite(input.triggerClockMs)
          ? (input.triggerClockMs as number)
          : prior.lastTriggerClockMs,
        runElapsedMs: 0,
        interludeElapsedMs: Math.max(
          0,
          Math.min(activeTiming.durationMs, positionMs - activeTiming.beginMs),
        ),
        remainingAtEntryMs: Math.max(0, activeTiming.endMs - positionMs),
        exitElapsedMs: Math.max(0, positionMs - exitStartMs),
        lastPlaybackPositionMs: Number.isFinite(positionMs)
          ? positionMs
          : prior.lastPlaybackPositionMs,
        lastPlaybackRevision: input.frame.playbackRevision,
        lastDiscontinuitySequence:
          input.frame.discontinuity?.sequence ?? null,
        transition: "rebased",
      });
    }
    if (shouldRetainSameLineRun(prior, activeTiming, input)) {
      return retainedRebaseState(prior, context, activeTiming, input);
    }
    return enteredState(
      prior,
      context,
      activeTiming,
      input,
      "rebased",
    );
  }

  if (deferredPausedEntry) {
    return absentState(prior, context.documentId, input, "none");
  }

  if (activeTiming && timelinePhase === "present") {
    if (
      prior.presence !== "present" ||
      prior.lineId !== activeTiming.lineId
    ) {
      return enteredState(
        prior,
        context,
        activeTiming,
        input,
        "entered",
      );
    }

    const deltaMs = frameDeltaMs(prior, input);
    const runElapsedMs = safeAdd(prior.runElapsedMs, deltaMs);
    const timelineElapsedMs = Math.min(
      activeTiming.durationMs,
      Math.max(0, positionMs - activeTiming.beginMs),
    );
    return freezeState({
      ...prior,
      documentId: context.documentId,
      playbackState: playbackState(input.playing),
      presence: "present",
      phase: "present",
      runElapsedMs,
      interludeElapsedMs: timelineElapsedMs,
      exitElapsedMs: 0,
      lastPlaybackPositionMs: Number.isFinite(positionMs)
        ? positionMs
        : prior.lastPlaybackPositionMs,
      lastPlaybackRevision: input.frame.playbackRevision,
      lastDiscontinuitySequence: input.frame.discontinuity?.sequence ?? null,
      transition: "retained",
    });
  }

  if (activeTiming && timelinePhase === "exiting") {
    const exitStartMs = Math.max(
      activeTiming.beginMs,
      activeTiming.endMs - INSTRUMENTAL_EXIT_TOTAL_DURATION_MS,
    );
    const exitElapsedMs = Math.min(
      INSTRUMENTAL_EXIT_TOTAL_DURATION_MS,
      Math.max(0, positionMs - exitStartMs),
    );
    if (exitElapsedMs >= INSTRUMENTAL_EXIT_TOTAL_DURATION_MS) {
      return absentState(prior, context.documentId, input, "exit-completed");
    }
    const continuingSameExit =
      prior.presence === "exiting" && prior.lineId === activeTiming.lineId;
    const startingExit =
      prior.presence === "present" && prior.lineId === activeTiming.lineId;
    return freezeState({
      documentId: context.documentId,
      lineId: activeTiming.lineId,
      presence: "exiting",
      phase:
        exitElapsedMs < INSTRUMENTAL_EXIT_EXPAND_DURATION_MS
          ? "exit-expand"
          : "exit-collapse",
      playbackState: playbackState(input.playing),
      playbackHasAdvanced: prior.playbackHasAdvanced,
      runSequence: prior.runSequence,
      lastTriggerClockMs: prior.lastTriggerClockMs,
      runElapsedMs: continuingSameExit || startingExit ? prior.runElapsedMs : 0,
      interludeElapsedMs: Math.max(
        0,
        Math.min(activeTiming.durationMs, positionMs - activeTiming.beginMs),
      ),
      remainingAtEntryMs:
        continuingSameExit || startingExit ? prior.remainingAtEntryMs : 0,
      exitElapsedMs,
      lastPlaybackPositionMs: Number.isFinite(positionMs)
        ? positionMs
        : prior.lastPlaybackPositionMs,
      lastPlaybackRevision: input.frame.playbackRevision,
      lastDiscontinuitySequence: input.frame.discontinuity?.sequence ?? null,
      transition: startingExit
        ? "exit-started"
        : continuingSameExit
          ? "exit-advanced"
          : "exit-started",
    });
  }

  if (prior.presence === "exiting" && prior.lineId !== null) {
    return absentState(prior, context.documentId, input, "exit-completed");
  }

  return absentState(prior, context.documentId, input, "none");
}
