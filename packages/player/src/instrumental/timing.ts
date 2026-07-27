import type {
  InstrumentalLyricLine,
  LyricDocument,
  LyricLine,
} from "../domain/types.js";

export const INSTRUMENTAL_MINIMUM_VISIBLE_DURATION_MS = 7_000;
export const INSTRUMENTAL_END_BUFFER_MS = 800;

export type InstrumentalTimingIssueReason =
  | "invalid-interval"
  | "below-visible-threshold"
  | "missing-future-line";

export interface InstrumentalTimingIssue {
  readonly lineId: string;
  readonly reason: InstrumentalTimingIssueReason;
}

export interface InstrumentalTiming {
  readonly line: InstrumentalLyricLine;
  readonly lineId: string;
  readonly documentIndex: number;
  /** Leading (intro) gap — no lyric line precedes it in the document. */
  readonly isIntro: boolean;
  readonly beginMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  /** The tint clock ends before row removal so its last dot can finish on exit. */
  readonly internalDurationMs: number;
  readonly nextLineId: string;
  readonly nextLineIndex: number;
}

export interface InstrumentalTimingOptions {
  readonly minimumVisibleDurationMs?: number;
}

export interface InstrumentalTimingContext {
  readonly documentId: string;
  readonly timings: readonly InstrumentalTiming[];
  readonly issues: readonly InstrumentalTimingIssue[];
  getByLineId(lineId: string): InstrumentalTiming | null;
}

export type InstrumentalTimelinePhase =
  | "invalid-position"
  | "future"
  | "active"
  | "complete";

export interface InstrumentalTimelineSample {
  readonly phase: InstrumentalTimelinePhase;
  readonly positionMs: number | null;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly progress: number;
  readonly internalElapsedMs: number;
  readonly internalProgress: number;
}

function finiteTimestamp(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function resolveMinimumVisibleDurationMs(
  options: InstrumentalTimingOptions,
): number {
  const requested = options.minimumVisibleDurationMs;
  return requested !== undefined &&
    Number.isFinite(requested) &&
    requested >= 0
    ? requested
    : INSTRUMENTAL_MINIMUM_VISIBLE_DURATION_MS;
}

function findNextTextLine(
  lines: readonly LyricLine[],
  instrumentalIndex: number,
  endMs: number,
): LyricLine | null {
  for (let index = instrumentalIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.type === "instrumental") continue;
    const beginMs = line.begin.valueMs;
    return finiteTimestamp(beginMs) && beginMs >= endMs ? line : null;
  }
  return null;
}

/**
 * Compiles adapter-derived instrumental rows without changing document order.
 * A row without a future lyric anchor is deliberately excluded.
 */
export function createInstrumentalTimingContext(
  document: LyricDocument,
  options: InstrumentalTimingOptions = {},
): InstrumentalTimingContext {
  const minimumVisibleDurationMs = resolveMinimumVisibleDurationMs(options);
  const timings: InstrumentalTiming[] = [];
  const issues: InstrumentalTimingIssue[] = [];
  const byLineId = new Map<string, InstrumentalTiming>();

  let sawLyricLine = false;
  document.lines.forEach((line, documentIndex) => {
    if (line.type !== "instrumental") {
      if (line.type !== "credit") sawLyricLine = true;
      return;
    }
    const beginMs = line.begin.valueMs;
    const endMs = line.end.valueMs;
    if (
      !finiteTimestamp(beginMs) ||
      !finiteTimestamp(endMs) ||
      endMs <= beginMs
    ) {
      issues.push(Object.freeze({ lineId: line.id, reason: "invalid-interval" }));
      return;
    }

    const durationMs = endMs - beginMs;
    if (durationMs < minimumVisibleDurationMs) {
      issues.push(
        Object.freeze({
          lineId: line.id,
          reason: "below-visible-threshold",
        }),
      );
      return;
    }

    const nextLine = findNextTextLine(document.lines, documentIndex, endMs);
    if (!nextLine) {
      issues.push(
        Object.freeze({ lineId: line.id, reason: "missing-future-line" }),
      );
      return;
    }

    const timing = Object.freeze({
      line,
      lineId: line.id,
      documentIndex,
      isIntro: !sawLyricLine,
      beginMs,
      endMs,
      durationMs,
      internalDurationMs: Math.max(
        0,
        durationMs - INSTRUMENTAL_END_BUFFER_MS,
      ),
      nextLineId: nextLine.id,
      nextLineIndex: nextLine.index,
    });
    timings.push(timing);
    if (!byLineId.has(line.id)) byLineId.set(line.id, timing);
  });

  const frozenTimings = Object.freeze(timings);
  const frozenIssues = Object.freeze(issues);
  return Object.freeze({
    documentId: document.id,
    timings: frozenTimings,
    issues: frozenIssues,
    getByLineId(lineId: string): InstrumentalTiming | null {
      return byLineId.get(lineId) ?? null;
    },
  });
}

/** Returns the first active instrumental in canonical document order. */
export function findActiveInstrumentalTiming(
  context: InstrumentalTimingContext,
  activeLineIdsInSourceOrder: readonly string[],
): InstrumentalTiming | null {
  for (const lineId of activeLineIdsInSourceOrder) {
    const timing = context.getByLineId(lineId);
    if (timing) return timing;
  }
  return null;
}

/** Samples the half-open gap interval and always returns finite progress. */
export function sampleInstrumentalTimeline(
  timing: InstrumentalTiming,
  positionMs: number,
): InstrumentalTimelineSample {
  if (!Number.isFinite(positionMs)) {
    return Object.freeze({
      phase: "invalid-position",
      positionMs: null,
      elapsedMs: 0,
      remainingMs: timing.durationMs,
      progress: 0,
      internalElapsedMs: 0,
      internalProgress: 0,
    });
  }

  const elapsedMs = clamp(
    positionMs - timing.beginMs,
    0,
    timing.durationMs,
  );
  const remainingMs = Math.max(0, timing.durationMs - elapsedMs);
  const internalElapsedMs = Math.min(elapsedMs, timing.internalDurationMs);
  const internalProgress =
    timing.internalDurationMs > 0
      ? clamp(internalElapsedMs / timing.internalDurationMs, 0, 1)
      : positionMs >= timing.endMs
        ? 1
        : 0;
  const phase: InstrumentalTimelinePhase =
    positionMs < timing.beginMs
      ? "future"
      : positionMs < timing.endMs
        ? "active"
        : "complete";

  return Object.freeze({
    phase,
    positionMs,
    elapsedMs,
    remainingMs,
    progress: clamp(elapsedMs / timing.durationMs, 0, 1),
    internalElapsedMs,
    internalProgress,
  });
}
