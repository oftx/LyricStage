import type { LyricDocument, LyricLine } from "./types.js";

export interface LyricTimeIndexEntry {
  readonly line: LyricLine;
  readonly documentIndex: number;
  readonly beginMs: number;
  /** Effective playback boundary, clamped to a known document duration. */
  readonly endMs: number | null;
  readonly sourceEndMs: number | null;
  readonly endClampedToDocument: boolean;
}

export interface LyricTimeIndex {
  readonly entries: readonly LyricTimeIndexEntry[];
  readonly untimedLines: readonly LyricLine[];
  getByLineId(lineId: string): LyricTimeIndexEntry | null;
  findActiveAt(positionMs: number): readonly LyricTimeIndexEntry[];
  findLastStartingAtOrBefore(positionMs: number): LyricTimeIndexEntry | null;
  findFirstStartingAfter(positionMs: number): LyricTimeIndexEntry | null;
  findStartingInRange(
    startMsInclusive: number,
    endMsExclusive: number,
  ): readonly LyricTimeIndexEntry[];
}

const emptyEntries: readonly LyricTimeIndexEntry[] = Object.freeze([]);

function lowerBound(
  entries: readonly LyricTimeIndexEntry[],
  positionMs: number,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const entry = entries[middle];
    if (entry && entry.beginMs < positionMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(
  entries: readonly LyricTimeIndexEntry[],
  positionMs: number,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const entry = entries[middle];
    if (entry && entry.beginMs <= positionMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function createEntries(document: LyricDocument): {
  readonly timed: readonly LyricTimeIndexEntry[];
  readonly untimed: readonly LyricLine[];
} {
  const timed: LyricTimeIndexEntry[] = [];
  const untimed: LyricLine[] = [];
  const documentEndMs = document.duration.valueMs;

  document.lines.forEach((line, documentIndex) => {
    const beginMs = line.begin.valueMs;
    if (beginMs === null || !Number.isFinite(beginMs)) {
      untimed.push(line);
      return;
    }
    const rawEndMs = line.end.valueMs;
    const sourceEndMs =
      rawEndMs !== null && Number.isFinite(rawEndMs) ? rawEndMs : null;
    const endClampedToDocument =
      sourceEndMs !== null &&
      documentEndMs !== null &&
      sourceEndMs > documentEndMs;
    timed.push(
      Object.freeze({
        line,
        documentIndex,
        beginMs,
        endMs: endClampedToDocument ? documentEndMs : sourceEndMs,
        sourceEndMs,
        endClampedToDocument,
      }),
    );
  });

  timed.sort(
    (left, right) =>
      left.beginMs - right.beginMs || left.documentIndex - right.documentIndex,
  );
  return {
    timed: Object.freeze(timed),
    untimed: Object.freeze(untimed),
  };
}

/** Creates a separately sorted lookup without reordering document.lines. */
export function createLyricTimeIndex(document: LyricDocument): LyricTimeIndex {
  const { timed: entries, untimed: untimedLines } = createEntries(document);
  const entriesByLineId = new Map<string, LyricTimeIndexEntry>();
  const boundedEntries = entries.filter((entry) => entry.endMs !== null);
  const openEntries = entries.filter((entry) => entry.endMs === null);
  const prefixMaximumEnd: number[] = [];
  let maximumEnd = Number.NEGATIVE_INFINITY;

  entries.forEach((entry) => {
    if (!entriesByLineId.has(entry.line.id)) {
      entriesByLineId.set(entry.line.id, entry);
    }
  });
  boundedEntries.forEach((entry, index) => {
    maximumEnd = Math.max(maximumEnd, entry.endMs ?? Number.NEGATIVE_INFINITY);
    prefixMaximumEnd[index] = maximumEnd;
  });
  Object.freeze(prefixMaximumEnd);

  return Object.freeze({
    entries,
    untimedLines,
    getByLineId(lineId: string): LyricTimeIndexEntry | null {
      return entriesByLineId.get(lineId) ?? null;
    },
    findActiveAt(positionMs: number): readonly LyricTimeIndexEntry[] {
      if (!Number.isFinite(positionMs)) return emptyEntries;
      const exclusiveEnd = upperBound(boundedEntries, positionMs);
      const active: LyricTimeIndexEntry[] = openEntries.slice(
        0,
        upperBound(openEntries, positionMs),
      );

      for (let index = exclusiveEnd - 1; index >= 0; index -= 1) {
        const entry = boundedEntries[index];
        if (!entry) continue;
        if (entry.endMs !== null && positionMs < entry.endMs) active.push(entry);
        if (index === 0 || (prefixMaximumEnd[index - 1] ?? 0) <= positionMs) {
          break;
        }
      }

      active.sort(
        (left, right) => left.documentIndex - right.documentIndex,
      );
      return Object.freeze(active);
    },
    findLastStartingAtOrBefore(
      positionMs: number,
    ): LyricTimeIndexEntry | null {
      if (!Number.isFinite(positionMs)) return null;
      return entries[upperBound(entries, positionMs) - 1] ?? null;
    },
    findFirstStartingAfter(positionMs: number): LyricTimeIndexEntry | null {
      if (!Number.isFinite(positionMs)) return null;
      return entries[upperBound(entries, positionMs)] ?? null;
    },
    findStartingInRange(
      startMsInclusive: number,
      endMsExclusive: number,
    ): readonly LyricTimeIndexEntry[] {
      if (
        !Number.isFinite(startMsInclusive) ||
        !Number.isFinite(endMsExclusive) ||
        endMsExclusive <= startMsInclusive
      ) {
        return emptyEntries;
      }
      return Object.freeze(
        entries.slice(
          lowerBound(entries, startMsInclusive),
          lowerBound(entries, endMsExclusive),
        ),
      );
    },
  });
}
