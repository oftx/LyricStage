import {
  buildTimedTextDocument,
  normalizeTimedTextTokens,
  scanSuffixedTimedTokens,
  type RawTimedTextToken,
  type TimedTextAgent,
  type TimedTextLineDraft,
} from "./timed-text.js";
import { parseFailure } from "./internal.js";
import type {
  LyricsParseInput,
  LyricsParseResult,
  LyricsParser,
  ParseDiagnostic,
} from "./types.js";

interface LysRole {
  readonly agent: TimedTextAgent;
  readonly background: boolean;
}

const LYS_LINE_PREFIX = /^\s*\[(\d+)\]/;

function resolveRole(
  property: number,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
): LysRole {
  switch (property) {
    case 0:
      return { agent: "primary", background: false };
    case 2:
      return { agent: "duet", background: false };
    case 6:
      return { agent: "primary", background: true };
    case 8:
      return { agent: "duet", background: true };
    default:
      diagnostics.push({
        severity: "warning",
        code: "lys.unknown-line-property",
        message:
          "An unrecognized Lyricify Syllable line property was preserved as a primary foreground line.",
        sourceIndex,
      });
      return { agent: "primary", background: false };
  }
}

function appendTrailingText(
  tokens: readonly RawTimedTextToken[],
  trailingText: string,
): readonly RawTimedTextToken[] {
  if (!trailingText || tokens.length === 0) return tokens;
  const lastIndex = tokens.length - 1;
  return tokens.map((token, index) =>
    index === lastIndex
      ? {
          ...token,
          text: `${token.text}${trailingText}`,
        }
      : token,
  );
}

function parseLysInternal(input: LyricsParseInput): LyricsParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  const lines: TimedTextLineDraft[] = [];
  const physicalLines = input.text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  let sectionIndex = 0;
  let pendingSectionBreak = false;

  for (let sourceIndex = 0; sourceIndex < physicalLines.length; sourceIndex += 1) {
    const physicalLine = physicalLines[sourceIndex];
    if (physicalLine === undefined || physicalLine.trim().length === 0) {
      if (lines.length > 0) pendingSectionBreak = true;
      continue;
    }

    const prefix = LYS_LINE_PREFIX.exec(physicalLine);
    const propertyText = prefix?.[1];
    if (!prefix || propertyText === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "lys.invalid-line-prefix",
        message: "A non-empty line has no valid Lyricify Syllable property prefix.",
        sourceIndex,
      });
      continue;
    }
    const property = Number(propertyText);
    if (!Number.isSafeInteger(property)) {
      diagnostics.push({
        severity: "warning",
        code: "lys.line-property-out-of-range",
        message: "A Lyricify Syllable line property is outside the supported integer range.",
        sourceIndex,
      });
      continue;
    }

    const payload = physicalLine.slice(prefix[0].length);
    const scanned = scanSuffixedTimedTokens(payload);
    if (scanned.tokens.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "lys.no-timed-tokens",
        message: "A Lyricify Syllable line contains no valid timed tokens.",
        sourceIndex,
      });
      continue;
    }
    let tokens = scanned.tokens;
    if (scanned.trailingText.length > 0) {
      diagnostics.push({
        severity: "info",
        code: "lys.trailing-text-inferred",
        message:
          "Untimed trailing text was attached to the preceding timed token so the lyric text is preserved.",
        sourceIndex,
      });
      tokens = appendTrailingText(tokens, scanned.trailingText);
    }
    const words = normalizeTimedTextTokens(
      tokens,
      sourceIndex,
      diagnostics,
      "lys",
    );
    if (pendingSectionBreak && lines.length > 0) {
      sectionIndex += 1;
      pendingSectionBreak = false;
    }
    const role = resolveRole(property, sourceIndex, diagnostics);
    lines.push({
      sourceIndex,
      sectionIndex,
      beginMs: null,
      endMs: null,
      words,
      agent: role.agent,
      background: role.background,
    });
  }

  return buildTimedTextDocument({
    format: "lys",
    input,
    lines,
    diagnostics,
    attachBackgroundTracks: true,
  });
}

export function parseLys(input: LyricsParseInput): LyricsParseResult {
  try {
    return parseLysInternal(input);
  } catch {
    return parseFailure(
      "lys",
      "probable",
      "lys.internal-error",
      "Lyricify Syllable parsing failed unexpectedly.",
    );
  }
}

export function looksLikeLys(text: string): boolean {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r\n?|\n/)
    .some((line) => {
      const prefix = /^\s*\[(?:0|2|6|8)\]/.exec(line);
      return (
        prefix !== null &&
        scanSuffixedTimedTokens(line.slice(prefix[0].length)).tokens.length > 0
      );
    });
}

export const lysParser: LyricsParser = {
  id: "lys",
  parse: parseLys,
};
