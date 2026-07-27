import type {
  LyricTimestamp,
  LyricTrack,
  LyricTracks,
  LyricWord,
} from "../../domain/types.js";
import {
  inferLyricLanguage,
  inferSecondaryLyricLanguage,
  normalizeLanguageTag,
  primaryLanguage,
} from "../../domain/language.js";
import {
  knownTimestamp,
  parseTimeExpressionMs,
  type TimeExpressionOptions,
  unknownTimestamp,
} from "../time.js";
import type { ParseDiagnostic } from "../types.js";
import {
  collectRoleElements,
  collectTextExcludingRoles,
  createDiagnostic,
  getInheritedXmlLanguage,
  getInheritedXmlLanguageWithin,
  getTtmlRole,
  hasAncestorWithRole,
  normalizeText,
} from "./dom.js";
import { projectPronunciationTiming } from "./pronunciation-timing.js";

export const BACKGROUND_ROLES = new Set(["x-bg"]);
export const TRANSLATION_ROLES = new Set(["x-translation"]);
export const PRONUNCIATION_ROLES = new Set([
  "x-pronunciation",
  "x-roman",
  "x-romanization",
  "x-transliteration",
]);
export const BACKGROUND_PRONUNCIATION_ROLES = new Set([
  "x-bg-pronunciation",
  "x-bg-roman",
  "x-bg-romanization",
  "x-bg-transliteration",
]);

const ALL_SECONDARY_ROLES = new Set([
  ...BACKGROUND_ROLES,
  ...TRANSLATION_ROLES,
  ...PRONUNCIATION_ROLES,
  ...BACKGROUND_PRONUNCIATION_ROLES,
]);

interface WordDraft {
  readonly text: string;
  readonly begin: LyricTimestamp;
  readonly end: LyricTimestamp;
  readonly spaceBefore: boolean;
  readonly joinKey: string | null;
}

export interface ParsedTrackDraft {
  readonly text: string;
  readonly declaredLanguage: string | null;
  readonly words: readonly WordDraft[];
}

export interface ParsedElementTiming {
  readonly begin: LyricTimestamp;
  readonly end: LyricTimestamp;
}

interface TimingContext {
  readonly kind: "line" | "word";
  readonly diagnostics: ParseDiagnostic[];
  readonly lineId: string;
  readonly sourceIndex: number;
  readonly timeExpressionOptions: TimeExpressionOptions;
}

export function parseTtmlTimeExpression(
  value: string | null,
  options: TimeExpressionOptions = {},
): number | null {
  return value === null ? null : parseTimeExpressionMs(value, options);
}

export function parseElementTiming(
  element: Element,
  context: TimingContext,
): ParsedElementTiming {
  const begin = parseTimeAttribute(element, "begin", context);
  let end = parseTimeAttribute(element, "end", context, true);

  if (end.valueMs === null) {
    const durationValue = element.getAttribute("dur");
    if (durationValue !== null) {
      const durationMs = parseTtmlTimeExpression(
        durationValue,
        context.timeExpressionOptions,
      );
      if (durationMs === null || durationMs < 0) {
        context.diagnostics.push(
          createDiagnostic(
            "warning",
            `TTML_${context.kind.toUpperCase()}_DURATION_INVALID`,
            `The ${context.kind} duration is not a supported TTML time expression.`,
            context,
          ),
        );
      } else if (begin.valueMs !== null) {
        end = knownTimestamp(begin.valueMs + durationMs, "source");
      }
    }
  }

  if (
    begin.valueMs !== null &&
    end.valueMs !== null &&
    end.valueMs <= begin.valueMs
  ) {
    context.diagnostics.push(
      createDiagnostic(
        "warning",
        `TTML_${context.kind.toUpperCase()}_INTERVAL_INVALID`,
        `The ${context.kind} end time is not after its begin time; authored values were retained.`,
        context,
      ),
    );
  }

  return { begin, end };
}

function parseTimeAttribute(
  element: Element,
  attribute: "begin" | "end",
  context: TimingContext,
  allowDurationFallback = false,
): LyricTimestamp {
  const raw = element.getAttribute(attribute);
  if (raw === null) {
    if (!(allowDurationFallback && element.hasAttribute("dur"))) {
      context.diagnostics.push(
        createDiagnostic(
          "warning",
          `TTML_${context.kind.toUpperCase()}_${attribute.toUpperCase()}_MISSING`,
          `The ${context.kind} has no ${attribute} time; it remains unknown.`,
          context,
        ),
      );
    }
    return unknownTimestamp();
  }

  const valueMs = parseTtmlTimeExpression(raw, context.timeExpressionOptions);
  if (valueMs === null) {
    context.diagnostics.push(
      createDiagnostic(
        "warning",
        `TTML_${context.kind.toUpperCase()}_${attribute.toUpperCase()}_INVALID`,
        `The ${context.kind} ${attribute} time is not a supported TTML time expression; it remains unknown.`,
        context,
      ),
    );
    return unknownTimestamp();
  }
  return knownTimestamp(valueMs);
}

export function parseTtmlTracks(
  paragraph: Element,
  lineId: string,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
  timeExpressionOptions: TimeExpressionOptions = {},
  lineBeginMs: number | null = null,
): LyricTracks {
  const rawForegroundDraft = parseForegroundTrackDraft(
    paragraph,
    lineId,
    sourceIndex,
    diagnostics,
    timeExpressionOptions,
  );
  const rawForegroundPronunciationDraft = projectPronunciationDraftTiming(
    parsePronunciationTrackDraft(
      paragraph,
      lineId,
      sourceIndex,
      diagnostics,
      false,
      timeExpressionOptions,
    ),
    rawForegroundDraft,
    lineId,
    sourceIndex,
    diagnostics,
    "foreground",
  );
  const rawBackgroundDraft = parseBackgroundTrackDraft(
    paragraph,
    lineId,
    sourceIndex,
    diagnostics,
    timeExpressionOptions,
  );
  const rawBackgroundPronunciationDraft = projectPronunciationDraftTiming(
    parsePronunciationTrackDraft(
      paragraph,
      lineId,
      sourceIndex,
      diagnostics,
      true,
      timeExpressionOptions,
    ),
    rawBackgroundDraft,
    lineId,
    sourceIndex,
    diagnostics,
    "background",
  );
  const foregroundDraft = resolveLineRelativeTiming(
    rawForegroundDraft,
    lineBeginMs,
  );
  const foregroundPronunciationDraft = resolveLineRelativeTiming(
    rawForegroundPronunciationDraft,
    lineBeginMs,
  );
  const backgroundDraft = resolveLineRelativeTiming(
    rawBackgroundDraft,
    lineBeginMs,
  );
  const backgroundPronunciationDraft = resolveLineRelativeTiming(
    rawBackgroundPronunciationDraft,
    lineBeginMs,
  );

  return {
    foreground: materializeTrack(foregroundDraft, lineId, "foreground"),
    ...(hasTrackContent(foregroundPronunciationDraft)
      ? {
          foregroundPronunciation: materializeTrack(
            foregroundPronunciationDraft,
            lineId,
            "foreground-pronunciation",
          ),
        }
      : {}),
    ...(hasTrackContent(backgroundDraft)
      ? {
          background: materializeTrack(
            backgroundDraft,
            lineId,
            "background",
          ),
        }
      : {}),
    ...(hasTrackContent(backgroundPronunciationDraft)
      ? {
          backgroundPronunciation: materializeTrack(
            backgroundPronunciationDraft,
            lineId,
            "background-pronunciation",
          ),
        }
      : {}),
  };
}

/** Applies Apple metadata transliteration as pronunciation tracks for one line. */
export function applyMetadataPronunciationTracks(
  tracks: LyricTracks,
  root: Element,
  declaredLanguage: string | null,
  lineId: string,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
  timeExpressionOptions: TimeExpressionOptions = {},
  lineBeginMs: number | null = null,
): LyricTracks {
  const foregroundSource = trackToDraft(tracks.foreground);
  const rawForeground = withDeclaredLanguage(
    parseForegroundTrackDraft(
      root,
      lineId,
      sourceIndex,
      diagnostics,
      timeExpressionOptions,
    ),
    declaredLanguage,
  );
  const foreground = resolveLineRelativeTiming(
    projectPronunciationDraftTiming(
      rawForeground,
      foregroundSource,
      lineId,
      sourceIndex,
      diagnostics,
      "foreground",
    ),
    lineBeginMs,
  );

  const rawBackground = withDeclaredLanguage(
    parseBackgroundTrackDraft(
      root,
      lineId,
      sourceIndex,
      diagnostics,
      timeExpressionOptions,
    ),
    declaredLanguage,
  );
  const backgroundSource = tracks.background
    ? trackToDraft(tracks.background)
    : emptyTrackDraft();
  const background = resolveLineRelativeTiming(
    projectPronunciationDraftTiming(
      rawBackground,
      backgroundSource,
      lineId,
      sourceIndex,
      diagnostics,
      "background",
    ),
    lineBeginMs,
  );

  const foregroundPronunciation =
    !tracks.foregroundPronunciation && hasTrackContent(foreground)
      ? materializeTrack(foreground, lineId, "foreground-pronunciation")
      : null;
  const backgroundPronunciation =
    !tracks.backgroundPronunciation && hasTrackContent(background)
      ? materializeTrack(background, lineId, "background-pronunciation")
      : null;
  if (!foregroundPronunciation && !backgroundPronunciation) return tracks;
  return {
    ...tracks,
    ...(foregroundPronunciation ? { foregroundPronunciation } : {}),
    ...(backgroundPronunciation ? { backgroundPronunciation } : {}),
  };
}

function withDeclaredLanguage(
  draft: ParsedTrackDraft,
  declaredLanguage: string | null,
): ParsedTrackDraft {
  return declaredLanguage === null
    ? draft
    : { ...draft, declaredLanguage };
}

function emptyTrackDraft(): ParsedTrackDraft {
  return { text: "", declaredLanguage: null, words: [] };
}

function trackToDraft(track: LyricTrack): ParsedTrackDraft {
  return {
    text: track.text,
    declaredLanguage: track.language.declared,
    words: track.words.map((word) => ({
      text: word.text,
      begin: word.begin,
      end: word.end,
      spaceBefore: word.spaceBefore,
      joinKey: word.joinGroup?.id ?? null,
    })),
  };
}

function resolveLineRelativeTiming(
  track: ParsedTrackDraft,
  lineBeginMs: number | null,
): ParsedTrackDraft {
  if (lineBeginMs === null || lineBeginMs <= 0) return track;
  let changed = false;
  const words = track.words.map((word) => {
    const beginMs = word.begin.valueMs;
    const endMs = word.end.valueMs;
    if (
      beginMs === null ||
      beginMs >= lineBeginMs ||
      (endMs !== null && endMs > lineBeginMs)
    ) {
      return word;
    }
    changed = true;
    return {
      ...word,
      begin: { ...word.begin, valueMs: beginMs + lineBeginMs },
      end: endMs === null
        ? word.end
        : { ...word.end, valueMs: endMs + lineBeginMs },
    };
  });
  return changed ? { ...track, words } : track;
}

function projectPronunciationDraftTiming(
  pronunciation: ParsedTrackDraft,
  source: ParsedTrackDraft,
  lineId: string,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
  voice: "foreground" | "background",
): ParsedTrackDraft {
  if (
    pronunciation.words.length > 0 ||
    !pronunciation.text ||
    source.words.length === 0
  ) {
    return pronunciation;
  }
  const projected = projectPronunciationTiming(
    pronunciation.text,
    source.words.map((word) => ({
      text: word.text,
      beginMs: word.begin.valueMs,
      endMs: word.end.valueMs,
      spaceBefore: word.spaceBefore,
      joinKey: word.joinKey,
    })),
  );
  if (projected.length === 0) return pronunciation;
  diagnostics.push(
    createDiagnostic(
      "info",
      "TTML_PRONUNCIATION_TIMING_PROJECTED",
      `Untimed line-level ${voice} Japanese pronunciation was heuristically projected from kana anchors onto the authored lyric word timing.`,
      { lineId, sourceIndex },
    ),
  );
  return {
    ...pronunciation,
    words: Object.freeze(
      projected.map((word) => ({
        text: word.text,
        begin: knownTimestamp(word.beginMs, "derived"),
        end: knownTimestamp(word.endMs, "derived"),
        spaceBefore: word.spaceBefore,
        joinKey: null,
      })),
    ),
  };
}

export function parseForegroundTrackDraft(
  root: Element,
  lineId: string,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
  timeExpressionOptions: TimeExpressionOptions = {},
): ParsedTrackDraft {
  const text = normalizeText(
    collectTextExcludingRoles(root, ALL_SECONDARY_ROLES),
  );
  const words = parseTimedChildren(
    root,
    lineId,
    sourceIndex,
    diagnostics,
    "foreground",
    timeExpressionOptions,
  );
  return {
    text: text || wordsToText(words),
    declaredLanguage: getInheritedXmlLanguage(root),
    words,
  };
}

function parseBackgroundTrackDraft(
  root: Element,
  lineId: string,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
  timeExpressionOptions: TimeExpressionOptions,
): ParsedTrackDraft {
  const groups = collectRoleElements(root, BACKGROUND_ROLES).filter(
    (element) => !hasAncestorWithRole(element, root, BACKGROUND_ROLES),
  );
  const drafts: WordDraft[] = [];
  const texts: string[] = [];
  let declaredLanguage: string | null = null;

  groups.forEach((group, groupIndex) => {
    declaredLanguage ??= getInheritedXmlLanguage(group);
    const groupText = stripOuterParentheses(
      normalizeText(
        collectTextExcludingRoles(
          group,
          new Set([
            ...PRONUNCIATION_ROLES,
            ...BACKGROUND_PRONUNCIATION_ROLES,
            ...TRANSLATION_ROLES,
          ]),
        ),
      ),
    );
    if (groupText) texts.push(groupText);
    const groupWords = parseTimedChildren(
      group,
      lineId,
      sourceIndex,
      diagnostics,
      `background-${groupIndex}`,
      timeExpressionOptions,
    );
    const fallback = groupWords.length
      ? groupWords
      : parseTimedElementFallback(
          group,
          lineId,
          sourceIndex,
          diagnostics,
          `background-${groupIndex}`,
          timeExpressionOptions,
        );
    const stripped = stripOuterParenthesesFromWords(fallback);
    stripped.forEach((word, wordIndex) => {
      drafts.push({
        ...word,
        spaceBefore:
          drafts.length > 0 && wordIndex === 0 ? true : word.spaceBefore,
      });
    });
  });

  return {
    text: texts.join(" ") || wordsToText(drafts),
    declaredLanguage,
    words: drafts,
  };
}

function parsePronunciationTrackDraft(
  root: Element,
  lineId: string,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
  background: boolean,
  timeExpressionOptions: TimeExpressionOptions,
): ParsedTrackDraft {
  const directRoles = background
    ? BACKGROUND_PRONUNCIATION_ROLES
    : PRONUNCIATION_ROLES;
  const roleElements = [
    ...collectRoleElements(root, directRoles),
    ...(background ? collectRoleElements(root, PRONUNCIATION_ROLES) : []),
  ].filter((element, index, all) => {
    if (all.indexOf(element) !== index) return false;
    const insideBackground = hasAncestorWithRole(
      element,
      root,
      BACKGROUND_ROLES,
    );
    return background ? insideBackground || BACKGROUND_PRONUNCIATION_ROLES.has(getTtmlRole(element) ?? "") : !insideBackground;
  });

  const drafts: WordDraft[] = [];
  const texts: string[] = [];
  let declaredLanguage: string | null = null;
  const trackKey = background
    ? "background-pronunciation"
    : "foreground-pronunciation";

  roleElements.forEach((group, groupIndex) => {
    declaredLanguage ??= getInheritedXmlLanguageWithin(group, root);
    const text = normalizeText(
      collectTextExcludingRoles(group, TRANSLATION_ROLES),
    );
    if (text) texts.push(text);
    const groupWords = parseTimedChildren(
      group,
      lineId,
      sourceIndex,
      diagnostics,
      `${trackKey}-${groupIndex}`,
      timeExpressionOptions,
    );
    const fallback = groupWords.length
      ? groupWords
      : parseTimedElementFallback(
          group,
          lineId,
          sourceIndex,
          diagnostics,
          `${trackKey}-${groupIndex}`,
          timeExpressionOptions,
        );
    fallback.forEach((word, wordIndex) => {
      drafts.push({
        ...word,
        spaceBefore:
          drafts.length > 0 && wordIndex === 0 ? true : word.spaceBefore,
      });
    });
  });

  return {
    text: texts.join(" ") || wordsToText(drafts),
    declaredLanguage,
    words: drafts,
  };
}

function parseTimedChildren(
  parent: Element,
  lineId: string,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
  joinPrefix: string,
  timeExpressionOptions: TimeExpressionOptions,
): readonly WordDraft[] {
  const drafts: Array<Omit<WordDraft, "joinKey">> = [];
  const runs: number[][] = [];
  let currentRun: number[] = [];
  let pendingSpace = false;

  const flushRun = (): void => {
    if (currentRun.length > 0) runs.push(currentRun);
    currentRun = [];
  };

  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) {
      if (/\s/u.test(node.nodeValue ?? "")) {
        pendingSpace = drafts.length > 0;
        flushRun();
      } else if ((node.nodeValue ?? "").length > 0) {
        flushRun();
      }
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (element.localName !== "span" || getTtmlRole(element)) {
      flushRun();
      continue;
    }
    if (!hasTimingAttribute(element)) {
      flushRun();
      continue;
    }

    const text = normalizeText(element.textContent);
    if (!text) {
      flushRun();
      continue;
    }
    const timing = parseElementTiming(element, {
      kind: "word",
      diagnostics,
      lineId,
      sourceIndex,
      timeExpressionOptions,
    });
    const draftIndex = drafts.length;
    drafts.push({
      text,
      begin: timing.begin,
      end: timing.end,
      spaceBefore: drafts.length > 0 && pendingSpace,
    });
    currentRun.push(draftIndex);
    pendingSpace = false;
  }
  flushRun();

  const joinKeys = new Map<number, string>();
  let joinIndex = 0;
  for (const run of runs) {
    if (run.length <= 1) continue;
    const joinKey = `${joinPrefix}-${joinIndex}`;
    run.forEach((wordIndex) => joinKeys.set(wordIndex, joinKey));
    joinIndex += 1;
  }

  return drafts.map((draft, wordIndex) => ({
    ...draft,
    joinKey: joinKeys.get(wordIndex) ?? null,
  }));
}

function parseTimedElementFallback(
  element: Element,
  lineId: string,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
  joinPrefix: string,
  timeExpressionOptions: TimeExpressionOptions,
): readonly WordDraft[] {
  if (!hasTimingAttribute(element)) return [];
  const text = normalizeText(
    Array.from(element.childNodes)
      .map((child) => collectTextExcludingRoles(child, ALL_SECONDARY_ROLES))
      .join(""),
  );
  if (!text) return [];
  const timing = parseElementTiming(element, {
    kind: "word",
    diagnostics,
    lineId,
    sourceIndex,
    timeExpressionOptions,
  });
  return [
    {
      text,
      begin: timing.begin,
      end: timing.end,
      spaceBefore: false,
      joinKey: `${joinPrefix}-fallback`,
    },
  ];
}

function hasTimingAttribute(element: Element): boolean {
  return (
    element.hasAttribute("begin") ||
    element.hasAttribute("end") ||
    element.hasAttribute("dur")
  );
}

function stripOuterParenthesesFromWords(
  words: readonly WordDraft[],
): readonly WordDraft[] {
  if (words.length === 0) return words;
  const first = words[0];
  const last = words[words.length - 1];
  if (!first || !last) return words;
  const pair = matchingOuterPair(first.text, last.text);
  if (!pair) return words;
  const next = words.map((word) => ({ ...word }));
  const firstDraft = next[0];
  const lastDraft = next[next.length - 1];
  if (!firstDraft || !lastDraft) return words;
  if (next.length === 1) {
    next[0] = { ...firstDraft, text: firstDraft.text.slice(1, -1) };
    return next.filter((word) => word.text.length > 0);
  }
  next[0] = { ...firstDraft, text: firstDraft.text.slice(1) };
  next[next.length - 1] = {
    ...lastDraft,
    text: lastDraft.text.slice(0, -1),
  };
  return next.filter((word) => word.text.length > 0);
}

export function stripOuterParentheses(text: string): string {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  const pair = matchingOuterPair(normalized, normalized);
  return pair ? normalizeText(normalized.slice(1, -1)) : normalized;
}

function matchingOuterPair(
  firstText: string,
  lastText: string,
): "ascii" | "fullwidth" | null {
  if (firstText.startsWith("(") && lastText.endsWith(")")) return "ascii";
  if (firstText.startsWith("（") && lastText.endsWith("）")) {
    return "fullwidth";
  }
  return null;
}

function wordsToText(words: readonly Pick<WordDraft, "text" | "spaceBefore">[]): string {
  return words
    .map((word, index) => `${index > 0 && word.spaceBefore ? " " : ""}${word.text}`)
    .join("");
}

function hasTrackContent(track: ParsedTrackDraft): boolean {
  return track.text.length > 0 || track.words.length > 0;
}

export function materializeTrack(
  draft: ParsedTrackDraft,
  lineId: string,
  trackKey: string,
  contextualLanguage?: string | null,
): LyricTrack {
  const joinMembers = new Map<string, number[]>();
  draft.words.forEach((word, index) => {
    if (!word.joinKey) return;
    const members = joinMembers.get(word.joinKey) ?? [];
    members.push(index);
    joinMembers.set(word.joinKey, members);
  });
  const joinPositions = new Map<number, { id: string; index: number; count: number }>();
  for (const [key, members] of joinMembers) {
    if (members.length <= 1) continue;
    members.forEach((wordIndex, index) => {
      joinPositions.set(wordIndex, {
        id: `${lineId}:${trackKey}:join-${key}`,
        index,
        count: members.length,
      });
    });
  }

  const words: LyricWord[] = draft.words.map((word, index) => ({
    id: `${lineId}:${trackKey}:word-${index}`,
    text: word.text,
    begin: word.begin,
    end: word.end,
    spaceBefore: word.spaceBefore,
    ...(joinPositions.has(index)
      ? { joinGroup: joinPositions.get(index) as NonNullable<LyricWord["joinGroup"]> }
      : {}),
  }));

  return {
    text: draft.text || wordsToText(words),
    language: inferLyricLanguage(
      draft.text || wordsToText(words),
      draft.declaredLanguage,
      contextualLanguage,
    ),
    words,
  };
}

export function withContextualTrackLanguage(
  track: LyricTrack,
  contextualLanguage: string | null,
): LyricTrack {
  return {
    ...track,
    language: inferLyricLanguage(
      track.text,
      track.language.declared,
      contextualLanguage,
    ),
  };
}

export function withSecondaryTrackLanguage(
  track: LyricTrack,
  preferredLanguage: string | null,
): LyricTrack {
  return {
    ...track,
    language: inferSecondaryLyricLanguage(
      track.text,
      track.language.declared,
      preferredLanguage,
      "pronunciation",
    ),
  };
}

export { inferLyricLanguage, normalizeLanguageTag, primaryLanguage };
