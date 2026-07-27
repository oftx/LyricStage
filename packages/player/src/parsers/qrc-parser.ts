import { parseFailure } from "./internal.js";
import {
  buildTimedTextDocument,
  normalizeTimedTextTokens,
  safeTimedTextEnd,
  type RawTimedTextToken,
  type TimedTokenScanResult,
  type TimedTextLineDraft,
} from "./timed-text.js";
import type {
  LyricsParseInput,
  LyricsParseResult,
  LyricsParser,
  ParseDiagnostic,
} from "./types.js";

const QRC_HEADER_PATTERN = /^\s*\[(\d+),(\d+)\]/;
const QRC_METADATA_PATTERN =
  /^\s*\[([A-Za-z][A-Za-z0-9_-]*):(.*)\]\s*$/;
const QRC_TOKEN_PATTERN = /\((\d+),(\d+)(?:,(-?\d+))?\)/g;

interface QrcMetadata {
  offsetMs: number;
  offsetTagCount: number;
}

interface QrcHeader {
  readonly beginMs: number | null;
  readonly endMs: number | null;
  readonly payload: string;
}

function parseUnsignedInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function scanMetadata(
  physicalLines: readonly string[],
  diagnostics: ParseDiagnostic[],
): QrcMetadata {
  const metadata: QrcMetadata = { offsetMs: 0, offsetTagCount: 0 };

  for (let sourceIndex = 0; sourceIndex < physicalLines.length; sourceIndex += 1) {
    const physicalLine = physicalLines[sourceIndex];
    if (physicalLine === undefined) continue;
    const match = QRC_METADATA_PATTERN.exec(physicalLine);
    if (!match || match[1]?.toLowerCase() !== "offset") continue;

    const value = match[2]?.trim() ?? "";
    if (!/^[+-]?\d+$/.test(value)) {
      diagnostics.push({
        severity: "warning",
        code: "qrc.invalid-offset",
        message: "The QRC offset tag must contain an integer millisecond value.",
        sourceIndex,
      });
      continue;
    }

    const offsetMs = Number(value);
    if (!Number.isSafeInteger(offsetMs)) {
      diagnostics.push({
        severity: "warning",
        code: "qrc.invalid-offset",
        message: "The QRC offset tag is outside the supported integer range.",
        sourceIndex,
      });
      continue;
    }

    metadata.offsetMs = offsetMs;
    metadata.offsetTagCount += 1;
  }

  return metadata;
}

/** Scans QQ's `text(start,duration[,marker])` word timing form. */
function scanQrcTimedTokens(payload: string): TimedTokenScanResult {
  const matches = [...payload.matchAll(QRC_TOKEN_PATTERN)];
  const tokens: RawTimedTextToken[] = [];
  let textBegin = 0;

  for (const match of matches) {
    if (match.index === undefined) continue;
    const beginMs = parseUnsignedInteger(match[1]);
    const durationMs = parseUnsignedInteger(match[2]);
    if (beginMs === null || durationMs === null) continue;
    tokens.push({
      text: payload.slice(textBegin, match.index),
      beginMs,
      durationMs,
    });
    textBegin = match.index + match[0].length;
  }

  return {
    tokens,
    leadingText: "",
    trailingText: payload.slice(textBegin),
  };
}

function applyOffset(
  valueMs: number | null,
  offsetMs: number,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
): number | null {
  if (valueMs === null) return null;
  const adjusted = valueMs + offsetMs;
  if (Number.isSafeInteger(adjusted)) return adjusted;
  diagnostics.push({
    severity: "warning",
    code: "qrc.offset-time-out-of-range",
    message: "An offset QRC timestamp is outside the supported integer range.",
    sourceIndex,
  });
  return null;
}

function parseHeader(
  line: string,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
): QrcHeader | null {
  const match = QRC_HEADER_PATTERN.exec(line);
  if (!match) {
    diagnostics.push({
      severity: "warning",
      code: "qrc.invalid-header",
      message: "A non-empty QRC line does not begin with a valid line timing header.",
      sourceIndex,
    });
    return null;
  }

  const beginMs = parseUnsignedInteger(match[1]);
  const durationMs = parseUnsignedInteger(match[2]);
  const endMs =
    beginMs === null || durationMs === null
      ? null
      : safeTimedTextEnd(beginMs, durationMs);
  if (beginMs === null || durationMs === null || endMs === null) {
    diagnostics.push({
      severity: "warning",
      code: "qrc.header-time-out-of-range",
      message: "A QRC line timing header is outside the supported integer range.",
      sourceIndex,
    });
  }

  return {
    beginMs,
    endMs,
    payload: line.slice(match[0].length),
  };
}

function maximumWordEnd(
  words: TimedTextLineDraft["words"],
): number | null {
  let maximum: number | null = null;
  for (const word of words) {
    maximum = maximum === null ? word.endMs : Math.max(maximum, word.endMs);
  }
  return maximum;
}

function parseQrcInternal(input: LyricsParseInput): LyricsParseResult {
  if (typeof input.text !== "string") {
    return parseFailure(
      "qrc",
      "probable",
      "qrc.invalid-input",
      "QRC input must be a string.",
    );
  }

  const diagnostics: ParseDiagnostic[] = [];
  const physicalLines = input.text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  const metadata = scanMetadata(physicalLines, diagnostics);
  const lines: TimedTextLineDraft[] = [];
  let sectionIndex = 0;
  let pendingSectionBreak = false;
  let sectionBreakCount = 0;

  for (let sourceIndex = 0; sourceIndex < physicalLines.length; sourceIndex += 1) {
    const physicalLine = physicalLines[sourceIndex];
    if (physicalLine === undefined || physicalLine.trim().length === 0) {
      if (lines.length > 0) pendingSectionBreak = true;
      continue;
    }
    if (QRC_METADATA_PATTERN.test(physicalLine)) continue;

    const header = parseHeader(physicalLine, sourceIndex, diagnostics);
    if (!header) continue;

    if (pendingSectionBreak) {
      sectionIndex += 1;
      sectionBreakCount += 1;
      pendingSectionBreak = false;
    }

    const scanned = scanQrcTimedTokens(header.payload);
    if (
      scanned.tokens.length > 0 &&
      scanned.trailingText.trim().length > 0
    ) {
      diagnostics.push({
        severity: "warning",
        code: "qrc.trailing-unbound-text",
        message: "Text after the final QRC timing token could not be assigned a time range.",
        sourceIndex,
      });
    }
    const lineText =
      scanned.tokens.length === 0 &&
      header.beginMs !== null &&
      header.endMs !== null &&
      header.payload.trim().length > 0
        ? header.payload.trim()
        : null;
    if (lineText !== null) {
      diagnostics.push({
        severity: "info",
        code: "qrc.line-level-text",
        message: "A line-level QRC row was represented by its authored line interval.",
        sourceIndex,
      });
    } else if (scanned.tokens.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "qrc.no-timed-tokens",
        message: "A QRC line contains no representable timed text.",
        sourceIndex,
      });
    }

    const sourceWords = normalizeTimedTextTokens(
      scanned.tokens,
      sourceIndex,
      diagnostics,
      "qrc",
    );
    const words = sourceWords.flatMap((word) => {
      const beginMs = applyOffset(
        word.beginMs,
        metadata.offsetMs,
        sourceIndex,
        diagnostics,
      );
      const endMs = applyOffset(
        word.endMs,
        metadata.offsetMs,
        sourceIndex,
        diagnostics,
      );
      return beginMs === null || endMs === null
        ? []
        : [{ ...word, beginMs, endMs }];
    });
    const headerBeginMs = applyOffset(
      header.beginMs,
      metadata.offsetMs,
      sourceIndex,
      diagnostics,
    );
    const headerEndMs = applyOffset(
      header.endMs,
      metadata.offsetMs,
      sourceIndex,
      diagnostics,
    );
    const wordEndMs = maximumWordEnd(words);
    if (
      headerEndMs !== null &&
      wordEndMs !== null &&
      headerEndMs !== wordEndMs
    ) {
      diagnostics.push({
        severity: "info",
        code: "qrc.header-duration-mismatch",
        message:
          "The QRC line header duration differs from the timed words; the maximum word end was used.",
        sourceIndex,
      });
    }

    lines.push({
      sourceIndex,
      sectionIndex,
      beginMs: headerBeginMs,
      endMs: wordEndMs ?? headerEndMs,
      ...(lineText === null ? {} : { lineText }),
      words,
      agent: "primary",
      background: false,
    });
  }

  if (metadata.offsetTagCount > 1) {
    diagnostics.push({
      severity: "info",
      code: "qrc.multiple-offset-tags",
      message: "Multiple QRC offset tags were found; the last valid value was applied.",
    });
  }

  if (sectionBreakCount > 0) {
    diagnostics.push({
      severity: "info",
      code: "qrc.section-breaks-preserved",
      message: "Blank lines were represented as section boundaries.",
    });
  }

  return buildTimedTextDocument({
    format: "qrc",
    input,
    lines,
    diagnostics,
  });
}

export function parseQrc(input: LyricsParseInput): LyricsParseResult {
  try {
    return parseQrcInternal(input);
  } catch {
    return parseFailure(
      "qrc",
      "probable",
      "qrc.internal-error",
      "QRC parsing failed unexpectedly.",
    );
  }
}

export function looksLikeQrc(text: string): boolean {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  return lines.some((line) => {
    const match = QRC_HEADER_PATTERN.exec(line);
    if (!match) return false;
    return scanQrcTimedTokens(line.slice(match[0].length)).tokens.length > 0;
  });
}

export const qrcParser: LyricsParser = {
  id: "qrc",
  parse: parseQrc,
};
