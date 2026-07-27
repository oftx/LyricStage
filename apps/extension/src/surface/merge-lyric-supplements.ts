/**
 * Port of lyric-stage CanonicalLyricDocument supplement merge — attaches
 * translation LRC and pronunciation (roma) LRC onto a primary timed document
 * by begin-time nearest match within a tolerance window.
 */
import {
  createJoinGroupId,
  createWordId,
  inferSecondaryLyricLanguage,
  type LyricDocument,
  type LyricText,
  type LyricTrack,
  type TextLyricLine,
} from '@lyric-stage/player';

export type LyricSupplementRole = 'translation' | 'pronunciation';

export type LyricSupplement = {
  readonly document: LyricDocument;
  readonly role: LyricSupplementRole;
  readonly toleranceMs: number;
};

const DEFAULT_TOLERANCE_MS = 1_200;

function textLines(document: LyricDocument): TextLyricLine[] {
  return document.lines.filter((line): line is TextLyricLine => line.tracks !== null);
}

function beginMs(line: TextLyricLine): number | null {
  return line.begin.valueMs;
}

function isUsefulSupplementText(text: string): boolean {
  const normalized = text.trim();
  return normalized.length > 0 && !/^\/+$/u.test(normalized);
}

type SupplementMatchCandidate = {
  readonly line: TextLyricLine;
  readonly distance: number;
};

function supplementCandidates(
  lines: readonly TextLyricLine[],
  targetMs: number,
  toleranceMs: number,
): readonly SupplementMatchCandidate[] {
  return lines
    .flatMap((line) => {
      const value = beginMs(line);
      if (value === null) return [];
      const distance = Math.abs(value - targetMs);
      return distance <= toleranceMs ? [{ line, distance }] : [];
    })
    .sort((left, right) => (
      left.distance - right.distance || left.line.index - right.line.index
    ));
}

function asTranslation(
  track: LyricTrack,
  documentLanguage: LyricText['language'] | null,
): LyricText {
  return {
    text: track.text,
    // Document-level language, not per-line: per-line inference made lines
    // WITHOUT a Simplified-hint char resolve to und-Hani (JP font fallback)
    // while their neighbors with 这/说/… resolved zh-Hans (CN font) — same
    // translation, two fonts (user report netease:2013870113).
    language: documentLanguage ?? inferSecondaryLyricLanguage(
      track.text,
      track.language.declared,
      track.language.effective,
      'translation',
    ),
  };
}

/**
 * One language for the whole translation supplement, from pooled evidence:
 * concatenate all line texts and infer once. Any Simplified hint anywhere
 * resolves the entire track to zh-Hans, so hint-less lines cannot drift to
 * a different font than their neighbors.
 */
function documentTranslationLanguage(
  supplementDocument: LyricDocument,
): LyricText['language'] | null {
  const pooled = supplementDocument.lines
    .map((line) => (line.tracks ? line.tracks.foreground.text : ''))
    .join('\n')
    .trim();
  if (!pooled) return null;
  const sample = supplementDocument.lines.find((line) => line.tracks !== null);
  const declared = sample?.tracks?.foreground.language.declared ?? null;
  const effective = sample?.tracks?.foreground.language.effective ?? null;
  return inferSecondaryLyricLanguage(pooled, declared, effective, 'translation');
}

function asPronunciation(track: LyricTrack, targetLineId: string): LyricTrack {
  const joinGroupIds = new Map<string, string>();
  let nextJoinGroupIndex = 0;
  return {
    ...track,
    language: inferSecondaryLyricLanguage(
      track.text,
      track.language.declared,
      track.language.effective,
      'pronunciation',
    ),
    words: track.words.map((word, index) => {
      const joinGroup = word.joinGroup;
      let joinGroupId: string | null = null;
      if (joinGroup) {
        joinGroupId = joinGroupIds.get(joinGroup.id) ?? createJoinGroupId(
          targetLineId,
          'foregroundPronunciation',
          nextJoinGroupIndex,
        );
        if (!joinGroupIds.has(joinGroup.id)) nextJoinGroupIndex += 1;
        joinGroupIds.set(joinGroup.id, joinGroupId);
      }
      return {
        ...word,
        id: createWordId(targetLineId, 'foregroundPronunciation', index),
        ...(joinGroup && joinGroupId
          ? { joinGroup: { ...joinGroup, id: joinGroupId } }
          : {}),
      };
    }),
  };
}

function mergeSupplement(
  document: LyricDocument,
  supplement: LyricSupplement,
): LyricDocument {
  const translationLanguage = supplement.role === 'translation'
    ? documentTranslationLanguage(supplement.document)
    : null;
  const baseLines = textLines(document);
  const extraLines = textLines(supplement.document);
  if (baseLines.length === 0 || extraLines.length === 0) return document;

  const usableExtras = extraLines.flatMap((line) => {
    const targetMs = beginMs(line);
    const track = line.tracks.foreground;
    if (targetMs === null || !isUsefulSupplementText(track.text)) return [];
    return [{
      track,
      candidates: supplementCandidates(
        baseLines,
        targetMs,
        supplement.toleranceMs,
      ),
    }];
  });
  const lineOwners = new Map<string, number>();
  const matchedCandidates = new Map<number, SupplementMatchCandidate>();
  const assign = (extraIndex: number, visited: Set<string>): boolean => {
    const extra = usableExtras[extraIndex];
    if (!extra) return false;
    for (const candidate of extra.candidates) {
      if (visited.has(candidate.line.id)) continue;
      visited.add(candidate.line.id);
      const owner = lineOwners.get(candidate.line.id);
      if (owner !== undefined) {
        const ownerCandidate = matchedCandidates.get(owner);
        if (
          !ownerCandidate
          || candidate.distance >= ownerCandidate.distance
          || !assign(owner, visited)
        ) {
          continue;
        }
      }
      lineOwners.set(candidate.line.id, extraIndex);
      matchedCandidates.set(extraIndex, candidate);
      return true;
    }
    return false;
  };
  usableExtras.forEach((_extra, index) => {
    assign(index, new Set());
  });

  const matches = new Map<string, LyricTrack>();
  matchedCandidates.forEach((candidate, extraIndex) => {
    const extra = usableExtras[extraIndex];
    if (extra) matches.set(candidate.line.id, extra.track);
  });
  if (matches.size === 0) return document;

  return {
    ...document,
    lines: document.lines.map((line) => {
      if (line.tracks === null) return line;
      const track = matches.get(line.id);
      if (!track) return line;
      return supplement.role === 'translation'
        ? { ...line, translation: asTranslation(track, translationLanguage) }
        : {
            ...line,
            tracks: {
              ...line.tracks,
              foregroundPronunciation: asPronunciation(track, line.id),
            },
          };
    }),
  };
}

export function mergeLyricSupplements(
  document: LyricDocument,
  supplements: readonly LyricSupplement[],
): LyricDocument {
  return supplements.reduce(mergeSupplement, document);
}

export function defaultSupplementToleranceMs(): number {
  return DEFAULT_TOLERANCE_MS;
}
