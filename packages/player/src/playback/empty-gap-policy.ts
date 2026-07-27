import type { LyricDocument, LyricLine } from "../domain/types.js";
import type { LyricTimeIndex } from "../domain/time-index.js";

/** Empty active spans shorter than this retain the prior lyric event vector. */
export const SHORT_EMPTY_ACTIVE_GAP_MS = 7_000;

/**
 * After the final authored lyric ends, primary visual style releases this long
 * after the gap starts even when the trailing silence is under 7000ms.
 */
export const TRAILING_VISUAL_PRIMARY_GRACE_MS = 80;

export interface EmptyActiveGapState {
  readonly inGap: boolean;
  readonly trailing: boolean;
  readonly gapStartMs: number | null;
  readonly gapEndMs: number | null;
  readonly gapMs: number | null;
  readonly previousLyricLineId: string | null;
  readonly nextLyricLineId: string | null;
}

function isLyricLine(line: LyricLine): boolean {
  return line.type !== "instrumental" && line.type !== "credit";
}

function lineStartMs(line: LyricLine): number | null {
  return line.begin.valueMs;
}

function lineEndMs(
  line: LyricLine,
  documentEndMs: number | null,
): number | null {
  const raw = line.end.valueMs;
  if (raw === null || !Number.isFinite(raw)) return null;
  if (documentEndMs !== null && raw > documentEndMs) return documentEndMs;
  return raw;
}

function documentDurationMs(document: LyricDocument): number | null {
  const value = document.duration?.valueMs;
  return Number.isFinite(value) ? (value as number) : null;
}

/**
 * Describes the empty-active interval surrounding `timeMs` using authored lyric
 * boundaries only. Instrumental/credit rows never open or close the gate.
 */
export function resolveEmptyActiveGapState(
  document: LyricDocument,
  timeIndex: LyricTimeIndex,
  timeMs: number,
): EmptyActiveGapState {
  const lyricLines = document.lines.filter(isLyricLine);
  const documentEndMs = documentDurationMs(document);
  let previous: LyricLine | null = null;
  let previousEnd = Number.NEGATIVE_INFINITY;
  let next: LyricLine | null = null;
  let nextStart = Number.POSITIVE_INFINITY;

  for (const line of lyricLines) {
    const start = lineStartMs(line);
    const end = lineEndMs(line, documentEndMs);
    if (end !== null && end <= timeMs && end >= previousEnd) {
      previous = line;
      previousEnd = end;
    }
    if (start !== null && start > timeMs && start < nextStart) {
      next = line;
      nextStart = start;
    }
  }

  // Prefer time-index future lookup when the document has timed lyrics.
  const indexedNext = timeIndex.findFirstStartingAfter(timeMs);
  if (indexedNext && isLyricLine(indexedNext.line)) {
    const start = lineStartMs(indexedNext.line);
    if (start !== null && start > timeMs && start <= nextStart) {
      next = indexedNext.line;
      nextStart = start;
    }
  }

  const hasPrevious = previous !== null && Number.isFinite(previousEnd);
  const hasNext = next !== null && Number.isFinite(nextStart);
  if (!hasPrevious) {
    return Object.freeze({
      inGap: false,
      trailing: !hasNext,
      gapStartMs: null,
      gapEndMs: hasNext ? nextStart : documentDurationMs(document),
      gapMs: null,
      previousLyricLineId: null,
      nextLyricLineId: next?.id ?? null,
    });
  }

  const gapStartMs = previousEnd;
  const gapEndMs = hasNext ? nextStart : documentEndMs;
  // Mid-song gaps are half-open until the next lyric begin. Trailing silence after
  // the last authored lyric remains a gap at and beyond the document duration so
  // visual-release grace and dock retention remain observable.
  const inGap =
    timeMs >= gapStartMs &&
    (hasNext
      ? gapEndMs !== null && timeMs < gapEndMs
      : true);
  const gapMs =
    gapEndMs === null
      ? hasNext
        ? null
        : Number.POSITIVE_INFINITY
      : Math.max(0, gapEndMs - gapStartMs);

  return Object.freeze({
    inGap,
    trailing: !hasNext,
    gapStartMs,
    gapEndMs,
    gapMs,
    previousLyricLineId: previous?.id ?? null,
    nextLyricLineId: next?.id ?? null,
  });
}

export function isShortEmptyActiveRetentionGap(
  gap: EmptyActiveGapState,
): boolean {
  return (
    gap.inGap &&
    Number.isFinite(gap.gapMs) &&
    (gap.gapMs as number) < SHORT_EMPTY_ACTIVE_GAP_MS
  );
}

export function shouldReleaseTrailingVisualPrimary(
  gap: EmptyActiveGapState,
  timeMs: number,
  playing: boolean,
  documentDuration: number | null,
): boolean {
  if (!gap.trailing || !gap.inGap || gap.gapStartMs === null) return false;
  if (
    timeMs >=
    gap.gapStartMs + Math.max(0, TRAILING_VISUAL_PRIMARY_GRACE_MS)
  ) {
    return true;
  }
  if (!playing && documentDuration !== null && timeMs >= documentDuration) {
    return true;
  }
  return false;
}
