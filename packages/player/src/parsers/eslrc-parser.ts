import { parseFailure } from "./internal.js";
import { parseLrcTimestampMs } from "./time.js";
import {
  buildTimedTextDocument,
  normalizeTimedTextTokens,
  type RawTimedTextToken,
  type TimedTextLineDraft,
} from "./timed-text.js";
import type {
  LyricsParseInput,
  LyricsParseResult,
  LyricsParser,
  ParseDiagnostic,
} from "./types.js";

interface TimestampTag {
  readonly openIndex: number;
  readonly closeIndex: number;
  readonly valueMs: number;
}

interface ParsedEslrcLine {
  readonly tokens: readonly RawTimedTextToken[];
  readonly beginMs: number;
  readonly endMs: number | null;
}

function leadingWhitespaceLength(value: string): number {
  return value.match(/^\s*/u)?.[0].length ?? 0;
}

function readTimestampTagAt(line: string, openIndex: number): TimestampTag | null {
  if (line[openIndex] !== "[") return null;
  const closeIndex = line.indexOf("]", openIndex + 1);
  if (closeIndex < 0) return null;
  const valueMs = parseLrcTimestampMs(line.slice(openIndex + 1, closeIndex));
  return valueMs === null ? null : { openIndex, closeIndex, valueMs };
}

function findNextTimestampTag(line: string, fromIndex: number): TimestampTag | null {
  let cursor = fromIndex;
  while (cursor < line.length) {
    const openIndex = line.indexOf("[", cursor);
    if (openIndex < 0) return null;
    const closeIndex = line.indexOf("]", openIndex + 1);
    if (closeIndex < 0) return null;
    const valueMs = parseLrcTimestampMs(line.slice(openIndex + 1, closeIndex));
    if (valueMs !== null) return { openIndex, closeIndex, valueMs };
    cursor = closeIndex + 1;
  }
  return null;
}

function parsePhysicalLine(
  line: string,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
): ParsedEslrcLine | null {
  const firstOpenIndex = leadingWhitespaceLength(line);
  const lineStart = readTimestampTagAt(line, firstOpenIndex);
  if (!lineStart) {
    diagnostics.push({
      severity: "warning",
      code: "eslrc.invalid-line-start",
      message: "An ESLRC lyric line must begin with a valid timestamp tag.",
      sourceIndex,
    });
    return null;
  }

  const tokens: RawTimedTextToken[] = [];
  let carryBeginMs = lineStart.valueMs;
  let textBeginIndex = lineStart.closeIndex + 1;

  while (textBeginIndex < line.length) {
    const wordEnd = findNextTimestampTag(line, textBeginIndex);
    if (!wordEnd) {
      if (line.slice(textBeginIndex).trim().length > 0) {
        diagnostics.push({
          severity: "warning",
          code: "eslrc.missing-word-end",
          message: "An ESLRC lyric token is missing its ending timestamp.",
          sourceIndex,
        });
      }
      break;
    }

    const tokenText = line.slice(textBeginIndex, wordEnd.openIndex);
    const whitespaceOnly = tokenText.length > 0 && tokenText.trim().length === 0;
    if (tokenText.length === 0) {
      // A zero-length span is encoded as adjacent end timestamps. Its end
      // timestamp is the next word's begin and must advance the carry clock.
      carryBeginMs = wordEnd.valueMs;
    } else if (whitespaceOnly) {
      // Generated ESLRC uses ` [00:00.000]` as a spacing sentinel. Its zero
      // timestamp is not part of the word clock and must not reset the carry.
      tokens.push({ text: tokenText, beginMs: 0, durationMs: 0 });
    } else if (tokenText.length > 0) {
      if (wordEnd.valueMs < carryBeginMs) {
        diagnostics.push({
          severity: "warning",
          code: "eslrc.word-end-before-begin",
          message: "An ESLRC lyric token ends before its inferred begin time.",
          sourceIndex,
        });
      } else {
        tokens.push({
          text: tokenText,
          beginMs: carryBeginMs,
          durationMs: wordEnd.valueMs - carryBeginMs,
        });
        carryBeginMs = wordEnd.valueMs;
      }
    }

    textBeginIndex = wordEnd.closeIndex + 1;
  }

  return {
    tokens,
    beginMs: lineStart.valueMs,
    endMs: tokens.reduce<number | null>((latest, token) => {
      if (token.text.trim().length === 0) return latest;
      const endMs = token.beginMs + token.durationMs;
      return latest === null ? endMs : Math.max(latest, endMs);
    }, null),
  };
}

function parseEslrcInternal(input: LyricsParseInput): LyricsParseResult {
  if (typeof input.text !== "string") {
    return parseFailure(
      "eslrc",
      "probable",
      "eslrc.invalid-input",
      "ESLRC input must be a string.",
    );
  }

  const diagnostics: ParseDiagnostic[] = [];
  const physicalLines = input.text.replace(/^\uFEFF/u, "").split(/\r\n?|\n/u);
  const lines: TimedTextLineDraft[] = [];
  let sectionIndex = 0;
  let pendingSectionBreak = false;

  for (let sourceIndex = 0; sourceIndex < physicalLines.length; sourceIndex += 1) {
    const physicalLine = physicalLines[sourceIndex];
    if (physicalLine === undefined || physicalLine.trim().length === 0) {
      if (lines.length > 0) pendingSectionBreak = true;
      continue;
    }

    if (pendingSectionBreak && lines.length > 0) {
      sectionIndex += 1;
      pendingSectionBreak = false;
    }

    const parsed = parsePhysicalLine(physicalLine, sourceIndex, diagnostics);
    if (!parsed) continue;
    const words = normalizeTimedTextTokens(
      parsed.tokens,
      sourceIndex,
      diagnostics,
      "eslrc",
    );
    if (words.length === 0 || parsed.endMs === null) {
      diagnostics.push({
        severity: "warning",
        code: "eslrc.empty-timed-line",
        message: "An ESLRC line contained no representable timed text.",
        sourceIndex,
      });
      continue;
    }

    lines.push({
      sourceIndex,
      sectionIndex,
      beginMs: parsed.beginMs,
      endMs: parsed.endMs,
      words,
      agent: "primary",
      background: false,
    });
  }

  if (lines.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "eslrc.no-valid-lines",
      message: "ESLRC input contains no valid timed lyric lines.",
    });
    return parseFailure(
      "eslrc",
      "probable",
      "eslrc.no-valid-lines",
      "ESLRC input contains no valid timed lyric lines.",
      diagnostics,
    );
  }

  return buildTimedTextDocument({
    format: "eslrc",
    input,
    lines,
    diagnostics,
  });
}

export function parseEslrc(input: LyricsParseInput): LyricsParseResult {
  try {
    return parseEslrcInternal(input);
  } catch {
    return parseFailure(
      "eslrc",
      "probable",
      "eslrc.internal-error",
      "ESLRC parsing failed unexpectedly.",
    );
  }
}

export function looksLikeEslrc(text: string): boolean {
  const physicalLines = text.replace(/^\uFEFF/u, "").split(/\r\n?|\n/u);
  return physicalLines.some((line) => {
    const firstOpenIndex = leadingWhitespaceLength(line);
    const lineStart = readTimestampTagAt(line, firstOpenIndex);
    if (!lineStart) return false;
    let cursor = lineStart.closeIndex + 1;
    let previousTimestampMs = lineStart.valueMs;
    let textTokenCount = 0;

    while (cursor < line.length) {
      if (line.slice(cursor).trim().length === 0) break;
      const wordEnd = findNextTimestampTag(line, cursor);
      if (!wordEnd) return false;
      const tokenText = line.slice(cursor, wordEnd.openIndex);
      // Generated ESLRC may put a zero-duration spacing sentinel directly
      // beside the next word timestamp, leaving an empty token between tags.
      // Only that zero-ms separator may be empty; arbitrary adjacent tags
      // should remain eligible for the line-level LRC detector.
      if (tokenText.length === 0 && previousTimestampMs !== 0) return false;
      if (tokenText.trim().length > 0) textTokenCount += 1;
      previousTimestampMs = wordEnd.valueMs;
      cursor = wordEnd.closeIndex + 1;
    }

    return textTokenCount > 0;
  });
}

export const eslrcParser: LyricsParser = {
  id: "eslrc",
  parse: parseEslrc,
};
