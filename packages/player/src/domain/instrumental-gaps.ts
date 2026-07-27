import { createDerivedLineId, createStableId } from "./ids.js";
import { normalizeLyricDocument } from "./normalize-document.js";
import type {
  InstrumentalLyricLine,
  LyricAgent,
  LyricDocument,
  LyricLine,
  LyricTimestamp,
} from "./types.js";

const DEFAULT_TRIGGER_THRESHOLD_MS = 7_000;

export interface InstrumentalGapOptions {
  readonly startMs?: number;
  readonly triggerThresholdMs?: number;
}

export interface InsertedInstrumentalGap {
  readonly lineId: string;
  readonly beginMs: number;
  readonly endMs: number;
  readonly nextLineId: string;
  readonly nextSourceIndex: number;
}

export interface SuppressedInstrumentalGap {
  readonly beginMs: number;
  readonly endMs: number;
  readonly reason: "trailing-gap-has-no-future-line";
}

export interface InstrumentalGapResult {
  readonly document: LyricDocument;
  readonly inserted: readonly InsertedInstrumentalGap[];
  readonly suppressed: readonly SuppressedInstrumentalGap[];
}

interface TimedSourceLine {
  readonly line: LyricLine;
  readonly beginMs: number;
  readonly endMs: number | null;
}

function derivedTimestamp(valueMs: number): LyricTimestamp {
  return Object.freeze({ valueMs, source: "derived" });
}

function getInstrumentalAgent(document: LyricDocument): LyricAgent {
  const id = createStableId("agent", document.id, "instrumental");
  return Object.freeze({ id, type: "group", alignment: "auto" });
}

function createGapLine(
  document: LyricDocument,
  agentId: string,
  previousLineId: string | null,
  nextLine: LyricLine,
  beginMs: number,
  endMs: number,
): InstrumentalLyricLine {
  return Object.freeze({
    id: createDerivedLineId(
      document.id,
      "instrumental-gap",
      previousLineId,
      nextLine.id,
    ),
    index: -1,
    sourceIndex: null,
    sectionIndex: nextLine.sectionIndex,
    begin: derivedTimestamp(beginMs),
    end: derivedTimestamp(endMs),
    agentId,
    type: "instrumental",
    tracks: null,
  });
}

/**
 * Inserts adapter-only instrumental rows without changing source line order.
 * A trailing gap is diagnostic only because it has no future lyric row.
 */
export function deriveInstrumentalGaps(
  sourceDocument: LyricDocument,
  options: InstrumentalGapOptions = {},
): InstrumentalGapResult {
  const derivedAgentId = createStableId(
    "agent",
    sourceDocument.id,
    "instrumental",
  );
  const document = normalizeLyricDocument({
    ...sourceDocument,
    agents: sourceDocument.agents.filter(
      (agent) => agent.id !== derivedAgentId,
    ),
    lines: sourceDocument.lines.filter(
      (line) => line.type !== "instrumental",
    ),
  });
  const startMs = Number.isFinite(options.startMs) ? options.startMs ?? 0 : 0;
  const requestedThreshold = options.triggerThresholdMs;
  const triggerThresholdMs =
    requestedThreshold !== undefined &&
    Number.isFinite(requestedThreshold) &&
    requestedThreshold >= 0
      ? requestedThreshold
      : DEFAULT_TRIGGER_THRESHOLD_MS;
  const instrumentalAgent = getInstrumentalAgent(document);
  const gapsByNextLineId = new Map<string, InstrumentalLyricLine[]>();
  const inserted: InsertedInstrumentalGap[] = [];
  const documentEndMs = document.duration.valueMs;
  const timedLines: TimedSourceLine[] = document.lines
    .filter(
      (line) =>
        line.sourceIndex !== null &&
        line.begin.valueMs !== null &&
        (documentEndMs === null || line.begin.valueMs < documentEndMs),
    )
    .map((line) => {
      const beginMs = line.begin.valueMs as number;
      const rawEndMs = line.end.valueMs;
      return {
        line,
        beginMs,
        endMs:
          rawEndMs === null
            ? null
            : Math.max(
                beginMs,
                documentEndMs === null
                  ? rawEndMs
                  : Math.min(rawEndMs, documentEndMs),
              ),
      };
    })
    .sort(
      (left, right) =>
        left.beginMs - right.beginMs || left.line.index - right.line.index,
    );
  let coverageEndMs: number | null = startMs;
  let coverageOwnerLineId: string | null = null;

  for (const entry of timedLines) {
    if (
      coverageEndMs !== null &&
      entry.beginMs > coverageEndMs &&
      entry.beginMs - coverageEndMs >= triggerThresholdMs
    ) {
      const gap = createGapLine(
        document,
        instrumentalAgent.id,
        coverageOwnerLineId,
        entry.line,
        coverageEndMs,
        entry.beginMs,
      );
      const anchoredGaps = gapsByNextLineId.get(entry.line.id) ?? [];
      anchoredGaps.push(gap);
      gapsByNextLineId.set(entry.line.id, anchoredGaps);
      inserted.push(
        Object.freeze({
          lineId: gap.id,
          beginMs: coverageEndMs,
          endMs: entry.beginMs,
          nextLineId: entry.line.id,
          nextSourceIndex: entry.line.sourceIndex as number,
        }),
      );
    }

    if (coverageEndMs === null) continue;
    if (entry.endMs === null) {
      coverageEndMs = null;
      coverageOwnerLineId = entry.line.id;
    } else if (entry.endMs >= coverageEndMs) {
      coverageEndMs = entry.endMs;
      coverageOwnerLineId = entry.line.id;
    }
  }

  const suppressed: SuppressedInstrumentalGap[] = [];
  const durationMs = document.duration.valueMs;
  if (
    coverageEndMs !== null &&
    durationMs !== null &&
    durationMs > coverageEndMs &&
    durationMs - coverageEndMs >= triggerThresholdMs
  ) {
    suppressed.push(
      Object.freeze({
        beginMs: coverageEndMs,
        endMs: durationMs,
        reason: "trailing-gap-has-no-future-line",
      }),
    );
  }

  const lines: LyricLine[] = [];
  for (const line of document.lines) {
    lines.push(...(gapsByNextLineId.get(line.id) ?? []), line);
  }
  const indexedLines = Object.freeze(
    lines.map((line, index) => Object.freeze({ ...line, index }) as LyricLine),
  );
  const indexByLineId = new Map(
    indexedLines.map((line) => [line.id, line.index]),
  );
  const hasDerivedAgent = inserted.length > 0;
  const sourceAgents = document.agents.filter(
    (agent) => agent.id !== instrumentalAgent.id,
  );
  const nextDocument = Object.freeze({
    ...document,
    agents: hasDerivedAgent
      ? Object.freeze([...sourceAgents, instrumentalAgent])
      : Object.freeze(sourceAgents),
    lines: indexedLines,
    source: Object.freeze({
      ...document.source,
      nonMonotonicLineOrderSamples: Object.freeze(
        document.source.nonMonotonicLineOrderSamples.map((sample) =>
          Object.freeze({
            ...sample,
            previousIndex:
              indexByLineId.get(sample.previousLineId) ?? sample.previousIndex,
            currentIndex:
              indexByLineId.get(sample.currentLineId) ?? sample.currentIndex,
          }),
        ),
      ),
    }),
  });

  return Object.freeze({
    document: nextDocument,
    inserted: Object.freeze(inserted),
    suppressed: Object.freeze(suppressed),
  });
}
