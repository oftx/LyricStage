import type { LyricLanguage } from "./types.js";

export const UNDETERMINED_LANGUAGE_TAG = "und";

export type LyricPrimaryScript = "latin" | "han" | "ja" | "ko" | "other";

export interface CreateLyricLanguageInput {
  readonly declared?: string | null;
  readonly inferred?: string | null;
  readonly fallback?: string | null;
}

export type LyricSecondaryTextRole = "translation" | "pronunciation";

const kanaPattern = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d]/u;
const hangulPattern = /[\uac00-\ud7af]/u;
const hanPattern = /[\u3400-\u9fff\uf900-\ufaff]/u;
const latinPattern = /[A-Za-z\u00c0-\u024f]/u;

// Deliberately small, high-signal sets. They distinguish Chinese variants
// without treating Japanese shinjitai such as \u56fd/\u5b66/\u4f1a as Simplified Chinese.
const simplifiedChineseHints = /[\u8fd9\u8bf4\u4e2a\u4eec\u5417\u4e48\u8ba9\u8fc7\u8fd8\u4ece\u7ed9\u5bf9\u8fb9\u4e1c\u4e50\u94c5\u7eb8\u9884\u5988]/u;
const traditionalChineseHints = /[\u9019\u8aaa\u500b\u5011\u55ce\u9ebc\u8b93\u904e\u9084\u5f9e\u7d66\u5c0d\u908a\u6771\u6a02\u925b\u7d19\u9810\u5abd]/u;

/** Canonicalizes a BCP 47 tag and returns null for an empty or invalid value. */
export function normalizeLanguageTag(
  languageTag: string | null | undefined,
): string | null {
  if (languageTag == null) return null;

  const candidate = languageTag.trim().replaceAll("_", "-");
  if (!candidate) return null;

  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? null;
  } catch {
    return null;
  }
}

export function createLyricLanguage(
  input: CreateLyricLanguageInput = {},
): LyricLanguage {
  const declared = normalizeLanguageTag(input.declared);
  const inferred = normalizeLanguageTag(input.inferred);
  const fallback = normalizeLanguageTag(input.fallback);

  return Object.freeze({
    declared,
    inferred,
    effective: inferred ?? declared ?? fallback ?? UNDETERMINED_LANGUAGE_TAG,
  });
}

export function primaryLanguage(
  language: string | null | undefined,
): string {
  return normalizeLanguageTag(language)?.split("-")[0]?.toLowerCase() ?? "";
}

/** Infers a useful script language while preserving authored/contextual tags. */
export function inferLyricLanguage(
  text: string,
  declaredLanguage: string | null | undefined,
  contextualLanguage: string | null | undefined = null,
): LyricLanguage {
  const declared = normalizeLanguageTag(declaredLanguage);
  const context = normalizeLanguageTag(contextualLanguage);
  const declaredPrimary = primaryLanguage(declared);
  const contextPrimary = primaryLanguage(context);
  let inferred: string | null = null;

  if (kanaPattern.test(text)) {
    inferred = "ja";
  } else if (hangulPattern.test(text)) {
    inferred = "ko";
  } else if (hanPattern.test(text)) {
    if (["zh", "ja", "ko"].includes(declaredPrimary)) inferred = declared;
    else if (["zh", "ja", "ko"].includes(contextPrimary)) inferred = context;
    else inferred = "und-Hani";
  } else if (latinPattern.test(text)) {
    inferred = declared ?? "und-Latn";
  }

  return createLyricLanguage({ declared, inferred, fallback: context });
}

function languageWithLatinScript(language: string): string {
  try {
    const locale = new Intl.Locale(language);
    const likelyScript = locale.script ?? locale.maximize().script;
    if (
      locale.language.toLowerCase() !== "und" &&
      likelyScript?.toLowerCase() === "latn"
    ) {
      return language;
    }
    return new Intl.Locale(locale.language, {
      script: "Latn",
      ...(locale.region ? { region: locale.region } : {}),
    }).toString();
  } catch {
    return "und-Latn";
  }
}

/**
 * Resolves a secondary branch independently from the primary vocal language.
 * Authored branch metadata wins unless the visible script proves a more
 * specific Chinese variant or Latin transliteration.
 */
export function inferSecondaryLyricLanguage(
  text: string,
  declaredLanguage: string | null | undefined,
  preferredLanguage: string | null | undefined = null,
  role: LyricSecondaryTextRole = "translation",
): LyricLanguage {
  const declared = normalizeLanguageTag(declaredLanguage);
  const preferred = normalizeLanguageTag(preferredLanguage);
  const declaredPrimary = primaryLanguage(declared);
  const preferredPrimary = primaryLanguage(preferred);
  let inferred: string | null = null;

  if (kanaPattern.test(text)) {
    inferred = "ja";
  } else if (hangulPattern.test(text)) {
    inferred = "ko";
  } else if (hanPattern.test(text)) {
    if (["zh", "ja", "ko"].includes(declaredPrimary)) inferred = declared;
    else if (simplifiedChineseHints.test(text)) inferred = "zh-Hans";
    else if (traditionalChineseHints.test(text)) inferred = "zh-Hant";
    else if (preferredPrimary === "zh") {
      inferred = preferred;
    } else {
      inferred = "und-Hani";
    }
  } else if (latinPattern.test(text)) {
    inferred = declared
      ? languageWithLatinScript(declared)
      : "und-Latn";
  } else if (declared) {
    inferred = declared;
  } else if (role === "translation" && preferred) {
    inferred = preferred;
  }

  return createLyricLanguage({ declared, inferred, fallback: preferred });
}

/**
 * Resolves the script family used by the primary lyric track. Layout spacing
 * follows this value so a translated branch cannot change the primary row's
 * typography metrics.
 */
export function resolveLyricPrimaryScript(
  language: LyricLanguage,
): LyricPrimaryScript {
  const tag = language.effective.trim();
  if (!tag || tag.toLowerCase() === UNDETERMINED_LANGUAGE_TAG) return "other";

  try {
    const locale = new Intl.Locale(tag);
    const languageCode = locale.language.toLowerCase();
    const explicitScript = locale.script?.toLowerCase();
    if (explicitScript === "latn") return "latin";
    if (explicitScript === "hans" || explicitScript === "hant") return "han";
    if (
      explicitScript === "jpan" ||
      explicitScript === "hira" ||
      explicitScript === "kana"
    ) {
      return "ja";
    }
    if (explicitScript === "kore" || explicitScript === "hang") return "ko";
    if (languageCode === "ja") return "ja";
    if (languageCode === "ko") return "ko";
    if (languageCode === "zh") return "han";

    const maximizedScript = locale.maximize().script?.toLowerCase();
    if (maximizedScript === "latn") return "latin";
    if (["hans", "hant", "hani"].includes(maximizedScript ?? "")) {
      return "han";
    }
    if (["jpan", "hira", "kana"].includes(maximizedScript ?? "")) {
      return "ja";
    }
    if (["kore", "hang"].includes(maximizedScript ?? "")) return "ko";
  } catch {
    // Invalid/host-provided language tags use the neutral spacing profile.
  }
  return "other";
}
