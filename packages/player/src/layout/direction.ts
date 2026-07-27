import type {
  LyricDocument,
  LyricLanguage,
  LyricLine,
  LyricTrack,
} from "../domain/types.js";

export type LyricLayoutDirection = "ltr" | "rtl";

export type LyricDirectionSource =
  | "rtl-language"
  | "first-strong-character"
  | "default-ltr";

export interface LyricDirectionResolution {
  readonly direction: LyricLayoutDirection;
  readonly source: LyricDirectionSource;
  readonly languageTag: string;
}

export interface ResolveLyricDirectionInput {
  readonly text: string;
  readonly languageTag: string;
}

const rtlScriptSubtags: ReadonlySet<string> = new Set([
  "Adlm",
  "Arab",
  "Armi",
  "Avst",
  "Chrs",
  "Elym",
  "Hatr",
  "Hebr",
  "Hung",
  "Khar",
  "Lydi",
  "Mand",
  "Mani",
  "Merc",
  "Mero",
  "Narb",
  "Nbat",
  "Nkoo",
  "Orkh",
  "Palm",
  "Phli",
  "Phlp",
  "Phnx",
  "Prti",
  "Rohg",
  "Samr",
  "Sarb",
  "Sogd",
  "Sogo",
  "Syrc",
  "Thaa",
  "Yezi",
]);

const unicodeLetterPattern = /\p{Letter}/u;
const rtlLetterPattern =
  /[\u0590-\u08ff\uFB1D-\uFDFF\uFE70-\uFEFF\u{10840}-\u{109FF}\u{10A00}-\u{10AFF}\u{10B00}-\u{10BAF}\u{10C00}-\u{10C4F}\u{10C80}-\u{10D8F}\u{10E80}-\u{10FFF}\u{1E900}-\u{1E95F}\u{1EE00}-\u{1EEFF}]/u;

function isRtlLanguage(languageTag: string): boolean {
  const candidate = languageTag.trim();
  if (!candidate) return false;

  try {
    const script = new Intl.Locale(candidate).maximize().script;
    return script !== undefined && rtlScriptSubtags.has(script);
  } catch {
    return false;
  }
}

function findFirstStrongDirection(
  text: string,
): LyricLayoutDirection | null {
  for (const character of text) {
    if (character === "\u200e") return "ltr";
    if (character === "\u061c" || character === "\u200f") return "rtl";
    if (!unicodeLetterPattern.test(character)) continue;
    return rtlLetterPattern.test(character) ? "rtl" : "ltr";
  }
  return null;
}

/** Resolves visual text flow without consulting browser layout state. */
export function resolveLyricDirection(
  input: ResolveLyricDirectionInput,
): LyricDirectionResolution {
  if (isRtlLanguage(input.languageTag)) {
    return Object.freeze({
      direction: "rtl",
      source: "rtl-language",
      languageTag: input.languageTag,
    });
  }

  const strongDirection = findFirstStrongDirection(input.text);
  if (strongDirection !== null) {
    return Object.freeze({
      direction: strongDirection,
      source: "first-strong-character",
      languageTag: input.languageTag,
    });
  }

  return Object.freeze({
    direction: "ltr",
    source: "default-ltr",
    languageTag: input.languageTag,
  });
}

interface DirectionalContent {
  readonly text: string;
  readonly language: LyricLanguage;
}

function contentFromTrack(
  track: LyricTrack | undefined,
): DirectionalContent | null {
  if (!track?.text) return null;
  return { text: track.text, language: track.language };
}

function getDirectionalContent(
  document: LyricDocument,
  line: LyricLine,
): DirectionalContent {
  if (line.tracks === null) {
    return { text: "", language: document.language };
  }

  return (
    contentFromTrack(line.tracks.foreground) ??
    contentFromTrack(line.tracks.background) ??
    contentFromTrack(line.tracks.foregroundPronunciation) ??
    contentFromTrack(line.tracks.backgroundPronunciation) ??
    { text: "", language: line.tracks.foreground.language }
  );
}

export function resolveLyricLineDirection(
  document: LyricDocument,
  line: LyricLine,
): LyricDirectionResolution {
  const content = getDirectionalContent(document, line);
  return resolveLyricDirection({
    text: content.text,
    languageTag: content.language.effective,
  });
}
