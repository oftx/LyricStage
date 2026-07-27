import type {
  LyricAgent,
  LyricDocument,
  LyricDocumentSource,
  LyricLine,
  LyricLineType,
  LyricTimestamp,
  LyricTracks,
  NonMonotonicLineOrderSample,
  TextLyricLine,
} from "../../domain/types.js";
import { createDocumentId as createCanonicalDocumentId } from "../../domain/ids.js";
import type {
  LyricsParseInput,
  LyricsParseResult,
  LyricsParser,
  ParseDiagnostic,
} from "../types.js";
import {
  knownTimestamp,
  type TimeExpressionOptions,
  unknownTimestamp,
} from "../time.js";
import {
  createDiagnostic,
  descendantElements,
  getAttribute,
  getInheritedTtmlAgent,
  getInheritedXmlLanguage,
  getItunesKey,
  getXmlId,
  ITUNES_TTML_NAMESPACE,
  normalizeText,
  parseXmlDocument,
  TTML_METADATA_NAMESPACE,
  TTML_NAMESPACE,
  TTML_PARAMETER_NAMESPACE,
  type XmlDocumentReader,
} from "./dom.js";
import {
  parseInlineTranslation,
  parseMetadataSubtitle,
  parseTtmlMetadata,
  selectMetadataPronunciation,
  selectMetadataReplacement,
  selectMetadataSubtitle,
  type MetadataTextEntry,
} from "./metadata.js";
import {
  applyMetadataPronunciationTracks,
  inferLyricLanguage,
  materializeTrack,
  normalizeLanguageTag,
  parseElementTiming,
  parseForegroundTrackDraft,
  parseTtmlTimeExpression,
  parseTtmlTracks,
  withContextualTrackLanguage,
  withSecondaryTrackLanguage,
} from "./tracks.js";

interface ParsedLineDraft {
  readonly id: string;
  readonly authoredId: string;
  readonly index: number;
  readonly sourceIndex: number;
  readonly sectionIndex: number | null;
  readonly begin: LyricTimestamp;
  readonly end: LyricTimestamp;
  readonly agentId: string;
  readonly type: Exclude<LyricLineType, "instrumental">;
  readonly tracks: LyricTracks;
  readonly paragraph: Element;
  readonly subtitle: MetadataTextEntry | null;
  readonly replacementLanguage: string | null;
}

const DEFAULT_AGENT_ID = "default";

export interface TtmlParserOptions {
  readonly xmlReader?: XmlDocumentReader;
}

export function createTtmlParser(
  options: TtmlParserOptions = {},
): LyricsParser {
  return Object.freeze({
    id: "ttml",
    parse: (input: LyricsParseInput) => parseTtml(input, options),
  });
}

export const ttmlParser: LyricsParser = createTtmlParser();

export function parseTtml(
  input: LyricsParseInput,
  options: TtmlParserOptions = {},
): LyricsParseResult {
  try {
    return parseTtmlUnsafe(input, options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown parser failure";
    return failure(
      "TTML_PARSE_FAILED",
      `The TTML document could not be parsed: ${detail}`,
    );
  }
}

function parseTtmlUnsafe(
  input: LyricsParseInput,
  options: TtmlParserOptions,
): LyricsParseResult {
  if (input.formatHint !== undefined && input.formatHint !== "ttml") {
    return failure(
      "TTML_FORMAT_HINT_MISMATCH",
      `The TTML parser cannot parse the "${input.formatHint}" format hint.`,
    );
  }

  const xml = parseXmlDocument(input.text, options.xmlReader);
  if (!xml.ok) return failure(xml.code, xml.message);
  const { document } = xml;
  const root = document.documentElement;
  if (!root || root.localName !== "tt") {
    return failure(
      "TTML_ROOT_INVALID",
      "The XML document root is not a TTML <tt> element.",
    );
  }

  const diagnostics: ParseDiagnostic[] = [];
  if (root.namespaceURI !== TTML_NAMESPACE) {
    diagnostics.push(
      createDiagnostic(
        "warning",
        "TTML_ROOT_NAMESPACE_UNEXPECTED",
        "The <tt> root uses an unexpected namespace; local-name fallback was used.",
      ),
    );
  }
  const contentNamespaces = getContentNamespaces(root);

  const declaredDocumentLanguage = normalizeLanguageTag(
    getInheritedXmlLanguage(root),
  );
  if (!declaredDocumentLanguage) {
    diagnostics.push(
      createDiagnostic(
        "info",
        "TTML_DOCUMENT_LANGUAGE_MISSING",
        "The TTML document has no declared xml:lang.",
      ),
    );
  }

  const timingMode = normalizeText(
    getAttribute(
      root,
      ITUNES_TTML_NAMESPACE,
      "timing",
      "itunes:timing",
    ),
  ).toLowerCase();
  const timeExpressionOptions = parseTimingParameters(root, diagnostics);
  if (timingMode && timingMode !== "word" && timingMode !== "line") {
    diagnostics.push(
      createDiagnostic(
        "warning",
        "TTML_TIMING_MODE_UNSUPPORTED",
        `The iTunes timing mode "${timingMode}" is not recognized; line content determines its parsed type.`,
      ),
    );
  }

  const preferredLanguages = (input.preferredLanguages ?? [])
    .map(normalizeLanguageTag)
    .filter((language): language is string => language !== null);
  const metadata = parseTtmlMetadata(document, diagnostics);
  const agents = parseAgents(document, diagnostics);
  const sectionIndexes = createSectionIndex(document, contentNamespaces);
  const paragraphs = descendantElements(document, "p", contentNamespaces);
  const lineIdCounts = new Map<string, number>();
  const drafts: ParsedLineDraft[] = [];

  paragraphs.forEach((paragraph, sourceIndex) => {
    const authoredId =
      normalizeText(getItunesKey(paragraph)) ||
      normalizeText(getXmlId(paragraph)) ||
      `line-${sourceIndex + 1}`;
    const id = makeUniqueLineId(
      authoredId,
      lineIdCounts,
      sourceIndex,
      diagnostics,
    );
    const timing = parseElementTiming(paragraph, {
      kind: "line",
      diagnostics,
      lineId: id,
      sourceIndex,
      timeExpressionOptions,
    });
    const sourceLanguage = normalizeLanguageTag(
      getInheritedXmlLanguage(paragraph) ?? declaredDocumentLanguage,
    );
    const replacement = selectMetadataReplacement(
      metadata.replacementsByTargetId.get(authoredId),
      preferredLanguages,
      sourceLanguage,
    );
    let tracks = parseTtmlTracks(
      paragraph,
      id,
      sourceIndex,
      diagnostics,
      timeExpressionOptions,
      timing.begin.valueMs,
    );
    // Apple replacements are display substitutions. Untimed pronunciation must
    // inherit the authored vocal timing before that foreground text is swapped.
    const pronunciation = selectMetadataPronunciation(
      metadata.pronunciationsByTargetId.get(authoredId),
      preferredLanguages,
      sourceLanguage,
    );
    if (pronunciation) {
      const tracksWithPronunciation = applyMetadataPronunciationTracks(
        tracks,
        pronunciation.element,
        pronunciation.language,
        id,
        sourceIndex,
        diagnostics,
        timeExpressionOptions,
        timing.begin.valueMs,
      );
      if (tracksWithPronunciation !== tracks) {
        tracks = tracksWithPronunciation;
        diagnostics.push(
          createDiagnostic(
            "info",
            "TTML_METADATA_PRONUNCIATION_APPLIED",
            `A ${pronunciation.language ?? "language-neutral"} metadata transliteration was applied as pronunciation.`,
            { lineId: id, sourceIndex },
          ),
        );
      }
    }
    if (replacement) {
      const replacementDraft = parseForegroundTrackDraft(
        replacement.element,
        id,
        sourceIndex,
        diagnostics,
        timeExpressionOptions,
      );
      tracks = {
        ...tracks,
        foreground: materializeTrack(
          {
            ...replacementDraft,
            declaredLanguage:
              replacement.language ?? replacementDraft.declaredLanguage,
          },
          id,
          "foreground",
        ),
      };
      diagnostics.push(
        createDiagnostic(
          "info",
          "TTML_METADATA_REPLACEMENT_APPLIED",
          `A ${replacement.language ?? "language-neutral"} metadata replacement was applied to the foreground track.`,
          { lineId: id, sourceIndex },
        ),
      );
    }

    const agentId = resolveLineAgent(
      paragraph,
      agents,
      diagnostics,
      id,
      sourceIndex,
    );
    const section = nearestSection(paragraph, sectionIndexes);

    if (!hasLineContent(tracks)) {
      // Leading empties stay ignored; mid-document empty <p> become full-height
      // poem spacers (Apple unsynced / stanza breaks often use empty paragraphs).
      if (drafts.length === 0) {
        diagnostics.push(
          createDiagnostic(
            "info",
            "TTML_EMPTY_LINE_IGNORED",
            "A leading empty TTML paragraph was ignored.",
            { lineId: id, sourceIndex },
          ),
        );
        return;
      }
      diagnostics.push(
        createDiagnostic(
          "info",
          "TTML_EMPTY_LINE_PRESERVED",
          "An empty TTML paragraph was preserved as a full-height spacer row.",
          { lineId: id, sourceIndex },
        ),
      );
      drafts.push({
        id,
        authoredId,
        index: drafts.length,
        sourceIndex,
        sectionIndex: section,
        begin: timing.begin,
        end: timing.end,
        agentId,
        type: "static",
        tracks: {
          foreground: {
            text: "",
            language: tracks.foreground.language,
            words: [],
          },
        },
        paragraph,
        subtitle: null,
        replacementLanguage: null,
      });
      return;
    }

    const type = resolveLineType(timingMode, tracks);
    drafts.push({
      id,
      authoredId,
      index: drafts.length,
      sourceIndex,
      sectionIndex: section,
      begin: timing.begin,
      end: timing.end,
      agentId,
      type,
      tracks,
      paragraph,
      subtitle: selectMetadataSubtitle(
        metadata.subtitlesByTargetId.get(authoredId),
        preferredLanguages,
      ),
      replacementLanguage: replacement?.language ?? null,
    });
  });

  if (!drafts.length) {
    return failure(
      "TTML_NO_LYRIC_LINES",
      "The TTML document contains no non-empty lyric lines.",
      diagnostics,
    );
  }

  // Section spacers are for unsynced/pure-text poem layout only.
  // Timed line / karaoke TTML also uses <div> sections for structure, but the
  // native player does not insert blank rows there — only empty <p> (kept above)
  // and inter-line timing gaps. Always inserting section spacers put unexpected
  // blank rows into 晴天-style karaoke and line-timed tracks.
  const draftsWithSectionSpacers = isUnsyncedPureTextDraftSet(drafts)
    ? insertSectionBoundarySpacers(drafts, diagnostics)
    : drafts;

  const documentText = draftsWithSectionSpacers
    .map((draft) => draft.tracks.foreground.text)
    .filter(Boolean)
    .join("\n");
  const replacementDocumentLanguage =
    draftsWithSectionSpacers.find((draft) => draft.replacementLanguage)
      ?.replacementLanguage ?? null;
  const language = inferLyricLanguage(
    documentText,
    replacementDocumentLanguage ?? declaredDocumentLanguage,
  );
  const contextualLanguage = language.effective;
  const preferredSecondaryLanguage = preferredLanguages[0] ?? null;
  const lines: LyricLine[] = draftsWithSectionSpacers.map((draft) =>
    materializeLine(
      draft,
      contextualLanguage,
      preferredSecondaryLanguage,
    ),
  );
  const duration = resolveDocumentDuration(
    document,
    lines,
    input.mediaDurationMs,
    diagnostics,
    timeExpressionOptions,
    contentNamespaces,
  );
  reportLinesAfterDocumentDuration(lines, duration, diagnostics);
  const order = analyzeLineOrder(lines, diagnostics);
  const source: LyricDocumentSource = {
    format: "ttml",
    ...(input.sourceName === undefined ? {} : { name: input.sourceName }),
    adapterOrderPolicy: "preserve-source-vector",
    lineBeginOrderMonotonic: order.monotonic,
    nonMonotonicLineOrderSamples: order.samples,
  };
  const lyricDocument: LyricDocument = {
    id: createCanonicalDocumentId("ttml", input.sourceName, input.text),
    duration,
    language,
    agents: Array.from(agents.values()),
    lines,
    source,
  };

  return {
    ok: true,
    format: "ttml",
    confidence: "exact",
    document: lyricDocument,
    diagnostics,
  };
}

function getContentNamespaces(root: Element): readonly string[] {
  const rootNamespace = root.namespaceURI ?? "";
  if (rootNamespace === TTML_NAMESPACE) {
    return Object.freeze([TTML_NAMESPACE, ""]);
  }
  return Object.freeze(rootNamespace ? [rootNamespace, ""] : [""]);
}

function parseTimingParameters(
  root: Element,
  diagnostics: ParseDiagnostic[],
): TimeExpressionOptions {
  const readPositive = (name: string, fallback: number): number => {
    const raw = getAttribute(
      root,
      TTML_PARAMETER_NAMESPACE,
      name,
      `ttp:${name}`,
    );
    if (raw === null) return fallback;
    const value = Number(raw.trim());
    if (Number.isFinite(value) && value > 0) return value;
    diagnostics.push(
      createDiagnostic(
        "warning",
        `TTML_PARAMETER_${name.toUpperCase()}_INVALID`,
        `The TTML ${name} parameter is invalid; the default was used.`,
      ),
    );
    return fallback;
  };

  const baseFrameRate = readPositive("frameRate", 30);
  const subFrameRate = readPositive("subFrameRate", 1);
  const multiplierRaw = getAttribute(
    root,
    TTML_PARAMETER_NAMESPACE,
    "frameRateMultiplier",
    "ttp:frameRateMultiplier",
  );
  let multiplier = 1;
  if (multiplierRaw !== null) {
    const parts = multiplierRaw.trim().split(/\s+/u).map(Number);
    const numerator = parts[0];
    const denominator = parts[1];
    if (
      parts.length === 2 &&
      numerator !== undefined &&
      denominator !== undefined &&
      Number.isFinite(numerator) &&
      Number.isFinite(denominator) &&
      numerator > 0 &&
      denominator > 0
    ) {
      multiplier = numerator / denominator;
    } else {
      diagnostics.push(
        createDiagnostic(
          "warning",
          "TTML_PARAMETER_FRAMERATEMULTIPLIER_INVALID",
          "The TTML frameRateMultiplier is invalid; 1 1 was used.",
        ),
      );
    }
  }

  const frameRate = baseFrameRate * multiplier;
  const tickRate = readPositive("tickRate", frameRate * subFrameRate);
  return Object.freeze({ frameRate, subFrameRate, tickRate });
}

function parseAgents(
  document: XMLDocument,
  diagnostics: ParseDiagnostic[],
): Map<string, LyricAgent> {
  const agents = new Map<string, LyricAgent>();
  for (const element of descendantElements(document, "agent", [
    TTML_METADATA_NAMESPACE,
    "",
  ])) {
    const id = normalizeText(getXmlId(element));
    if (!id) {
      diagnostics.push(
        createDiagnostic(
          "warning",
          "TTML_AGENT_ID_MISSING",
          "A TTML metadata agent without xml:id was ignored.",
        ),
      );
      continue;
    }
    if (agents.has(id)) {
      diagnostics.push(
        createDiagnostic(
          "warning",
          "TTML_AGENT_ID_DUPLICATE",
          `Duplicate TTML agent "${id}" was ignored after its first definition.`,
        ),
      );
      continue;
    }
    const rawType = normalizeText(element.getAttribute("type")).toLowerCase();
    const type =
      rawType === "other" || rawType === "group" || rawType === "person"
        ? rawType
        : "person";
    if (rawType && rawType !== type) {
      diagnostics.push(
        createDiagnostic(
          "warning",
          "TTML_AGENT_TYPE_UNSUPPORTED",
          `Agent "${id}" uses unsupported type "${rawType}" and was retained as person.`,
        ),
      );
    }
    agents.set(id, { id, type, alignment: "auto" });
  }
  return agents;
}

function resolveLineAgent(
  paragraph: Element,
  agents: Map<string, LyricAgent>,
  diagnostics: ParseDiagnostic[],
  lineId: string,
  sourceIndex: number,
): string {
  const inheritedAgentId = normalizeText(getInheritedTtmlAgent(paragraph));
  if (inheritedAgentId) {
    if (!agents.has(inheritedAgentId)) {
      agents.set(inheritedAgentId, {
        id: inheritedAgentId,
        type: "person",
        alignment: "auto",
      });
      diagnostics.push(
        createDiagnostic(
          "warning",
          "TTML_AGENT_REFERENCE_UNDECLARED",
          `Line agent "${inheritedAgentId}" has no metadata definition and was retained as person.`,
          { lineId, sourceIndex },
        ),
      );
    }
    return inheritedAgentId;
  }

  if (!agents.has(DEFAULT_AGENT_ID)) {
    agents.set(DEFAULT_AGENT_ID, {
      id: DEFAULT_AGENT_ID,
      type: "person",
      alignment: "auto",
    });
  }
  return DEFAULT_AGENT_ID;
}

function createSectionIndex(
  document: XMLDocument,
  contentNamespaces: readonly string[],
): ReadonlyMap<Element, number> {
  const sections = descendantElements(document, "div", contentNamespaces);
  return new Map(sections.map((section, index) => [section, index]));
}

function nearestSection(
  paragraph: Element,
  sectionIndexes: ReadonlyMap<Element, number>,
): number | null {
  let current = paragraph.parentElement;
  while (current) {
    const index = sectionIndexes.get(current);
    if (index !== undefined) return index;
    current = current.parentElement;
  }
  return null;
}

function makeUniqueLineId(
  authoredId: string,
  counts: Map<string, number>,
  sourceIndex: number,
  diagnostics: ParseDiagnostic[],
): string {
  const count = (counts.get(authoredId) ?? 0) + 1;
  counts.set(authoredId, count);
  if (count === 1) return authoredId;
  const id = `${authoredId}~${count}`;
  diagnostics.push(
    createDiagnostic(
      "warning",
      "TTML_LINE_ID_DUPLICATE",
      `Duplicate line id "${authoredId}" was made unique as "${id}".`,
      { lineId: id, sourceIndex },
    ),
  );
  return id;
}

function resolveLineType(
  timingMode: string,
  tracks: LyricTracks,
): ParsedLineDraft["type"] {
  if (timingMode === "line") return "line-timed";
  if (
    tracks.foreground.words.length > 0 ||
    (tracks.foregroundPronunciation?.words.length ?? 0) > 0 ||
    (tracks.background?.words.length ?? 0) > 0 ||
    (tracks.backgroundPronunciation?.words.length ?? 0) > 0
  ) {
    return "karaoke";
  }
  return timingMode === "word" ? "static" : "static";
}

function hasLineContent(tracks: LyricTracks): boolean {
  return Boolean(
    tracks.foreground.text.trim() ||
      tracks.foreground.words.length ||
      tracks.foregroundPronunciation?.text?.trim() ||
      tracks.background?.text?.trim() ||
      tracks.backgroundPronunciation?.text?.trim(),
  );
}

function isEmptyDraft(draft: ParsedLineDraft): boolean {
  return !hasLineContent(draft.tracks);
}

/** True when no content line has authored begin time (unsynced / pure text). */
function isUnsyncedPureTextDraftSet(
  drafts: readonly ParsedLineDraft[],
): boolean {
  return drafts.every(
    (draft) =>
      isEmptyDraft(draft)
      || draft.begin.valueMs === null
      || !Number.isFinite(draft.begin.valueMs),
  );
}

/**
 * Apple Music unsynced TTML groups verses in <div> sections. The native poem
 * UI shows a blank row between sections; the feed often has no empty <p>, only
 * a sectionIndex change. Synthesize a static empty spacer for pure-text only.
 */
function insertSectionBoundarySpacers(
  drafts: readonly ParsedLineDraft[],
  diagnostics: ParseDiagnostic[],
): ParsedLineDraft[] {
  const result: ParsedLineDraft[] = [];
  let previousSection: number | null = null;
  let spacerCount = 0;

  for (const draft of drafts) {
    const section = draft.sectionIndex;
    if (
      !isEmptyDraft(draft) &&
      previousSection !== null &&
      section !== null &&
      section !== previousSection
    ) {
      const last = result[result.length - 1];
      if (!last || !isEmptyDraft(last)) {
        spacerCount += 1;
        const spacerId = `${draft.id}~section-spacer`;
        result.push({
          id: spacerId,
          authoredId: spacerId,
          index: result.length,
          sourceIndex: draft.sourceIndex,
          sectionIndex: section,
          begin: unknownTimestamp(),
          end: unknownTimestamp(),
          agentId: draft.agentId,
          type: "static",
          tracks: {
            foreground: {
              text: "",
              language: draft.tracks.foreground.language,
              words: [],
            },
          },
          paragraph: draft.paragraph,
          subtitle: null,
          replacementLanguage: null,
        });
      }
    }

    result.push({
      ...draft,
      index: result.length,
    });
    if (section !== null) previousSection = section;
  }

  if (spacerCount > 0) {
    diagnostics.push(
      createDiagnostic(
        "info",
        "TTML_SECTION_SPACERS_INSERTED",
        `Inserted ${spacerCount} full-height empty row(s) at TTML section boundaries.`,
      ),
    );
  }

  return result;
}

function materializeLine(
  draft: ParsedLineDraft,
  contextualLanguage: string,
  preferredSecondaryLanguage: string | null,
): TextLyricLine {
  const tracks: LyricTracks = {
    foreground: withContextualTrackLanguage(
      draft.tracks.foreground,
      contextualLanguage,
    ),
    ...(draft.tracks.foregroundPronunciation
      ? {
          foregroundPronunciation: withSecondaryTrackLanguage(
            draft.tracks.foregroundPronunciation,
            preferredSecondaryLanguage,
          ),
        }
      : {}),
    ...(draft.tracks.background
      ? {
          background: withContextualTrackLanguage(
            draft.tracks.background,
            contextualLanguage,
          ),
        }
      : {}),
    ...(draft.tracks.backgroundPronunciation
      ? {
          backgroundPronunciation: withSecondaryTrackLanguage(
            draft.tracks.backgroundPronunciation,
            preferredSecondaryLanguage,
          ),
        }
      : {}),
  };
  const inline = parseInlineTranslation(
    draft.paragraph,
    preferredSecondaryLanguage,
  );
  const metadata = parseMetadataSubtitle(
    draft.subtitle,
    preferredSecondaryLanguage,
  );
  const translation = inline.foreground ?? metadata.foreground;
  const backgroundTranslation = inline.background ?? metadata.background;
  return {
    id: draft.id,
    index: draft.index,
    sourceIndex: draft.sourceIndex,
    sectionIndex: draft.sectionIndex,
    begin: draft.begin,
    end: draft.end,
    agentId: draft.agentId,
    type: draft.type,
    tracks,
    ...(translation ? { translation } : {}),
    ...(backgroundTranslation ? { backgroundTranslation } : {}),
  };
}

function resolveDocumentDuration(
  document: XMLDocument,
  lines: readonly LyricLine[],
  mediaDurationMs: number | undefined,
  diagnostics: ParseDiagnostic[],
  timeExpressionOptions: TimeExpressionOptions,
  contentNamespaces: readonly string[],
): LyricTimestamp {
  const body = descendantElements(document, "body", contentNamespaces)[0];
  const root = document.documentElement;
  const authored = body ?? root;
  const durationRaw = authored.getAttribute("dur");
  if (durationRaw !== null) {
    const durationMs = parseTtmlTimeExpression(
      durationRaw,
      timeExpressionOptions,
    );
    if (durationMs !== null && durationMs >= 0) {
      return knownTimestamp(durationMs);
    }
    diagnostics.push(
      createDiagnostic(
        "warning",
        "TTML_DOCUMENT_DURATION_INVALID",
        "The authored document duration is invalid and was not used.",
      ),
    );
  }

  const endRaw = authored.getAttribute("end");
  if (endRaw !== null) {
    const endMs = parseTtmlTimeExpression(endRaw, timeExpressionOptions);
    if (endMs !== null && endMs >= 0) return knownTimestamp(endMs);
    diagnostics.push(
      createDiagnostic(
        "warning",
        "TTML_DOCUMENT_END_INVALID",
        "The authored document end is invalid and was not used.",
      ),
    );
  }

  if (
    mediaDurationMs !== undefined &&
    Number.isFinite(mediaDurationMs) &&
    mediaDurationMs >= 0
  ) {
    diagnostics.push(
      createDiagnostic(
        "info",
        "TTML_DOCUMENT_DURATION_FROM_MEDIA",
        "The document duration was inferred from the host media duration.",
      ),
    );
    return knownTimestamp(mediaDurationMs, "media-duration-inferred");
  }

  const knownEnds = lines
    .map((line) => line.end.valueMs)
    .filter((value): value is number => value !== null);
  if (knownEnds.length) {
    diagnostics.push(
      createDiagnostic(
        "info",
        "TTML_DOCUMENT_DURATION_DERIVED_FROM_LINES",
        "The document duration was derived from the greatest authored line end.",
      ),
    );
    return knownTimestamp(Math.max(...knownEnds), "derived");
  }

  diagnostics.push(
    createDiagnostic(
      "warning",
      "TTML_DOCUMENT_DURATION_UNKNOWN",
      "The TTML document duration remains unknown.",
    ),
  );
  return unknownTimestamp();
}

function reportLinesAfterDocumentDuration(
  lines: readonly LyricLine[],
  duration: LyricTimestamp,
  diagnostics: ParseDiagnostic[],
): void {
  if (duration.valueMs === null) return;
  for (const line of lines) {
    if (line.end.valueMs === null || line.end.valueMs <= duration.valueMs) {
      continue;
    }
    diagnostics.push(
      createDiagnostic(
        "warning",
        "TTML_LINE_END_AFTER_DOCUMENT_DURATION",
        "The authored line end exceeds the document duration and was retained for normalization.",
        {
          lineId: line.id,
          ...(line.sourceIndex === null
            ? {}
            : { sourceIndex: line.sourceIndex }),
        },
      ),
    );
  }
}

function analyzeLineOrder(
  lines: readonly LyricLine[],
  diagnostics: ParseDiagnostic[],
): {
  readonly monotonic: boolean;
  readonly samples: readonly NonMonotonicLineOrderSample[];
} {
  const samples: NonMonotonicLineOrderSample[] = [];
  let previous: { readonly line: LyricLine; readonly beginMs: number } | null =
    null;
  for (const line of lines) {
    const beginMs = line.begin.valueMs;
    if (beginMs === null) continue;
    if (previous && beginMs < previous.beginMs) {
      const sample: NonMonotonicLineOrderSample = {
        previousLineId: previous.line.id,
        previousIndex: previous.line.index,
        previousBeginMs: previous.beginMs,
        currentLineId: line.id,
        currentIndex: line.index,
        currentBeginMs: beginMs,
      };
      samples.push(sample);
      diagnostics.push(
        createDiagnostic(
          "info",
          "TTML_LINE_BEGIN_ORDER_NON_MONOTONIC",
          "A line begins before the preceding source-order line; source order was preserved.",
          {
            lineId: line.id,
            ...(line.sourceIndex === null
              ? {}
              : { sourceIndex: line.sourceIndex }),
          },
        ),
      );
    }
    previous = { line, beginMs };
  }
  return { monotonic: samples.length === 0, samples };
}

function failure(
  code: string,
  message: string,
  diagnostics: readonly ParseDiagnostic[] = [],
): LyricsParseResult {
  const errorDiagnostic = createDiagnostic("error", code, message);
  return {
    ok: false,
    format: "ttml",
    confidence: "probable",
    error: { code, message },
    diagnostics: [...diagnostics, errorDiagnostic],
  };
}
