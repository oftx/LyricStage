import type { LyricDocument, LyricTimestamp, TextLyricLine } from "../domain/types.js";
import { inferLyricLanguage } from "../domain/language.js";
import {
  createDefaultAgentId,
  createDocumentId,
  createLineId,
  describeSourceOrder,
  parseFailure,
  readMediaDuration,
  resolveLanguage,
} from "./internal.js";
import {
  knownTimestamp,
  parseLrcTimestampMs,
  unknownTimestamp,
} from "./time.js";
import type {
  LyricsParseInput,
  LyricsParseResult,
  LyricsParser,
  ParseDiagnostic,
} from "./types.js";

const METADATA_KEYS = new Set([
  "al",
  "ar",
  "au",
  "by",
  "lang",
  "language",
  "length",
  "offset",
  "re",
  "ti",
  "ve",
]);

interface LrcMetadata {
  declaredLanguage: string | null;
  offsetMs: number;
  offsetTagCount: number;
}

interface LrcSourceLine {
  readonly sourceIndex: number;
  readonly sectionIndex: number;
  readonly text: string;
  readonly beginValuesMs: readonly number[];
}

interface ScannedLrc {
  readonly sourceLines: readonly LrcSourceLine[];
  readonly metadata: LrcMetadata;
  readonly timestampCount: number;
  readonly untimedLineCount: number;
}

function isTimestampShaped(value: string): boolean {
  return /^\d+:\d{1,2}(?:[.:]\d+)?$/.test(value.trim());
}

function isMetadataTag(tag: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(tag);
  return METADATA_KEYS.has(match?.[1]?.toLowerCase() ?? "");
}

function parseMetadataTag(
  tag: string,
  sourceIndex: number,
  metadata: LrcMetadata,
  diagnostics: ParseDiagnostic[],
): boolean {
  const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(tag);
  if (!match) return false;

  const key = match[1]?.toLowerCase();
  const value = match[2] ?? "";
  if (!key || !METADATA_KEYS.has(key)) return false;

  if (key === "offset") {
    if (!/^[+-]?\d+$/.test(value.trim())) {
      diagnostics.push({
        severity: "warning",
        code: "lrc.invalid-offset",
        message: "The LRC offset tag must contain an integer millisecond value.",
        sourceIndex,
      });
      return true;
    }

    const offsetMs = Number(value.trim());
    if (!Number.isSafeInteger(offsetMs)) {
      diagnostics.push({
        severity: "warning",
        code: "lrc.invalid-offset",
        message: "The LRC offset tag is outside the supported integer range.",
        sourceIndex,
      });
      return true;
    }

    metadata.offsetMs = offsetMs;
    metadata.offsetTagCount += 1;
  } else if (key === "lang" || key === "language") {
    metadata.declaredLanguage = value.trim() || null;
  }

  return true;
}

function scanLrc(
  text: string,
  diagnostics: ParseDiagnostic[],
): ScannedLrc {
  const physicalLines = text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  const metadata: LrcMetadata = {
    declaredLanguage: null,
    offsetMs: 0,
    offsetTagCount: 0,
  };
  const sourceLines: LrcSourceLine[] = [];
  let sectionIndex = 0;
  let timestampCount = 0;
  let untimedLineCount = 0;

  for (let sourceIndex = 0; sourceIndex < physicalLines.length; sourceIndex += 1) {
    const physicalLine = physicalLines[sourceIndex];
    if (physicalLine === undefined || physicalLine.trim().length === 0) {
      // Mid-document blanks become empty static rows (full poem line height).
      // Leading blanks are skipped.
      if (sourceLines.length > 0) {
        sectionIndex += 1;
        untimedLineCount += 1;
        sourceLines.push({
          sourceIndex,
          sectionIndex,
          text: "",
          beginValuesMs: [],
        });
      }
      continue;
    }

    let cursor = physicalLine.match(/^\s*/)?.[0].length ?? 0;
    const beginValuesMs: number[] = [];
    let consumedMetadata = false;

    while (physicalLine[cursor] === "[") {
      const closeIndex = physicalLine.indexOf("]", cursor + 1);
      if (closeIndex < 0) break;

      const tag = physicalLine.slice(cursor + 1, closeIndex);
      const timestampMs = parseLrcTimestampMs(tag);
      if (timestampMs !== null) {
        beginValuesMs.push(timestampMs);
        timestampCount += 1;
        cursor = closeIndex + 1;
        continue;
      }

      if (isTimestampShaped(tag)) {
        diagnostics.push({
          severity: "warning",
          code: "lrc.invalid-timestamp",
          message: "An LRC timestamp tag is malformed or outside the supported range.",
          sourceIndex,
        });
        break;
      }

      if (
        parseMetadataTag(tag, sourceIndex, metadata, diagnostics)
      ) {
        consumedMetadata = true;
        cursor = closeIndex + 1;
        continue;
      }
      break;
    }

    const remainingText = physicalLine.slice(cursor);
    if (
      beginValuesMs.length === 0 &&
      consumedMetadata &&
      remainingText.trim().length === 0
    ) {
      continue;
    }

    if (beginValuesMs.length === 0) untimedLineCount += 1;
    sourceLines.push({
      sourceIndex,
      sectionIndex,
      text: cursor === (physicalLine.match(/^\s*/)?.[0].length ?? 0)
        ? physicalLine
        : remainingText,
      beginValuesMs,
    });
  }

  return {
    sourceLines,
    metadata,
    timestampCount,
    untimedLineCount,
  };
}

function adjustedTimestamp(
  timestampMs: number,
  offsetMs: number,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
): number | null {
  const adjusted = timestampMs + offsetMs;
  if (!Number.isSafeInteger(adjusted)) {
    diagnostics.push({
      severity: "warning",
      code: "lrc.timestamp-out-of-range",
      message: "An offset LRC timestamp is outside the supported integer range.",
      sourceIndex,
    });
    return null;
  }
  return adjusted;
}

function nextTimedBoundary(
  beginMs: number,
  sortedUniqueBegins: readonly number[],
): number | null {
  let low = 0;
  let high = sortedUniqueBegins.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = sortedUniqueBegins[middle];
    if (value === undefined || value <= beginMs) low = middle + 1;
    else high = middle;
  }
  return sortedUniqueBegins[low] ?? null;
}

function lineEnd(
  beginMs: number,
  sortedUniqueBegins: readonly number[],
  mediaDurationMs: number | null,
): LyricTimestamp {
  const nextBeginMs = nextTimedBoundary(beginMs, sortedUniqueBegins);
  if (nextBeginMs !== null) {
    return knownTimestamp(nextBeginMs, "next-line-inferred");
  }
  if (mediaDurationMs !== null && mediaDurationMs >= beginMs) {
    return knownTimestamp(mediaDurationMs, "media-duration-inferred");
  }
  return unknownTimestamp();
}

function parseLrcInternal(input: LyricsParseInput): LyricsParseResult {
  if (typeof input.text !== "string") {
    return parseFailure(
      "lrc",
      "probable",
      "lrc.invalid-input",
      "LRC input must be a string.",
    );
  }

  const diagnostics: ParseDiagnostic[] = [];
  const mediaDurationMs = readMediaDuration(input, diagnostics);
  const scanned = scanLrc(input.text, diagnostics);
  if (scanned.timestampCount === 0) {
    diagnostics.push({
      severity: "error",
      code: "lrc.no-timestamps",
      message: "LRC input contains no valid timestamp tags.",
    });
    return parseFailure(
      "lrc",
      "probable",
      "lrc.no-timestamps",
      "LRC input contains no valid timestamp tags.",
      diagnostics,
    );
  }

  if (scanned.metadata.offsetTagCount > 1) {
    diagnostics.push({
      severity: "info",
      code: "lrc.multiple-offset-tags",
      message: "Multiple LRC offset tags were found; the last valid value was applied.",
    });
  }

  const adjustedBegins: number[] = [];
  for (const sourceLine of scanned.sourceLines) {
    for (const value of sourceLine.beginValuesMs) {
      const adjusted = adjustedTimestamp(
        value,
        scanned.metadata.offsetMs,
        sourceLine.sourceIndex,
        diagnostics,
      );
      if (adjusted !== null) adjustedBegins.push(adjusted);
    }
  }
  const sortedUniqueBegins = [...new Set(adjustedBegins)].sort(
    (left, right) => left - right,
  );

  const documentId = createDocumentId("lrc", input);
  const agentId = createDefaultAgentId(documentId);
  const language = resolveLanguage(input, scanned.metadata.declaredLanguage);
  const lines: TextLyricLine[] = [];

  for (const sourceLine of scanned.sourceLines) {
    const lineLanguage = inferLyricLanguage(
      sourceLine.text,
      language.declared,
      language.effective,
    );
    if (sourceLine.beginValuesMs.length === 0) {
      const index = lines.length;
      lines.push({
        id: createLineId(documentId, sourceLine.sourceIndex, 0),
        index,
        sourceIndex: sourceLine.sourceIndex,
        sectionIndex: sourceLine.sectionIndex,
        begin: unknownTimestamp(),
        end: unknownTimestamp(),
        agentId,
        type: "static",
        tracks: {
          foreground: { text: sourceLine.text, language: lineLanguage, words: [] },
        },
      });
      continue;
    }

    for (
      let occurrence = 0;
      occurrence < sourceLine.beginValuesMs.length;
      occurrence += 1
    ) {
      const sourceBeginMs = sourceLine.beginValuesMs[occurrence];
      if (sourceBeginMs === undefined) continue;
      const beginMs = adjustedTimestamp(
        sourceBeginMs,
        scanned.metadata.offsetMs,
        sourceLine.sourceIndex,
        [],
      );
      if (beginMs === null) continue;

      const index = lines.length;
      lines.push({
        id: createLineId(documentId, sourceLine.sourceIndex, occurrence),
        index,
        sourceIndex: sourceLine.sourceIndex,
        sectionIndex: sourceLine.sectionIndex,
        begin: knownTimestamp(beginMs, "source"),
        end: lineEnd(beginMs, sortedUniqueBegins, mediaDurationMs),
        agentId,
        type: "line-timed",
        tracks: {
          foreground: { text: sourceLine.text, language: lineLanguage, words: [] },
        },
      });
    }
  }

  if (lines.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "lrc.no-representable-lines",
      message: "LRC input contains no representable lyric lines.",
    });
    return parseFailure(
      "lrc",
      "probable",
      "lrc.no-representable-lines",
      "LRC input contains no representable lyric lines.",
      diagnostics,
    );
  }

  if (scanned.untimedLineCount > 0) {
    diagnostics.push({
      severity: "info",
      code: "lrc.untimed-lines-preserved",
      message: "Untimed LRC text was preserved as static source-ordered lines.",
    });
  }
  if (
    mediaDurationMs === null &&
    lines.some(
      (line) => line.begin.valueMs !== null && line.end.valueMs === null,
    )
  ) {
    diagnostics.push({
      severity: "info",
      code: "lrc.open-ended-final-line",
      message: "The final timed LRC line remains open-ended without mediaDurationMs.",
    });
  } else if (
    mediaDurationMs !== null &&
    lines.some(
      (line) =>
        line.begin.valueMs !== null &&
        line.begin.valueMs > mediaDurationMs &&
        line.end.valueMs === null,
    )
  ) {
    diagnostics.push({
      severity: "warning",
      code: "lrc.media-duration-before-line",
      message: "mediaDurationMs precedes one or more timed LRC lines.",
    });
  }

  const source = describeSourceOrder("lrc", input, lines);
  if (!source.lineBeginOrderMonotonic) {
    diagnostics.push({
      severity: "info",
      code: "lrc.non-monotonic-source-order",
      message: "LRC line begin times are non-monotonic; source order was preserved.",
    });
  }

  const document: LyricDocument = {
    id: documentId,
    duration:
      mediaDurationMs === null
        ? unknownTimestamp()
        : knownTimestamp(mediaDurationMs, "media-duration-inferred"),
    language,
    agents: [{ id: agentId, type: "person", alignment: "auto" }],
    lines,
    source,
  };

  return {
    ok: true,
    format: "lrc",
    confidence: "exact",
    document,
    diagnostics,
  };
}

export function parseLrc(input: LyricsParseInput): LyricsParseResult {
  try {
    return parseLrcInternal(input);
  } catch {
    return parseFailure(
      "lrc",
      "probable",
      "lrc.internal-error",
      "LRC parsing failed unexpectedly.",
    );
  }
}

export function looksLikeLrc(text: string): boolean {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  return lines.some((line) => {
    let cursor = line.match(/^\s*/)?.[0].length ?? 0;
    while (line[cursor] === "[") {
      const closeIndex = line.indexOf("]", cursor + 1);
      if (closeIndex < 0) return false;
      const tag = line.slice(cursor + 1, closeIndex);
      if (parseLrcTimestampMs(tag) !== null) return true;
      if (!isMetadataTag(tag)) return false;
      cursor = closeIndex + 1;
    }
    return false;
  });
}

export const lrcParser: LyricsParser = {
  id: "lrc",
  parse: parseLrc,
};
