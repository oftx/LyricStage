import type {
  LyricTimeIndex,
  LyricTimeIndexEntry,
} from "../domain/time-index.js";
import type { LyricDocument, LyricLine } from "../domain/types.js";
import { createImmutableSet } from "./active-lines.js";

/**
 * After a lead line's timed window ends, keep primary white fill (and active
 * scale) while an overlapping partner remains live. Glow/lift settle on wall
 * time and must not restart. Background-only residual after main ended before
 * the partner began is excluded (case 04 x-bg residuals).
 */
export function resolveLineForegroundEndMs(line: LyricLine): number | null {
  if (line.type === "instrumental" || line.type === "credit") return null;
  // TextLyricLine always carries tracks; instrumental already returned.
  const tracks = "tracks" in line ? line.tracks : null;
  if (!tracks) return line.end.valueMs;

  const words = tracks.foreground.words;
  if (words.length === 0) return line.end.valueMs;

  let maxEnd: number | null = null;
  for (const word of words) {
    const endMs = word.end.valueMs;
    if (endMs !== null && Number.isFinite(endMs)) {
      maxEnd = maxEnd === null ? endMs : Math.max(maxEnd, endMs);
    }
  }
  return maxEnd ?? line.end.valueMs;
}

function isPaintEligibleLine(line: LyricLine): boolean {
  return line.type !== "instrumental" && line.type !== "credit";
}

function intervalOf(
  line: LyricLine,
  entry: LyricTimeIndexEntry | null,
): { readonly beginMs: number; readonly endMs: number } | null {
  const beginMs = entry?.beginMs ?? line.begin.valueMs;
  const endMs = entry?.endMs ?? line.end.valueMs;
  if (
    beginMs === null ||
    endMs === null ||
    !Number.isFinite(beginMs) ||
    !Number.isFinite(endMs)
  ) {
    return null;
  }
  return { beginMs, endMs };
}

function intervalsOverlap(
  left: { readonly beginMs: number; readonly endMs: number },
  right: { readonly beginMs: number; readonly endMs: number },
): boolean {
  return left.beginMs < right.endMs && right.beginMs < left.endMs;
}

export interface ConcurrentPrimaryTailSelection {
  readonly lineIds: readonly string[];
  readonly lineIdSet: ReadonlySet<string>;
}

interface ConcurrentPrimaryTailLineFact {
  readonly lineId: string;
  readonly sourceOrder: number;
  readonly interval: {
    readonly beginMs: number;
    readonly endMs: number;
  } | null;
  readonly foregroundEndMs: number | null;
  readonly paintEligible: boolean;
}

/**
 * Stable line facts compiled once when a lyric document is bound. Candidate
 * rows are sorted by end time so each active partner can narrow the tail search
 * to end times inside `(partner.begin, position]` with two binary searches.
 */
export interface ConcurrentPrimaryTailIndex {
  readonly lineFacts: readonly ConcurrentPrimaryTailLineFact[];
  readonly candidatesByEndMs: readonly ConcurrentPrimaryTailLineFact[];
}

const emptySelection: ConcurrentPrimaryTailSelection = Object.freeze({
  lineIds: Object.freeze([]),
  lineIdSet: createImmutableSet([]),
});

/** Compiles stable interval and foreground facts outside the playback loop. */
export function createConcurrentPrimaryTailIndex(
  document: LyricDocument,
  timeIndex: LyricTimeIndex,
): ConcurrentPrimaryTailIndex {
  const lineFacts = Object.freeze(
    document.lines.map((line, sourceOrder) => {
      const entry = timeIndex.getByLineId(line.id);
      return Object.freeze({
        lineId: line.id,
        sourceOrder,
        interval: intervalOf(line, entry),
        foregroundEndMs: resolveLineForegroundEndMs(line),
        paintEligible: isPaintEligibleLine(line),
      });
    }),
  );
  const candidatesByEndMs = Object.freeze(
    lineFacts
      .filter((fact) => fact.paintEligible && fact.interval !== null)
      .sort(
        (left, right) =>
          (left.interval?.endMs ?? 0) - (right.interval?.endMs ?? 0) ||
          left.sourceOrder - right.sourceOrder,
      ),
  );

  return Object.freeze({ lineFacts, candidatesByEndMs });
}

function upperBoundCandidateEnd(
  candidates: readonly ConcurrentPrimaryTailLineFact[],
  positionMs: number,
): number {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const endMs = candidates[middle]?.interval?.endMs;
    if (endMs !== undefined && endMs <= positionMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Selects finished lead rows from stable facts without an overlap graph. */
export function selectConcurrentPrimaryTailLinesFromIndex(
  index: ConcurrentPrimaryTailIndex,
  positionMs: number,
): ConcurrentPrimaryTailSelection {
  if (!Number.isFinite(positionMs)) return emptySelection;

  let selectedSourceOrders: Set<number> | null = null;
  let selectedCandidates: ConcurrentPrimaryTailLineFact[] | null = null;
  const candidateEnd = upperBoundCandidateEnd(
    index.candidatesByEndMs,
    positionMs,
  );
  if (candidateEnd === 0) return emptySelection;

  for (const partner of index.lineFacts) {
    if (!partner.paintEligible || !partner.interval) continue;
    if (
      positionMs < partner.interval.beginMs ||
      positionMs >= partner.interval.endMs
    ) {
      continue;
    }

    const candidateStart = upperBoundCandidateEnd(
      index.candidatesByEndMs,
      partner.interval.beginMs,
    );
    for (
      let indexOffset = candidateStart;
      indexOffset < candidateEnd;
      indexOffset += 1
    ) {
      const candidate = index.candidatesByEndMs[indexOffset];
      if (!candidate?.interval) continue;
      if (candidate.lineId === partner.lineId) continue;
      if (!intervalsOverlap(candidate.interval, partner.interval)) continue;
      // Main finished before partner started -> background residual only.
      if (
        candidate.foregroundEndMs !== null &&
        Number.isFinite(candidate.foregroundEndMs) &&
        candidate.foregroundEndMs <= partner.interval.beginMs
      ) {
        continue;
      }
      if (selectedSourceOrders?.has(candidate.sourceOrder)) continue;
      selectedSourceOrders ??= new Set<number>();
      selectedCandidates ??= [];
      selectedSourceOrders.add(candidate.sourceOrder);
      selectedCandidates.push(candidate);
    }
  }

  if (!selectedCandidates) return emptySelection;
  selectedCandidates.sort(
    (left, right) => left.sourceOrder - right.sourceOrder,
  );
  const lineIds = Object.freeze(
    selectedCandidates.map((candidate) => candidate.lineId),
  );
  return Object.freeze({
    lineIds,
    lineIdSet: createImmutableSet(lineIds),
  });
}

/**
 * Pure selection of finished lead rows that still own primary fill because a
 * concurrent partner is live.
 */
export function selectConcurrentPrimaryTailLines(
  document: LyricDocument,
  timeIndex: LyricTimeIndex,
  positionMs: number,
): ConcurrentPrimaryTailSelection {
  if (!Number.isFinite(positionMs)) return emptySelection;
  const index = createConcurrentPrimaryTailIndex(document, timeIndex);
  return selectConcurrentPrimaryTailLinesFromIndex(index, positionMs);
}

export function isConcurrentPrimaryTailLine(
  selection: ConcurrentPrimaryTailSelection,
  lineId: string,
): boolean {
  return selection.lineIdSet.has(lineId);
}
