import type {
  LyricAgent,
  LyricDocument,
  LyricFormat,
  LyricLanguage,
  LyricTrack,
  LyricWord,
  TextLyricLine,
} from "../domain/types.js";
import { createAgentId, createWordId } from "../domain/ids.js";
import { inferLyricLanguage } from "../domain/language.js";
import {
  createDocumentId,
  createLineId,
  describeSourceOrder,
  parseFailure,
  readMediaDuration,
  resolveLanguage,
} from "./internal.js";
import { knownTimestamp, unknownTimestamp } from "./time.js";
import type {
  LyricsParseInput,
  LyricsParseResult,
  ParseDiagnostic,
} from "./types.js";

export interface RawTimedTextToken {
  readonly text: string;
  readonly beginMs: number;
  readonly durationMs: number;
}

export interface TimedTextWordDraft {
  readonly text: string;
  readonly beginMs: number;
  readonly endMs: number;
  readonly spaceBefore: boolean;
}

export type TimedTextAgent = "primary" | "duet";

export interface TimedTextLineDraft {
  readonly sourceIndex: number;
  readonly sectionIndex: number;
  readonly beginMs: number | null;
  readonly endMs: number | null;
  /** Authored line-level text when the format provides no word timing. */
  readonly lineText?: string;
  readonly words: readonly TimedTextWordDraft[];
  readonly agent: TimedTextAgent;
  readonly background: boolean;
}

export interface TimedTextDocumentInput {
  readonly format: LyricFormat;
  readonly input: LyricsParseInput;
  readonly lines: readonly TimedTextLineDraft[];
  readonly diagnostics: ParseDiagnostic[];
  readonly attachBackgroundTracks?: boolean;
}

export interface TimedTokenScanResult {
  readonly tokens: readonly RawTimedTextToken[];
  readonly leadingText: string;
  readonly trailingText: string;
}

interface ResolvedLineBounds {
  readonly beginMs: number | null;
  readonly endMs: number | null;
}

interface MaterializedLineDraft {
  readonly source: TimedTextLineDraft;
  readonly backgroundLines: readonly TimedTextLineDraft[];
}

const PREFIXED_TOKEN_PATTERN = /\((\d+),(\d+),(\d+)\)/g;
const SUFFIXED_TOKEN_PATTERN = /\((\d+),(\d+)\)/g;

function parseUnsignedInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function safeTimedTextEnd(
  beginMs: number,
  durationMs: number,
): number | null {
  if (
    !Number.isSafeInteger(beginMs) ||
    beginMs < 0 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0
  ) {
    return null;
  }
  const endMs = beginMs + durationMs;
  return Number.isSafeInteger(endMs) ? endMs : null;
}

/** Scans YRC-style `(start,duration,channel)text` tokens. */
export function scanPrefixedTimedTokens(payload: string): TimedTokenScanResult {
  const matches = [...payload.matchAll(PREFIXED_TOKEN_PATTERN)];
  const tokens: RawTimedTextToken[] = [];
  const firstMatch = matches[0];
  const leadingText =
    firstMatch?.index === undefined ? payload : payload.slice(0, firstMatch.index);

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match || match.index === undefined) continue;
    const beginText = match[1];
    const durationText = match[2];
    if (
      beginText === undefined ||
      durationText === undefined ||
      match[3] === undefined
    ) {
      continue;
    }
    const beginMs = parseUnsignedInteger(beginText);
    const durationMs = parseUnsignedInteger(durationText);
    if (beginMs === null || durationMs === null) continue;

    const textBegin = match.index + match[0].length;
    const nextMatch = matches[index + 1];
    const textEnd = nextMatch?.index ?? payload.length;
    tokens.push({
      text: payload.slice(textBegin, textEnd),
      beginMs,
      durationMs,
    });
  }

  return {
    tokens,
    leadingText,
    trailingText: "",
  };
}

/** Scans QRC/LYS-style `text(start,duration)` tokens. */
export function scanSuffixedTimedTokens(payload: string): TimedTokenScanResult {
  const matches = [...payload.matchAll(SUFFIXED_TOKEN_PATTERN)];
  const tokens: RawTimedTextToken[] = [];
  let textBegin = 0;

  for (const match of matches) {
    if (match.index === undefined) continue;
    const beginText = match[1];
    const durationText = match[2];
    if (beginText === undefined || durationText === undefined) continue;
    const beginMs = parseUnsignedInteger(beginText);
    const durationMs = parseUnsignedInteger(durationText);
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

function trimTokenEdges(text: string): {
  readonly text: string;
  readonly leadingSpace: boolean;
  readonly trailingSpace: boolean;
} {
  const leadingSpace = /^\s/u.test(text);
  const trailingSpace = /\s$/u.test(text);
  return {
    text: text.replace(/^\s+|\s+$/gu, ""),
    leadingSpace,
    trailingSpace,
  };
}

/**
 * Converts zero-time whitespace sentinels into layout spaces without creating
 * invalid karaoke words.
 *
 * Non-whitespace zero-duration tokens (common NetEase YRC punctuation such as
 * trailing `？` with `(t,0,0)`) are given a 1ms half-open span so karaoke
 * binding does not reject the whole line as `invalid-word-timing` and fall
 * back to full-line highlight.
 */
export function normalizeTimedTextTokens(
  tokens: readonly RawTimedTextToken[],
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
  diagnosticPrefix: string,
): readonly TimedTextWordDraft[] {
  const words: TimedTextWordDraft[] = [];
  let pendingSpace = false;

  for (const token of tokens) {
    let durationMs = token.durationMs;
    if (
      Number.isFinite(durationMs) &&
      durationMs === 0 &&
      token.text.trim().length > 0
    ) {
      // Half-open [begin, begin+1): enough for progress sampling and
      // compileKaraokeBindingGroups (requires endMs > beginMs).
      durationMs = 1;
      diagnostics.push({
        severity: "info",
        code: `${diagnosticPrefix}.zero-duration-token-expanded`,
        message:
          "A zero-duration non-whitespace token was expanded to 1ms for karaoke binding.",
        sourceIndex,
      });
    }

    const endMs = safeTimedTextEnd(token.beginMs, durationMs);
    if (endMs === null) {
      diagnostics.push({
        severity: "warning",
        code: `${diagnosticPrefix}.token-time-out-of-range`,
        message: "A timed lyric token is outside the supported integer range.",
        sourceIndex,
      });
      continue;
    }

    const normalized = trimTokenEdges(token.text);
    if (!normalized.text) {
      if (token.text.length > 0) pendingSpace = true;
      continue;
    }

    words.push({
      text: normalized.text,
      beginMs: token.beginMs,
      endMs,
      spaceBefore:
        words.length > 0 && (pendingSpace || normalized.leadingSpace),
    });
    pendingSpace = normalized.trailingSpace;
  }

  return words;
}

function lineBounds(line: TimedTextLineDraft): ResolvedLineBounds {
  let wordBeginMs: number | null = null;
  let wordEndMs: number | null = null;
  for (const word of line.words) {
    wordBeginMs =
      wordBeginMs === null ? word.beginMs : Math.min(wordBeginMs, word.beginMs);
    wordEndMs =
      wordEndMs === null ? word.endMs : Math.max(wordEndMs, word.endMs);
  }
  return {
    beginMs: line.beginMs ?? wordBeginMs,
    endMs: line.endMs ?? wordEndMs,
  };
}

function overlapDuration(
  left: ResolvedLineBounds,
  right: ResolvedLineBounds,
): number {
  if (
    left.beginMs === null ||
    left.endMs === null ||
    right.beginMs === null ||
    right.endMs === null
  ) {
    return -1;
  }
  return Math.min(left.endMs, right.endMs) - Math.max(left.beginMs, right.beginMs);
}

function backgroundOwnerScore(
  foreground: TimedTextLineDraft,
  background: TimedTextLineDraft,
): number {
  const foregroundBounds = lineBounds(foreground);
  const backgroundBounds = lineBounds(background);
  const overlap = overlapDuration(foregroundBounds, backgroundBounds);
  if (overlap < 0) return Number.NEGATIVE_INFINITY;
  const contains =
    foregroundBounds.beginMs !== null &&
    foregroundBounds.endMs !== null &&
    backgroundBounds.beginMs !== null &&
    backgroundBounds.endMs !== null &&
    foregroundBounds.beginMs <= backgroundBounds.beginMs &&
    foregroundBounds.endMs >= backgroundBounds.endMs;
  const sourceDistance = Math.abs(
    foreground.sourceIndex - background.sourceIndex,
  );
  return (contains ? 1_000_000_000 : 0) + overlap * 1_000 - sourceDistance;
}

function associateBackgroundLines(
  lines: readonly TimedTextLineDraft[],
  diagnostics: ParseDiagnostic[],
  format: LyricFormat,
): readonly MaterializedLineDraft[] {
  const foregroundLines = lines.filter((line) => !line.background);
  const backgroundLines = lines.filter((line) => line.background);
  const attached = new Map<TimedTextLineDraft, TimedTextLineDraft[]>();
  const orphaned = new Set<TimedTextLineDraft>();

  for (const background of backgroundLines) {
    let owner: TimedTextLineDraft | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const sameAgent = foregroundLines.filter(
      (foreground) => foreground.agent === background.agent,
    );
    const previousCandidates = sameAgent
      .filter((foreground) => foreground.sourceIndex < background.sourceIndex)
      .sort((left, right) => right.sourceIndex - left.sourceIndex);
    const nearestPrevious = previousCandidates[0] ?? null;

    if (nearestPrevious !== null) {
      owner = nearestPrevious;
      bestScore = backgroundOwnerScore(nearestPrevious, background);
      if (!Number.isFinite(bestScore)) {
        diagnostics.push({
          severity: "info",
          code: `${format}.background-owner-no-overlap`,
          message:
            "A background lyric was assigned to the nearest preceding same-voice foreground line even though their authored intervals do not overlap.",
          sourceIndex: background.sourceIndex,
        });
      }
    } else {
      const candidates = sameAgent.length > 0 ? sameAgent : foregroundLines;
      for (const candidate of candidates) {
        const score = backgroundOwnerScore(candidate, background);
        if (score > bestScore) {
          owner = candidate;
          bestScore = score;
        }
      }
    }

    if (owner === null) {
      orphaned.add(background);
      diagnostics.push({
        severity: "warning",
        code: `${format}.orphan-background-line`,
        message:
          "A background lyric could not be associated with an overlapping foreground line and was preserved as a foreground row.",
        sourceIndex: background.sourceIndex,
      });
      continue;
    }
    const ownerBackgrounds = attached.get(owner) ?? [];
    ownerBackgrounds.push(background);
    attached.set(owner, ownerBackgrounds);
  }

  return lines.flatMap((line) => {
    if (line.background && !orphaned.has(line)) return [];
    return [
      {
        source: line,
        backgroundLines: line.background ? [] : (attached.get(line) ?? []),
      },
    ];
  });
}

function mergeBackgroundWords(
  lines: readonly TimedTextLineDraft[],
): readonly TimedTextWordDraft[] {
  const words: TimedTextWordDraft[] = [];
  for (const line of lines) {
    line.words.forEach((word, index) => {
      words.push({
        ...word,
        spaceBefore: words.length > 0 && index === 0 ? true : word.spaceBefore,
      });
    });
  }
  return words;
}

function trackText(words: readonly TimedTextWordDraft[]): string {
  return words
    .map(
      (word, index) =>
        `${index > 0 && word.spaceBefore ? " " : ""}${word.text}`,
    )
    .join("");
}

function materializeTrack(
  words: readonly TimedTextWordDraft[],
  lineId: string,
  role: "foreground" | "background",
  language: LyricLanguage,
  lineText?: string,
): LyricTrack {
  const text = lineText ?? trackText(words);
  const materializedWords: LyricWord[] = words.map((word, wordIndex) => ({
    id: createWordId(lineId, role, wordIndex),
    text: word.text,
    begin: knownTimestamp(word.beginMs),
    end: knownTimestamp(word.endMs),
    spaceBefore: word.spaceBefore,
  }));
  return {
    text,
    language: inferLyricLanguage(
      text,
      language.declared,
      language.effective,
    ),
    words: materializedWords,
  };
}

function materializeLines(
  documentId: string,
  lines: readonly MaterializedLineDraft[],
  language: LyricLanguage,
  agentIds: Readonly<Record<TimedTextAgent, string>>,
  diagnostics: ParseDiagnostic[],
  format: LyricFormat,
): readonly TextLyricLine[] {
  const materialized: TextLyricLine[] = [];
  for (const entry of lines) {
    const source = entry.source;
    if (source.words.length === 0 && !source.lineText) {
      diagnostics.push({
        severity: "warning",
        code: `${format}.empty-timed-line`,
        message: "A timed lyric line contained no representable text tokens.",
        sourceIndex: source.sourceIndex,
      });
      continue;
    }

    const lineId = createLineId(documentId, source.sourceIndex, 0);
    const backgroundWords = mergeBackgroundWords(entry.backgroundLines);
    const allBounds = [source, ...entry.backgroundLines].map(lineBounds);
    const beginValues = allBounds
      .map((bounds) => bounds.beginMs)
      .filter((value): value is number => value !== null);
    const endValues = allBounds
      .map((bounds) => bounds.endMs)
      .filter((value): value is number => value !== null);
    const beginMs = beginValues.length > 0 ? Math.min(...beginValues) : null;
    const endMs = endValues.length > 0 ? Math.max(...endValues) : null;
    if (beginMs !== null && endMs !== null && endMs < beginMs) {
      diagnostics.push({
        severity: "warning",
        code: `${format}.invalid-line-interval`,
        message: "A lyric line ends before it begins; authored values were retained.",
        sourceIndex: source.sourceIndex,
      });
    }

    materialized.push({
      id: lineId,
      index: materialized.length,
      sourceIndex: source.sourceIndex,
      sectionIndex: source.sectionIndex,
      begin:
        beginMs === null ? unknownTimestamp() : knownTimestamp(beginMs),
      end: endMs === null ? unknownTimestamp() : knownTimestamp(endMs),
      agentId: agentIds[source.agent],
      type: source.words.length > 0 ? "karaoke" : "line-timed",
      tracks: {
        foreground: materializeTrack(
          source.words,
          lineId,
          "foreground",
          language,
          source.lineText,
        ),
        ...(backgroundWords.length > 0
          ? {
              background: materializeTrack(
                backgroundWords,
                lineId,
                "background",
                language,
              ),
            }
          : {}),
      },
    });
  }
  return materialized;
}

export function buildTimedTextDocument(
  options: TimedTextDocumentInput,
): LyricsParseResult {
  const { format, input, diagnostics } = options;
  const documentId = createDocumentId(format, input);
  const language = resolveLanguage(input);
  const agentIds: Readonly<Record<TimedTextAgent, string>> = {
    primary: createAgentId(documentId, "default"),
    duet: createAgentId(documentId, "duet"),
  };
  const associatedLines = options.attachBackgroundTracks
    ? associateBackgroundLines(options.lines, diagnostics, format)
    : options.lines.map((source) => ({ source, backgroundLines: [] }));
  const lines = materializeLines(
    documentId,
    associatedLines,
    language,
    agentIds,
    diagnostics,
    format,
  );

  if (lines.length === 0) {
    return parseFailure(
      format,
      "probable",
      `${format}.no-representable-lines`,
      `The ${format.toUpperCase()} input contains no representable lyric lines.`,
      diagnostics,
    );
  }

  const usedAgents = new Set(lines.map((line) => line.agentId));
  const candidateAgents: readonly LyricAgent[] = [
    {
      id: agentIds.primary,
      type: "person",
      alignment: "auto",
    },
    {
      id: agentIds.duet,
      type: "person",
      alignment: "end",
    },
  ];
  const agents = candidateAgents.filter((agent) => usedAgents.has(agent.id));
  const mediaDurationMs = readMediaDuration(input, diagnostics);
  const maximumLineEndMs = lines.reduce((maximum, line) => {
    const endMs = line.end.valueMs;
    return endMs === null ? maximum : Math.max(maximum, endMs);
  }, 0);
  if (mediaDurationMs !== null && mediaDurationMs < maximumLineEndMs) {
    diagnostics.push({
      severity: "warning",
      code: `${format}.media-duration-before-content-end`,
      message: "mediaDurationMs precedes the final timed lyric content.",
    });
  }

  const source = describeSourceOrder(format, input, lines);
  if (!source.lineBeginOrderMonotonic) {
    diagnostics.push({
      severity: "info",
      code: `${format}.non-monotonic-source-order`,
      message: "Lyric line begin times are non-monotonic; source order was preserved.",
    });
  }
  const document: LyricDocument = {
    id: documentId,
    duration:
      mediaDurationMs !== null
        ? knownTimestamp(mediaDurationMs, "media-duration-inferred")
        : knownTimestamp(maximumLineEndMs, "derived"),
    language,
    agents,
    lines,
    source,
  };

  return {
    ok: true,
    format,
    confidence: "exact",
    document,
    diagnostics,
  };
}
