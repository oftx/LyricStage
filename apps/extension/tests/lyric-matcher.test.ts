import { describe, expect, it } from 'vitest';
import { matchLyrics, normalizeSearchText, parseMediaTitle } from '../src/library/lyric-matcher.js';
import type { LyricLibraryIndexEntryV1 } from '../src/library/extension-lyric-library.js';

function entry(overrides: Partial<LyricLibraryIndexEntryV1> & { id: string; title: string }): LyricLibraryIndexEntryV1 {
  return {
    creators: [],
    format: 'lrc',
    hasTranslation: false,
    updatedAt: 0,
    ...overrides,
  };
}

describe('normalizeSearchText', () => {
  it('folds width, case, punctuation, and whitespace', () => {
    expect(normalizeSearchText('Ｎｅｖｅｒ　Ｇｏｎｎａ')).toBe('never gonna');
    expect(normalizeSearchText('Song!!! (Test)')).toBe('song test');
  });
});

describe('parseMediaTitle', () => {
  it('splits creator-title separators and strips display tags', () => {
    const parsed = parseMediaTitle('Rick Astley - Never Gonna Give You Up (Official Music Video)');
    expect(parsed.titleCandidates).toContain('never gonna give you up');
    expect(parsed.creatorCandidates).toContain('rick astley');
  });

  it('extracts CJK title marks (《》) as title with prefix creator', () => {
    const parsed = parseMediaTitle('汪苏泷《小星星》百万豪装录音棚大声听【Hi-res】');
    expect(parsed.titleCandidates).toContain('小星星');
    expect(parsed.creatorCandidates).toContain('汪苏泷');
  });

  it('extracts bracket aliases with CJK/Latin segmentation', () => {
    const parsed = parseMediaTitle('米津玄師【Lemon】MV');
    expect(parsed.titleCandidates).toContain('lemon');
    expect(parsed.creatorCandidates).toContain('米津玄師'.normalize('NFKC').toLowerCase());
  });
});

describe('matchLyrics', () => {
  const library = [
    entry({ id: 'a', title: 'Never Gonna Give You Up', creators: ['Rick Astley'], durationMs: 213_000, format: 'yrc' }),
    entry({ id: 'b', title: 'Lemon', creators: ['米津玄師'], durationMs: 255_000 }),
    entry({ id: 'c', title: '完全不相关的歌', creators: ['别人'] }),
  ];

  it('matches a CJK-title-marked video against a library entry', () => {
    const result = matchLyrics({
      title: '汪苏泷《小星星》百万豪装录音棚大声听【Hi-res】',
      creators: ['某音乐UP'],
      durationMs: 0,
    }, [
      entry({ id: 'x', title: '小星星', creators: ['汪苏泷'] }),
      entry({ id: 'y', title: '别的歌', creators: ['别人'] }),
    ]);
    expect(result.best?.lyricId).toBe('x');
    expect(result.best!.score).toBeGreaterThanOrEqual(0.25);
  });

  it('matches a video title with channel and duration against the library', () => {
    const result = matchLyrics({
      title: '【官方 MV】Never Gonna Give You Up - Rick Astley',
      creators: ['SomeUploader'],
      durationMs: 213_500,
    }, library);
    expect(result.best?.lyricId).toBe('a');
    expect(result.best!.score).toBeGreaterThanOrEqual(0.25);
  });

  it('does not recommend unrelated entries', () => {
    const result = matchLyrics({
      title: 'Totally Different Song Title',
      creators: [],
      durationMs: 0,
    }, library);
    expect(result.candidates.every((c) => c.score < 0.6)).toBe(true);
  });

  it('matches through title aliases', () => {
    const result = matchLyrics({
      title: 'Twinkle Twinkle Little Star MV',
      creators: [],
      durationMs: 0,
    }, [
      entry({ id: 'aliased', title: '小星星', titleAliases: ['Twinkle Twinkle Little Star'] }),
      entry({ id: 'other', title: '别的歌' }),
    ]);
    expect(result.best?.lyricId).toBe('aliased');
    expect(result.best!.score).toBeGreaterThanOrEqual(0.25);
  });

  it('penalizes version conflicts (live vs studio)', () => {
    const result = matchLyrics({
      title: 'Never Gonna Give You Up (Live)',
      creators: ['Rick Astley'],
      durationMs: 0,
    }, library);
    const a = result.candidates.find((c) => c.lyricId === 'a');
    expect(a?.reasons).toContain('版本可能不同');
  });
});
