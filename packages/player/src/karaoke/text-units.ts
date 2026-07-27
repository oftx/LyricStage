export type KaraokeScriptFamily =
  | "han"
  | "hiragana"
  | "katakana"
  | "hangul"
  | "other";

export type KaraokeTextUnitStrategy =
  | "split-cjk-graphemes"
  | "split-letter-number-graphemes"
  | "whole-text";

export interface KaraokeTextUnitOptions {
  readonly splitLatinLetterNumber?: boolean;
}

export interface KaraokeTextUnit {
  readonly index: number;
  readonly text: string;
  readonly script: KaraokeScriptFamily;
}

export interface KaraokeTextUnitPlan {
  readonly text: string;
  readonly strategy: KaraokeTextUnitStrategy;
  readonly graphemes: readonly string[];
  readonly units: readonly KaraokeTextUnit[];
}

const hanPattern = /\p{Script_Extensions=Han}/u;
const hiraganaPattern = /\p{Script_Extensions=Hiragana}/u;
const katakanaPattern = /\p{Script_Extensions=Katakana}/u;
const hangulPattern = /\p{Script_Extensions=Hangul}/u;
const letterOrNumberPattern = /[\p{L}\p{N}]/u;
const latinPattern = /\p{Script_Extensions=Latin}/u;
const numberPattern = /\p{N}/u;

function createSegmenter(): Intl.Segmenter | null {
  if (typeof Intl.Segmenter !== "function") return null;
  try {
    return new Intl.Segmenter(undefined, { granularity: "grapheme" });
  } catch {
    return null;
  }
}

let graphemeSegmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter = createSegmenter();
  }
  return graphemeSegmenter;
}

/** Uses platform grapheme segmentation when available and code points otherwise. */
export function segmentKaraokeGraphemes(text: string): readonly string[] {
  const segmenter = getSegmenter();
  const graphemes = segmenter
    ? [...segmenter.segment(text)].map(({ segment }) => segment)
    : Array.from(text);
  return Object.freeze(graphemes);
}

export function classifyKaraokeGrapheme(
  grapheme: string,
): KaraokeScriptFamily {
  if (hanPattern.test(grapheme)) return "han";
  if (hiraganaPattern.test(grapheme)) return "hiragana";
  if (katakanaPattern.test(grapheme)) return "katakana";
  if (hangulPattern.test(grapheme)) return "hangul";
  return "other";
}

export function isCjkOrKanaGrapheme(grapheme: string): boolean {
  return classifyKaraokeGrapheme(grapheme) !== "other";
}

export function isLetterOrNumberGrapheme(grapheme: string): boolean {
  return letterOrNumberPattern.test(grapheme);
}

export function countLetterOrNumberGraphemes(text: string): number {
  return segmentKaraokeGraphemes(text).filter(isLetterOrNumberGrapheme).length;
}

export function hasEmphasisSplitExcludedScript(text: string): boolean {
  return segmentKaraokeGraphemes(text).some(
    (grapheme) =>
      letterOrNumberPattern.test(grapheme) &&
      !latinPattern.test(grapheme) &&
      !numberPattern.test(grapheme),
  );
}

/**
 * CJK, kana, and Hangul words split by grapheme. Punctuation may accompany
 * those scripts, while mixed Latin/script words remain one authored unit.
 */
export function shouldSplitKaraokeText(
  graphemes: readonly string[],
): boolean {
  const hasCjkOrKana = graphemes.some(isCjkOrKanaGrapheme);
  if (!hasCjkOrKana) return false;
  return !graphemes.some(
    (grapheme) =>
      !isCjkOrKanaGrapheme(grapheme) && letterOrNumberPattern.test(grapheme),
  );
}

function collectAnimatedChunks(
  graphemes: readonly string[],
  isAnimatedGrapheme: (grapheme: string) => boolean,
): readonly string[] {
  const chunks: string[] = [];
  let buffer = "";
  let hasAnimatedGrapheme = false;

  for (const grapheme of graphemes) {
    if (!isAnimatedGrapheme(grapheme)) {
      buffer += grapheme;
      continue;
    }
    if (hasAnimatedGrapheme) {
      if (buffer.length > 0) chunks.push(buffer);
      buffer = grapheme;
      continue;
    }
    buffer += grapheme;
    hasAnimatedGrapheme = true;
  }
  if (buffer.length > 0) chunks.push(buffer);
  return Object.freeze(chunks);
}

export function createKaraokeTextUnitPlan(
  text: string,
  options: KaraokeTextUnitOptions = {},
): KaraokeTextUnitPlan {
  const graphemes = segmentKaraokeGraphemes(text);
  const splitCjk = shouldSplitKaraokeText(graphemes);
  const splitLatin =
    !splitCjk &&
    options.splitLatinLetterNumber === true &&
    graphemes.filter(isLetterOrNumberGrapheme).length > 1;
  const strategy: KaraokeTextUnitStrategy = splitCjk
    ? "split-cjk-graphemes"
    : splitLatin
      ? "split-letter-number-graphemes"
      : "whole-text";
  const unitTexts = splitCjk
    ? collectAnimatedChunks(graphemes, isCjkOrKanaGrapheme)
    : splitLatin
      ? collectAnimatedChunks(graphemes, isLetterOrNumberGrapheme)
      : text.length > 0
        ? [text]
        : [];
  const units = Object.freeze(
    unitTexts.map((unitText, index) =>
      Object.freeze({
        index,
        text: unitText,
        script: classifyKaraokeGrapheme(unitText),
      }),
    ),
  );

  return Object.freeze({
    text,
    strategy,
    graphemes,
    units,
  });
}
