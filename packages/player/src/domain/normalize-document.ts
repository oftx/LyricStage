import { createLyricLanguage } from "./language.js";
import type {
  LyricAgent,
  LyricDocument,
  LyricLanguage,
  LyricLine,
  LyricText,
  LyricTimestamp,
  LyricTrack,
  LyricTracks,
  LyricWord,
  NonMonotonicLineOrderSample,
} from "./types.js";

const unknownTimestamp: LyricTimestamp = Object.freeze({
  valueMs: null,
  source: "unknown",
});

function cloneTimestamp(timestamp: LyricTimestamp): LyricTimestamp {
  if (timestamp.valueMs === null || !Number.isFinite(timestamp.valueMs)) {
    return unknownTimestamp;
  }
  return Object.freeze({ valueMs: timestamp.valueMs, source: timestamp.source });
}

function derivedTimestamp(valueMs: number): LyricTimestamp {
  return Object.freeze({ valueMs, source: "derived" });
}

function inferredTimestamp(
  valueMs: number,
  source: "next-line-inferred" | "document-duration-inferred",
): LyricTimestamp {
  return Object.freeze({ valueMs, source });
}

function cloneLanguage(language: LyricLanguage): LyricLanguage {
  return createLyricLanguage({
    declared: language.declared,
    inferred: language.inferred,
    fallback: language.effective,
  });
}

function cloneWord(word: LyricWord): LyricWord {
  const joinGroup = word.joinGroup
    ? Object.freeze({
        id: word.joinGroup.id,
        index: word.joinGroup.index,
        count: word.joinGroup.count,
      })
    : undefined;

  return Object.freeze({
    id: word.id,
    text: word.text,
    begin: cloneTimestamp(word.begin),
    end: cloneTimestamp(word.end),
    spaceBefore: word.spaceBefore,
    ...(joinGroup ? { joinGroup } : {}),
  });
}

function cloneTrack(track: LyricTrack): LyricTrack {
  return Object.freeze({
    text: track.text,
    language: cloneLanguage(track.language),
    words: Object.freeze(track.words.map(cloneWord)),
  });
}

function cloneTracks(tracks: LyricTracks): LyricTracks {
  return Object.freeze({
    foreground: cloneTrack(tracks.foreground),
    ...(tracks.foregroundPronunciation
      ? { foregroundPronunciation: cloneTrack(tracks.foregroundPronunciation) }
      : {}),
    ...(tracks.background ? { background: cloneTrack(tracks.background) } : {}),
    ...(tracks.backgroundPronunciation
      ? { backgroundPronunciation: cloneTrack(tracks.backgroundPronunciation) }
      : {}),
  });
}

function cloneText(text: LyricText): LyricText {
  return Object.freeze({
    text: text.text,
    language: cloneLanguage(text.language),
  });
}

function cloneAgent(agent: LyricAgent): LyricAgent {
  return Object.freeze({
    id: agent.id,
    type: agent.type,
    alignment: agent.alignment,
  });
}

function getTracks(line: LyricLine): readonly LyricTrack[] {
  if (line.tracks === null) return [];
  const tracks: LyricTrack[] = [line.tracks.foreground];
  if (line.tracks.foregroundPronunciation) {
    tracks.push(line.tracks.foregroundPronunciation);
  }
  if (line.tracks.background) tracks.push(line.tracks.background);
  if (line.tracks.backgroundPronunciation) {
    tracks.push(line.tracks.backgroundPronunciation);
  }
  return tracks;
}

function deriveWordBoundary(
  line: LyricLine,
  boundary: "begin" | "end",
): number | null {
  let boundaryMs: number | null = null;
  for (const track of getTracks(line)) {
    for (const word of track.words) {
      const valueMs = word[boundary].valueMs;
      if (valueMs === null || !Number.isFinite(valueMs)) continue;
      if (boundaryMs === null) {
        boundaryMs = valueMs;
      } else if (boundary === "begin") {
        boundaryMs = Math.min(boundaryMs, valueMs);
      } else {
        boundaryMs = Math.max(boundaryMs, valueMs);
      }
    }
  }
  return boundaryMs;
}

interface LineDraft {
  readonly original: LyricLine;
  readonly index: number;
  begin: LyricTimestamp;
  end: LyricTimestamp;
}

function createLineDraft(line: LyricLine, index: number): LineDraft {
  let begin = cloneTimestamp(line.begin);
  let end = cloneTimestamp(line.end);

  if (begin.valueMs === null) {
    const wordBeginMs = deriveWordBoundary(line, "begin");
    if (wordBeginMs !== null) begin = derivedTimestamp(wordBeginMs);
  }
  if (end.valueMs === null) {
    const wordEndMs = deriveWordBoundary(line, "end");
    if (wordEndMs !== null) end = derivedTimestamp(wordEndMs);
  }

  return { original: line, index, begin, end };
}

function inferOpenLineEnds(
  drafts: readonly LineDraft[],
  documentDuration: LyricTimestamp,
): void {
  const sourceBegins = [
    ...new Set(
      drafts
        .filter((draft) => draft.original.sourceIndex !== null)
        .map((draft) => draft.begin.valueMs)
        .filter((value): value is number => value !== null),
    ),
  ].sort((left, right) => left - right);

  for (const draft of drafts) {
    if (!draft || draft.end.valueMs !== null || draft.begin.valueMs === null) {
      continue;
    }

    let low = 0;
    let high = sourceBegins.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const candidate = sourceBegins[middle];
      if (candidate !== undefined && candidate <= draft.begin.valueMs) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const nextBeginMs = sourceBegins[low] ?? null;

    if (nextBeginMs !== null) {
      draft.end = inferredTimestamp(nextBeginMs, "next-line-inferred");
    } else if (
      documentDuration.valueMs !== null &&
      documentDuration.valueMs > draft.begin.valueMs
    ) {
      draft.end = inferredTimestamp(
        documentDuration.valueMs,
        "document-duration-inferred",
      );
    }
  }
}

function deriveDocumentDuration(
  duration: LyricTimestamp,
  drafts: readonly LineDraft[],
): LyricTimestamp {
  const cloned = cloneTimestamp(duration);
  if (cloned.valueMs !== null) return cloned;

  const timedDrafts = drafts.filter((draft) => draft.begin.valueMs !== null);
  if (
    timedDrafts.length === 0 ||
    timedDrafts.some((draft) => draft.end.valueMs === null)
  ) {
    return unknownTimestamp;
  }

  let maximumEndMs = Number.NEGATIVE_INFINITY;
  for (const draft of timedDrafts) {
    const endMs = draft.end.valueMs;
    if (endMs !== null) maximumEndMs = Math.max(maximumEndMs, endMs);
  }
  return Number.isFinite(maximumEndMs)
    ? derivedTimestamp(maximumEndMs)
    : unknownTimestamp;
}

function freezeLine(draft: LineDraft): LyricLine {
  const line = draft.original;
  const base = {
    id: line.id,
    index: draft.index,
    sourceIndex: line.sourceIndex,
    sectionIndex: line.sectionIndex,
    begin: draft.begin,
    end: draft.end,
    agentId: line.agentId,
  };

  if (line.type === "instrumental") {
    return Object.freeze({
      ...base,
      sourceIndex: null,
      type: "instrumental",
      tracks: null,
    });
  }

  return Object.freeze({
    ...base,
    type: line.type,
    tracks: cloneTracks(line.tracks),
    ...(line.translation ? { translation: cloneText(line.translation) } : {}),
    ...(line.backgroundTranslation
      ? { backgroundTranslation: cloneText(line.backgroundTranslation) }
      : {}),
  });
}

function inspectLineOrder(
  lines: readonly LyricLine[],
): readonly NonMonotonicLineOrderSample[] {
  const samples: NonMonotonicLineOrderSample[] = [];
  let previous: LyricLine | null = null;

  for (const line of lines) {
    if (line.sourceIndex === null || line.begin.valueMs === null) continue;
    const previousBeginMs = previous?.begin.valueMs ?? null;
    if (
      previous !== null &&
      previousBeginMs !== null &&
      previousBeginMs > line.begin.valueMs
    ) {
      samples.push(
        Object.freeze({
          previousLineId: previous.id,
          previousIndex: previous.index,
          previousBeginMs,
          currentLineId: line.id,
          currentIndex: line.index,
          currentBeginMs: line.begin.valueMs,
        }),
      );
    }
    previous = line;
  }
  return Object.freeze(samples);
}

/**
 * Produces an immutable canonical document without changing source-vector order.
 * Instrumental gap insertion remains a separate transformation.
 */
export function normalizeLyricDocument(document: LyricDocument): LyricDocument {
  const drafts = document.lines.map(createLineDraft);
  let duration = cloneTimestamp(document.duration);

  inferOpenLineEnds(drafts, duration);
  duration = deriveDocumentDuration(duration, drafts);
  if (duration.valueMs !== null) inferOpenLineEnds(drafts, duration);

  const lines = Object.freeze(drafts.map(freezeLine));
  const nonMonotonicLineOrderSamples = inspectLineOrder(lines);
  const sourceName = document.source.name;

  return Object.freeze({
    id: document.id,
    duration,
    language: cloneLanguage(document.language),
    agents: Object.freeze(document.agents.map(cloneAgent)),
    lines,
    source: Object.freeze({
      format: document.source.format,
      ...(sourceName === undefined ? {} : { name: sourceName }),
      adapterOrderPolicy: "preserve-source-vector",
      lineBeginOrderMonotonic: nonMonotonicLineOrderSamples.length === 0,
      nonMonotonicLineOrderSamples,
    }),
  });
}
