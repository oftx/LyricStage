/**
 * Pure lyric-payload parsing pipeline: format dispatch with the accepted
 * fallback heuristics (TTML never falls through to LRC, mislabeled-plaintext
 * detection, QRC-vs-LRC secondary sniffing, roma tolerance widening).
 * Extracted from surface.ts so the heuristics are unit-testable — the same
 * split as merge-lyric-supplements.ts, the other half of this pipeline.
 */
import {
  parseLrc,
  parsePlaintext,
  parseQrc,
  parseTtml,
  parseYrc,
  type LyricDocument,
} from '@lyric-stage/player';
import type { LyricDocumentPayloadV1 } from '@lyric-stage/extension-protocol';
import {
  defaultSupplementToleranceMs,
  mergeLyricSupplements,
} from './merge-lyric-supplements.js';

export function looksLikeTimedLyricBody(text: string): boolean {
  // LRC [mm:ss.xx] / YRC-ish / QRC [ms,dur] — not exhaustive, just enough to
  // avoid forcing pure prose through timed parsers that drop blank lines.
  return (
    /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(text)
    || /\[\d+,\d+\]/.test(text)
    || /"t"\s*:\s*\d+/.test(text)
  );
}

/**
 * NetEase (and others) pad timed lyrics with spacer lines — fully blank, or a
 * bare timestamp with no text ("[01:23.45]"). The parsers keep both (blank →
 * empty static row, bare timestamp → empty timed line), which renders as
 * blank rows in 整行/逐字 mode.
 *
 * Primary documents are filtered AFTER parsing: the spacer's timestamp has
 * already served as the previous line's end boundary, so dropping the empty
 * line leaves a temporal hole that deriveInstrumentalGaps turns into a proper
 * interlude row. Stripping the raw text instead would extend the previous
 * line through the interlude. Secondary (translation/pronunciation) bodies
 * are stripped pre-parse via stripEmptyTimedLines — they only merge by time,
 * so their end boundaries are irrelevant.
 */
const TIMESTAMP_ONLY_LINE = /^\s*(?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]|\[\d+,\d+\])+\s*$/;

export function stripEmptyTimedLines(text: string): string {
  return text
    .split(/\r\n?|\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return !TIMESTAMP_ONLY_LINE.test(trimmed);
    })
    .join('\n');
}

function withoutBlankLines(document: LyricDocument): LyricDocument | null {
  const kept = document.lines.filter((line) =>
    line.tracks === null || line.tracks.foreground.text.trim().length > 0,
  );
  if (kept.length === document.lines.length) return document;
  if (kept.length === 0) return null;
  return {
    ...document,
    lines: kept.map((line, index) => ({ ...line, index })),
  };
}

/**
 * LRC multi-timestamp lines ("[tA][tB]same text", the repeated-chorus idiom)
 * expand into SOURCE-order rows: the tB occurrence renders right next to the
 * tA one instead of at its chronological slot, and when playback reaches tB
 * the focus visibly jumps BACK up to it (netease:31967045). The parser
 * deliberately never sorts (canonical order is sacred for TTML duets), so
 * chronological order is restored here, for flat timed docs only. Untimed
 * rows (credits) travel with the nearest preceding timed line; leading
 * credits stay on top. Line end times are boundary-derived and stay valid.
 */
function sortNonMonotonicTimedLines(document: LyricDocument): LyricDocument {
  let lastBegin = Number.NEGATIVE_INFINITY;
  let monotonic = true;
  for (const line of document.lines) {
    const begin = line.begin.valueMs;
    if (begin === null || !Number.isFinite(begin)) continue;
    if (begin < lastBegin) {
      monotonic = false;
      break;
    }
    lastBegin = begin;
  }
  if (monotonic) return document;
  let carry = Number.NEGATIVE_INFINITY;
  const keyed = document.lines.map((line, position) => {
    const begin = line.begin.valueMs;
    if (begin !== null && Number.isFinite(begin)) carry = begin;
    return { line, key: carry, position };
  });
  keyed.sort((left, right) => left.key - right.key || left.position - right.position);
  return {
    ...document,
    lines: keyed.map(({ line }, index) => ({ ...line, index })),
  };
}

export function parsePrimaryDocument(doc: LyricDocumentPayloadV1): LyricDocument | null {
  const input = { text: doc.text, sourceName: doc.sourceName };
  if (doc.format === 'ttml') {
    const ttml = parseTtml(input);
    if (ttml.ok) return withoutBlankLines(ttml.document);
    // Do not fall through to LRC for XML bodies.
    return null;
  }
  // Untimed pure text (often mislabeled as lrc) must use the plaintext parser
  // so blank lines become full-height poem rows instead of being discarded.
  if (
    doc.format === 'plaintext'
    || (doc.format === 'lrc' && !looksLikeTimedLyricBody(doc.text))
  ) {
    const plain = parsePlaintext(input);
    if (plain.ok) return plain.document;
  }
  const parsed = doc.format === 'yrc'
    ? parseYrc(input)
    : doc.format === 'qrc'
      ? parseQrc(input)
      : parseLrc(input);
  if (parsed.ok) {
    // All lines empty (pure spacer doc) is "no lyrics", not a plaintext
    // fallback — that would render the raw timestamp tags as poem text.
    const filtered = withoutBlankLines(parsed.document);
    return filtered ? sortNonMonotonicTimedLines(filtered) : null;
  }
  const plainFallback = parsePlaintext(input);
  if (plainFallback.ok) return plainFallback.document;
  const fallback = parseLrc(input);
  if (!fallback.ok) return null;
  const cleaned = withoutBlankLines(fallback.document);
  return cleaned ? sortNonMonotonicTimedLines(cleaned) : null;
}

/**
 * QQ roma is QRC-timed (`[ms,dur]…`); NetEase romalrc / QQ trans are LRC.
 * Try the format that matches the body instead of assuming LRC.
 */
function looksLikeQrcBody(text: string): boolean {
  return /^\s*\[\d+,\d+\]/m.test(text);
}

/**
 * NetEase romalrc (and some QQ roma) mixes fullwidth forms into otherwise
 * halfwidth romaji — "ｉ" (U+FF49) next to "i" renders from a different,
 * wider glyph (often via JP font fallback) and reads as inconsistent letter
 * widths. Fold fullwidth ASCII to halfwidth and the ideographic space to a
 * plain space. Pronunciation-only: translations are CJK prose where
 * fullwidth punctuation is intentional.
 */
export function normalizeFullwidthAscii(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xFEE0),
    )
    .replace(/\u3000/g, ' ');
}

export function parseSecondaryTimedText(
  text: string,
  sourceName: string,
): LyricDocument | null {
  const trimmed = stripEmptyTimedLines(text.trim());
  if (!trimmed) return null;
  if (looksLikeQrcBody(trimmed)) {
    const qrc = parseQrc({ text: trimmed, sourceName });
    if (qrc.ok) return qrc.document;
  }
  const lrc = parseLrc({ text: trimmed, sourceName });
  if (lrc.ok) return lrc.document;
  // Last resort: opposite order if the heuristic guessed wrong.
  if (!looksLikeQrcBody(trimmed)) {
    const qrc = parseQrc({ text: trimmed, sourceName });
    if (qrc.ok) return qrc.document;
  }
  return null;
}

function isUsefulSecondaryLineText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  // QQ translation often pads credit rows with "//".
  if (/^\/+$/u.test(normalized)) return false;
  if (normalized.startsWith('[kana:')) return false;
  return true;
}

export function attachSecondaryTracks(
  primary: LyricDocument,
  doc: LyricDocumentPayloadV1,
): { document: LyricDocument; hasTranslation: boolean; hasPronunciation: boolean } {
  const toleranceMs = defaultSupplementToleranceMs();
  const supplements: Array<{
    document: LyricDocument;
    role: 'translation' | 'pronunciation';
    toleranceMs: number;
  }> = [];

  let hasTranslation = false;
  let hasPronunciation = false;

  if (doc.translationText?.trim()) {
    const tDoc = parseSecondaryTimedText(
      doc.translationText,
      `${doc.sourceName}.translation`,
    );
    if (tDoc) {
      supplements.push({
        document: tDoc,
        role: 'translation',
        toleranceMs,
      });
    }
  }
  if (doc.pronunciationText?.trim()) {
    // QQ roma is QRC (`[0,338]ha (…)`); NetEase romalrc is LRC.
    const pDoc = parseSecondaryTimedText(
      normalizeFullwidthAscii(doc.pronunciationText),
      `${doc.sourceName}.pronunciation`,
    );
    if (pDoc) {
      supplements.push({
        document: pDoc,
        role: 'pronunciation',
        // Word-timed roma lines can sit a few hundred ms off LRC/QRC primaries.
        toleranceMs: Math.max(toleranceMs, 2_000),
      });
    }
  }

  const merged = supplements.length > 0
    ? mergeLyricSupplements(primary, supplements)
    : primary;

  for (const line of merged.lines) {
    if (line.tracks === null) continue;
    if (
      line.translation?.text
      && isUsefulSecondaryLineText(line.translation.text)
    ) {
      hasTranslation = true;
    }
    if (
      line.tracks.foregroundPronunciation?.text
      && isUsefulSecondaryLineText(line.tracks.foregroundPronunciation.text)
    ) {
      hasPronunciation = true;
    }
  }

  return {
    document: merged,
    hasTranslation,
    hasPronunciation,
  };
}
