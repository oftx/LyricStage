import type { LyricText } from "../../domain/types.js";
import { inferSecondaryLyricLanguage } from "../../domain/language.js";
import type { ParseDiagnostic } from "../types.js";
import {
  BACKGROUND_ROLES,
  normalizeLanguageTag,
  primaryLanguage,
  stripOuterParentheses,
  TRANSLATION_ROLES,
} from "./tracks.js";
import {
  collectRoleElements,
  collectTextExcludingRoles,
  createDiagnostic,
  descendantElements,
  directChildElements,
  getInheritedXmlLanguageWithin,
  getTtmlRole,
  hasAncestorWithRole,
  ITUNES_TTML_NAMESPACE,
  normalizeText,
} from "./dom.js";

export type MetadataTranslationType = "replacement" | "subtitle";

export interface MetadataTextEntry {
  readonly targetId: string;
  readonly type: MetadataTranslationType;
  readonly language: string | null;
  readonly element: Element;
  readonly metadataIndex: number;
}

export interface MetadataPronunciationEntry {
  readonly targetId: string;
  readonly language: string | null;
  readonly element: Element;
  readonly metadataIndex: number;
}

export interface TtmlMetadataIndex {
  readonly replacementsByTargetId: ReadonlyMap<
    string,
    readonly MetadataTextEntry[]
  >;
  readonly subtitlesByTargetId: ReadonlyMap<
    string,
    readonly MetadataTextEntry[]
  >;
  readonly pronunciationsByTargetId: ReadonlyMap<
    string,
    readonly MetadataPronunciationEntry[]
  >;
}

export interface TranslationDraft {
  readonly foreground: LyricText | null;
  readonly background: LyricText | null;
}

function metadataLanguageBoundary(element: Element): Element | null {
  let current = element.parentElement;
  while (current) {
    if (
      current.localName === "iTunesMetadata" ||
      current.localName === "metadata"
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return element.parentElement;
}

export function parseTtmlMetadata(
  document: XMLDocument,
  diagnostics: ParseDiagnostic[],
): TtmlMetadataIndex {
  const replacements = new Map<string, MetadataTextEntry[]>();
  const subtitles = new Map<string, MetadataTextEntry[]>();
  const pronunciations = new Map<string, MetadataPronunciationEntry[]>();
  let metadataIndex = 0;

  for (const translation of descendantElements(
    document,
    "translation",
    [ITUNES_TTML_NAMESPACE, ""],
  )) {
    const rawType = normalizeText(translation.getAttribute("type")).toLowerCase();
    if (
      rawType !== "" &&
      rawType !== "replacement" &&
      rawType !== "subtitle"
    ) {
      diagnostics.push(
        createDiagnostic(
          "info",
          "TTML_METADATA_TRANSLATION_TYPE_UNSUPPORTED",
          rawType
            ? `Metadata translation type "${rawType}" was ignored.`
            : "Metadata translation without a type was treated as a subtitle.",
        ),
      );
      continue;
    }
    if (!rawType) {
      diagnostics.push(
        createDiagnostic(
          "info",
          "TTML_METADATA_TRANSLATION_TYPE_DEFAULTED",
          "Metadata translation without a type was treated as a subtitle.",
        ),
      );
    }
    const type: MetadataTranslationType = rawType || "subtitle";
    const metadataBoundary = metadataLanguageBoundary(translation);
    const language = normalizeLanguageTag(
      metadataBoundary
        ? getInheritedXmlLanguageWithin(translation, metadataBoundary)
        : null,
    );

    for (const textElement of directChildElements(translation, "text")) {
      const targetId = normalizeText(textElement.getAttribute("for"));
      if (!targetId) {
        diagnostics.push(
          createDiagnostic(
            "warning",
            "TTML_METADATA_TARGET_MISSING",
            "A metadata translation text has no target line id and was ignored.",
          ),
        );
        continue;
      }
      const entry: MetadataTextEntry = {
        targetId,
        type,
        language:
          normalizeLanguageTag(
            metadataBoundary
              ? getInheritedXmlLanguageWithin(textElement, metadataBoundary)
              : null,
          ) ?? language,
        element: textElement,
        metadataIndex,
      };
      metadataIndex += 1;
      const targetMap = type === "replacement" ? replacements : subtitles;
      const entries = targetMap.get(targetId) ?? [];
      entries.push(entry);
      targetMap.set(targetId, entries);
    }
  }

  for (const transliteration of descendantElements(
    document,
    "transliteration",
    [ITUNES_TTML_NAMESPACE, ""],
  )) {
    const metadataBoundary = metadataLanguageBoundary(transliteration);
    const language = normalizeLanguageTag(
      metadataBoundary
        ? getInheritedXmlLanguageWithin(transliteration, metadataBoundary)
        : null,
    );
    for (const textElement of directChildElements(transliteration, "text")) {
      const targetId = normalizeText(textElement.getAttribute("for"));
      if (!targetId) {
        diagnostics.push(
          createDiagnostic(
            "warning",
            "TTML_METADATA_PRONUNCIATION_TARGET_MISSING",
            "A metadata transliteration text has no target line id and was ignored.",
          ),
        );
        continue;
      }
      const entry: MetadataPronunciationEntry = {
        targetId,
        language:
          normalizeLanguageTag(
            metadataBoundary
              ? getInheritedXmlLanguageWithin(textElement, metadataBoundary)
              : null,
          ) ?? language,
        element: textElement,
        metadataIndex,
      };
      metadataIndex += 1;
      const entries = pronunciations.get(targetId) ?? [];
      entries.push(entry);
      pronunciations.set(targetId, entries);
    }
  }

  return {
    replacementsByTargetId: replacements,
    subtitlesByTargetId: subtitles,
    pronunciationsByTargetId: pronunciations,
  };
}

export function selectMetadataReplacement(
  entries: readonly MetadataTextEntry[] | undefined,
  preferredLanguages: readonly string[],
  sourceLanguage: string | null,
): MetadataTextEntry | null {
  if (!entries?.length) return null;
  const preferred = selectByPreferredLanguage(entries, preferredLanguages);
  if (preferred) return preferred;

  const sourcePrimary = primaryLanguage(sourceLanguage);
  if (!sourcePrimary) return null;
  return (
    entries.find(
      (entry) => primaryLanguage(entry.language) === sourcePrimary,
    ) ?? null
  );
}

export function selectMetadataSubtitle(
  entries: readonly MetadataTextEntry[] | undefined,
  preferredLanguages: readonly string[],
): MetadataTextEntry | null {
  if (!entries?.length) return null;
  return selectByPreferredLanguage(entries, preferredLanguages) ?? entries[0] ?? null;
}

export function selectMetadataPronunciation(
  entries: readonly MetadataPronunciationEntry[] | undefined,
  preferredLanguages: readonly string[],
  sourceLanguage: string | null,
): MetadataPronunciationEntry | null {
  if (!entries?.length) return null;
  const preferred = selectByPreferredLanguage(entries, preferredLanguages);
  if (preferred) return preferred;

  const sourcePrimary = primaryLanguage(sourceLanguage);
  return (
    entries.find(
      (entry) => primaryLanguage(entry.language) === sourcePrimary,
    ) ?? entries[0] ?? null
  );
}

function selectByPreferredLanguage<
  Entry extends { readonly language: string | null },
>(
  entries: readonly Entry[],
  preferredLanguages: readonly string[],
): Entry | null {
  const preferred = preferredLanguages
    .map(normalizeLanguageTag)
    .filter((language): language is string => language !== null);
  for (const language of preferred) {
    const exact = entries.find(
      (entry) =>
        normalizeLanguageTag(entry.language)?.toLowerCase() ===
        language.toLowerCase(),
    );
    if (exact) return exact;
  }
  for (const language of preferred) {
    const primary = primaryLanguage(language);
    const match = entries.find(
      (entry) => primaryLanguage(entry.language) === primary,
    );
    if (match) return match;
  }
  return null;
}

export function parseMetadataSubtitle(
  entry: MetadataTextEntry | null,
  contextualLanguage: string | null,
): TranslationDraft {
  if (!entry) return { foreground: null, background: null };
  const foregroundText = normalizeText(
    collectTextExcludingRoles(entry.element, BACKGROUND_ROLES),
  );
  const backgroundText = collectBackgroundGroupTexts(entry.element).join(" ");
  return {
    foreground: foregroundText
      ? {
          text: foregroundText,
          language: inferSecondaryLyricLanguage(
            foregroundText,
            entry.language,
            contextualLanguage,
            "translation",
          ),
        }
      : null,
    background: backgroundText
      ? {
          text: backgroundText,
          language: inferSecondaryLyricLanguage(
            backgroundText,
            entry.language,
            contextualLanguage,
            "translation",
          ),
        }
      : null,
  };
}

export function parseInlineTranslation(
  paragraph: Element,
  contextualLanguage: string | null,
): TranslationDraft {
  const translationElements = collectRoleElements(
    paragraph,
    TRANSLATION_ROLES,
  ).filter(
    (element) =>
      !hasAncestorWithRole(element, paragraph, TRANSLATION_ROLES),
  );
  if (!translationElements.length) {
    return { foreground: null, background: null };
  }

  const foregroundParts: string[] = [];
  const backgroundParts: string[] = [];
  let foregroundLanguage: string | null = null;
  let backgroundLanguage: string | null = null;

  for (const element of translationElements) {
    const language = normalizeLanguageTag(
      getInheritedXmlLanguageWithin(element, paragraph),
    );
    const insideBackground = hasAncestorWithRole(
      element,
      paragraph,
      BACKGROUND_ROLES,
    );
    const directText = normalizeText(
      collectTextExcludingRoles(element, BACKGROUND_ROLES),
    );
    if (directText) {
      if (insideBackground) {
        backgroundParts.push(stripOuterParentheses(directText));
        backgroundLanguage ??= language;
      } else {
        foregroundParts.push(directText);
        foregroundLanguage ??= language;
      }
    }
    const backgroundTexts = insideBackground
      ? []
      : collectBackgroundGroupTexts(element);
    if (backgroundTexts.length) {
      backgroundParts.push(...backgroundTexts);
      backgroundLanguage ??= language;
    }
  }

  const foregroundText = foregroundParts.join(" ");
  const backgroundText = backgroundParts.join(" ");
  return {
    foreground: foregroundText
      ? {
          text: foregroundText,
          language: inferSecondaryLyricLanguage(
            foregroundText,
            foregroundLanguage,
            contextualLanguage,
            "translation",
          ),
        }
      : null,
    background: backgroundText
      ? {
          text: backgroundText,
          language: inferSecondaryLyricLanguage(
            backgroundText,
            backgroundLanguage,
            contextualLanguage,
            "translation",
          ),
        }
      : null,
  };
}

function collectBackgroundGroupTexts(root: Element): string[] {
  return collectRoleElements(root, BACKGROUND_ROLES)
    .filter(
      (element) => !hasAncestorWithRole(element, root, BACKGROUND_ROLES),
    )
    .map((element) => {
      const nestedRoles = new Set<string>();
      for (const child of Array.from(element.getElementsByTagNameNS("*", "span"))) {
        const role = getTtmlRole(child);
        if (role && role !== "x-bg") nestedRoles.add(role);
      }
      return stripOuterParentheses(
        normalizeText(collectTextExcludingRoles(element, nestedRoles)),
      );
    })
    .filter(Boolean);
}
