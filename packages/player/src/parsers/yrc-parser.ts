import {
  buildTimedTextDocument,
  normalizeTimedTextTokens,
  safeTimedTextEnd,
  scanPrefixedTimedTokens,
  type TimedTextLineDraft,
} from "./timed-text.js";
import { parseFailure } from "./internal.js";
import type {
  LyricsParseInput,
  LyricsParseResult,
  LyricsParser,
  ParseDiagnostic,
} from "./types.js";

const YRC_LINE_PATTERN = /^\s*\[(\d+),(\d+)\](.*)$/u;
const YRC_SHAPED_LINE_PATTERN = /^\s*\[/u;
const YRC_DETECTION_PATTERN =
  /^\s*\[\d+,\d+\].*\(\d+,\d+,\d+\)/mu;

function parseUnsignedInteger(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseYrcInternal(input: LyricsParseInput): LyricsParseResult {
  if (typeof input.text !== "string") {
    return parseFailure(
      "yrc",
      "probable",
      "yrc.invalid-input",
      "YRC input must be a string.",
    );
  }

  const diagnostics: ParseDiagnostic[] = [];
  const physicalLines = input.text.replace(/^\uFEFF/u, "").split(/\r\n?|\n/u);
  const lines: TimedTextLineDraft[] = [];
  let sectionIndex = 0;
  let pendingSectionBreak = false;

  for (
    let sourceIndex = 0;
    sourceIndex < physicalLines.length;
    sourceIndex += 1
  ) {
    const physicalLine = physicalLines[sourceIndex];
    if (physicalLine === undefined || physicalLine.trim().length === 0) {
      if (lines.length > 0) pendingSectionBreak = true;
      continue;
    }

    const lineMatch = YRC_LINE_PATTERN.exec(physicalLine);
    if (!lineMatch) {
      if (YRC_SHAPED_LINE_PATTERN.test(physicalLine)) {
        diagnostics.push({
          severity: "warning",
          code: "yrc.invalid-line-header",
          message: "A YRC line header is malformed.",
          sourceIndex,
        });
      }
      continue;
    }

    const beginText = lineMatch[1];
    const durationText = lineMatch[2];
    const payload = lineMatch[3] ?? "";
    if (beginText === undefined || durationText === undefined) continue;
    const headerBeginMs = parseUnsignedInteger(beginText);
    const headerDurationMs = parseUnsignedInteger(durationText);
    const headerEndMs =
      headerBeginMs === null || headerDurationMs === null
        ? null
        : safeTimedTextEnd(headerBeginMs, headerDurationMs);
    if (
      headerBeginMs === null ||
      headerDurationMs === null ||
      headerEndMs === null
    ) {
      diagnostics.push({
        severity: "warning",
        code: "yrc.line-header-time-out-of-range",
        message: "A YRC line header is outside the supported integer range.",
        sourceIndex,
      });
      continue;
    }

    const scanned = scanPrefixedTimedTokens(payload);
    if (scanned.leadingText.length > 0) {
      diagnostics.push({
        severity: "warning",
        code: "yrc.leading-text-ignored",
        message: "Untimed text before the first YRC token was ignored.",
        sourceIndex,
      });
    }
    if (scanned.tokens.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "yrc.no-timed-tokens",
        message: "A YRC line contains no timed tokens.",
        sourceIndex,
      });
    }

    const words = normalizeTimedTextTokens(
      scanned.tokens,
      sourceIndex,
      diagnostics,
      "yrc",
    );
    const maximumWordEndMs = words.reduce<number | null>(
      (maximum, word) =>
        maximum === null ? word.endMs : Math.max(maximum, word.endMs),
      null,
    );
    if (maximumWordEndMs !== null && maximumWordEndMs !== headerEndMs) {
      diagnostics.push({
        severity: "info",
        code: "yrc.header-duration-mismatch",
        message:
          "The YRC header duration differs from the timed word span; the maximum word end was used.",
        sourceIndex,
      });
    }

    if (pendingSectionBreak && lines.length > 0) {
      sectionIndex += 1;
      pendingSectionBreak = false;
    }
    lines.push({
      sourceIndex,
      sectionIndex,
      beginMs: headerBeginMs,
      endMs: maximumWordEndMs ?? headerEndMs,
      words,
      agent: "primary",
      background: false,
    });
  }

  return buildTimedTextDocument({
    format: "yrc",
    input,
    lines,
    diagnostics,
  });
}

export function parseYrc(input: LyricsParseInput): LyricsParseResult {
  try {
    return parseYrcInternal(input);
  } catch {
    return parseFailure(
      "yrc",
      "probable",
      "yrc.internal-error",
      "YRC parsing failed unexpectedly.",
    );
  }
}

export function looksLikeYrc(text: string): boolean {
  return YRC_DETECTION_PATTERN.test(text.replace(/^\uFEFF/u, ""));
}

export const yrcParser: LyricsParser = {
  id: "yrc",
  parse: parseYrc,
};
