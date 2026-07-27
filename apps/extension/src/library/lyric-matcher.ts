/**
 * Title-similarity lyric matching, ported verbatim from the accepted
 * userscript implementation (apps/lyric-stage core/matching/LyricMatcher.ts)
 * and re-targeted at the extension's LyricLibraryIndexEntryV1: aliases and
 * precomputed search fields are not stored yet, so titles/creators normalize
 * at match time, and capability nudges use format/hasTranslation.
 */
import type { LyricLibraryIndexEntryV1 } from '../library/extension-lyric-library.js';

export interface MatchMediaDescriptor {
  readonly title: string;
  readonly creators: readonly string[];
  readonly durationMs: number;
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Score gate shared by the picker's candidate list and content auto-match. */
export const RECOMMENDATION_THRESHOLD = 0.25;

const DISPLAY_TAGS = new Set([
  'official', 'official video', 'official music video', 'music video', 'mv',
  'official audio', 'audio', 'lyrics', 'lyric video', 'visualizer', '4k', 'hd',
  '官方', '官方mv', '官方 mv', '官方音乐视频', '音乐视频', '歌词版', '动态歌词',
  '中字', '中文字幕', '中英字幕',
]);
const VERSION_TAGS = new Set([
  'live', 'remix', 'cover', 'acoustic', 'instrumental', 'sped up', 'slowed',
  'nightcore', 'karaoke', 'demo', 'radio edit', 'extended',
]);
// 《》 added over the userscript original: Chinese video titles almost always
// wrap the song name in CJK title marks ("汪苏泷《小星星》…").
const TITLE_BRACKET_PATTERN = /[\[【《]([^\]】》]+)[\]】》]/gu;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_TO_LATIN_PATTERN = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])([\p{Script=Latin}])/gu;
const LATIN_TO_CJK_PATTERN = /([\p{Script=Latin}])([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu;

export interface LyricMatchCandidate {
  lyricId: string;
  score: number;
  reasons: string[];
}

export interface LyricMatchResult {
  best: LyricMatchCandidate | null;
  candidates: LyricMatchCandidate[];
}

interface ParsedTitle {
  titleCandidates: string[];
  creatorCandidates: string[];
  versionTags: Set<string>;
}

export function matchLyrics(
  media: MatchMediaDescriptor,
  entries: readonly LyricLibraryIndexEntryV1[],
): LyricMatchResult {
  const parsedMedia = parseMediaTitle(media.title, media.creators);
  const ranked = entries
    .map((entry) => scoreEntry(parsedMedia, media.durationMs, entry))
    .sort((left, right) => right.score - left.score);
  return {
    best: ranked[0] ?? null,
    candidates: ranked.filter((candidate) => candidate.score >= RECOMMENDATION_THRESHOLD),
  };
}

export function parseMediaTitle(title: string, creators: readonly string[] = []): ParsedTitle {
  const versionTags = extractVersionTags(title);
  const stripped = stripDisplayTags(title);
  const titleCandidates = new Set<string>();
  const creatorCandidates = new Set(creators.map(normalizeSearchText).filter(Boolean));
  addCandidate(titleCandidates, stripped);
  addBracketTitleCandidates(stripped, titleCandidates, creatorCandidates);

  const parts = stripped
    .split(/\s+(?:-|–|—|\||·)\s+/)
    .map((part) => normalizeSearchText(part))
    .filter(Boolean);
  if (parts.length >= 2) {
    addCandidate(titleCandidates, parts.slice(1).join(' '));
    addCandidate(titleCandidates, parts.slice(0, -1).join(' '));
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first) creatorCandidates.add(first);
    if (last) creatorCandidates.add(last);
  }

  return {
    titleCandidates: [...titleCandidates],
    creatorCandidates: [...creatorCandidates],
    versionTags,
  };
}

function scoreEntry(
  media: ParsedTitle,
  mediaDurationMs: number,
  entry: LyricLibraryIndexEntryV1,
): LyricMatchCandidate {
  const reasons: string[] = [];
  const entryTitles = [
    normalizeSearchText(entry.title),
    ...(entry.titleAliases ?? []).map(normalizeSearchText),
  ].filter(Boolean);
  const titleSimilarity = Math.max(
    0,
    ...entryTitles.flatMap((entryTitle) => (
      media.titleCandidates.map((candidate) => textSimilarity(candidate, entryTitle))
    )),
  );

  let score = 0;
  if (titleSimilarity === 1) {
    score += 0.68;
    reasons.push('标题一致');
  } else {
    score += titleSimilarity * 0.58;
    if (titleSimilarity >= 0.72) reasons.push('标题相似');
  }

  const entryCreators = [
    ...entry.creators.map(normalizeSearchText),
    ...(entry.creatorAliases ?? []).map(normalizeSearchText),
  ].filter(Boolean);
  const creatorSimilarity = Math.max(
    0,
    ...entryCreators.flatMap((creator) => (
      media.creatorCandidates.map((candidate) => textSimilarity(candidate, creator))
    )),
  );
  if (creatorSimilarity >= 0.82) {
    score += 0.2;
    reasons.push('创作者一致');
  } else if (creatorSimilarity >= 0.55) {
    score += 0.1;
    reasons.push('创作者相似');
  }

  if (mediaDurationMs > 0 && entry.durationMs && entry.durationMs > 0) {
    const durationDelta = Math.abs(mediaDurationMs - entry.durationMs);
    if (durationDelta <= 3_000) {
      score += 0.12;
      reasons.push('时长接近');
    } else if (durationDelta <= 10_000) {
      score += 0.08;
      reasons.push('时长相近');
    } else if (durationDelta <= 30_000) {
      score += 0.03;
    }
  }

  const entryVersions = extractVersionTags(entry.title);
  if (hasVersionConflict(media.versionTags, entryVersions)) {
    score -= 0.25;
    reasons.push('版本可能不同');
  } else if (media.versionTags.size > 0 && sameSet(media.versionTags, entryVersions)) {
    score += 0.05;
    reasons.push('版本一致');
  }

  if (entry.format === 'yrc' || entry.format === 'qrc' || entry.format === 'ttml') {
    score += 0.005;
  }
  if (entry.hasTranslation) score += 0.003;

  return {
    lyricId: entry.id,
    score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
    reasons,
  };
}

function stripDisplayTags(value: string): string {
  let result = value.normalize('NFKC');
  result = result.replace(/[\[(（【]([^\])）】]+)[\])）】]/g, (match, inner: string) => {
    const normalized = normalizeSearchText(inner);
    return DISPLAY_TAGS.has(normalized) ? ' ' : match;
  });
  for (const tag of DISPLAY_TAGS) {
    const pattern = /^[\x00-\x7F]+$/.test(tag)
      ? `\\b${escapeRegExp(tag)}\\b`
      : escapeRegExp(tag);
    result = result.replace(new RegExp(pattern, 'giu'), ' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}

function extractVersionTags(value: string): Set<string> {
  const normalized = normalizeSearchText(value);
  return new Set([...VERSION_TAGS].filter((tag) => normalized.includes(tag)));
}

function hasVersionConflict(left: Set<string>, right: Set<string>): boolean {
  if (left.size === 0 && right.size === 0) return false;
  if (left.size === 0 || right.size === 0) return true;
  return !sameSet(left, right);
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function addCandidate(target: Set<string>, value: string): void {
  const normalized = normalizeSearchText(value);
  if (normalized) target.add(normalized);
}

function addBracketTitleCandidates(
  value: string,
  titleCandidates: Set<string>,
  creatorCandidates: Set<string>,
): void {
  for (const match of value.matchAll(TITLE_BRACKET_PATTERN)) {
    const content = match[1]?.trim() ?? '';
    const normalized = normalizeSearchText(content);
    if (!normalized || DISPLAY_TAGS.has(normalized) || VERSION_TAGS.has(normalized)) continue;

    addAliasCandidates(titleCandidates, content);
    const prefix = value.slice(0, match.index).trim();
    if (prefix) addAliasCandidates(creatorCandidates, prefix);
    break;
  }
}

function addAliasCandidates(target: Set<string>, value: string): void {
  for (const part of value.split(/\s*(?:\/|／|\\|\||·)\s*/u)) {
    addCandidate(target, part);

    const separated = part
      .replace(CJK_TO_LATIN_PATTERN, '$1 $2')
      .replace(LATIN_TO_CJK_PATTERN, '$1 $2');
    const tokens = normalizeSearchText(separated).split(' ').filter(Boolean);
    if (!tokens.some((token) => CJK_PATTERN.test(token))
      || !tokens.some((token) => !CJK_PATTERN.test(token))) continue;

    let currentKind: 'cjk' | 'other' | null = null;
    let current: string[] = [];
    const flush = (): void => {
      if (current.length > 0) addCandidate(target, current.join(' '));
      current = [];
    };

    for (const token of tokens) {
      const kind = CJK_PATTERN.test(token) ? 'cjk' : 'other';
      if (currentKind !== null && kind !== currentKind) flush();
      currentKind = kind;
      current.push(token);
    }
    flush();
  }
}

function textSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length) * 0.9 + 0.1;
  }

  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  const tokenIntersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const tokenUnion = new Set([...leftTokens, ...rightTokens]).size;
  const tokenScore = tokenUnion > 0 ? tokenIntersection / tokenUnion : 0;
  return Math.max(tokenScore, diceCoefficient(left.replace(/\s/g, ''), right.replace(/\s/g, '')));
}

function diceCoefficient(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const leftBigrams = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const bigram = left.slice(index, index + 2);
    leftBigrams.set(bigram, (leftBigrams.get(bigram) ?? 0) + 1);
  }

  let intersection = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const bigram = right.slice(index, index + 2);
    const count = leftBigrams.get(bigram) ?? 0;
    if (count <= 0) continue;
    intersection += 1;
    leftBigrams.set(bigram, count - 1);
  }
  return (2 * intersection) / (left.length + right.length - 2);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
