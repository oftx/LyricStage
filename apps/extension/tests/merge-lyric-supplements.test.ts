import { describe, expect, it } from 'vitest';
import { parseLrc, parseQrc } from '@lyric-stage/player';
import {
  defaultSupplementToleranceMs,
  mergeLyricSupplements,
} from '../src/surface/merge-lyric-supplements.js';

describe('mergeLyricSupplements', () => {
  it('attaches translation and pronunciation by begin time', () => {
    const primary = parseLrc({
      text: [
        '[00:01.00]ねえ もしも全て投げ捨てられたら',
        '[00:06.00]笑って生きることが楽になるの',
      ].join('\n'),
      sourceName: 'primary',
    });
    expect(primary.ok).toBe(true);
    if (!primary.ok) return;

    const translation = parseLrc({
      text: [
        '[00:01.05]如果把一切都舍弃掉',
        '[00:06.10]开心地活着就会变得轻松',
      ].join('\n'),
      sourceName: 'translation',
    });
    const pronunciation = parseLrc({
      text: [
        '[00:00.95]nee moshimo subete nagesuteraretara',
        '[00:06.20]waratte ikiru koto ga raku ni naru no',
      ].join('\n'),
      sourceName: 'pronunciation',
    });
    expect(translation.ok && pronunciation.ok).toBe(true);
    if (!translation.ok || !pronunciation.ok) return;

    const merged = mergeLyricSupplements(primary.document, [
      {
        document: translation.document,
        role: 'translation',
        toleranceMs: defaultSupplementToleranceMs(),
      },
      {
        document: pronunciation.document,
        role: 'pronunciation',
        toleranceMs: defaultSupplementToleranceMs(),
      },
    ]);

    const lines = merged.lines.filter((line) => line.tracks !== null);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.translation?.text).toContain('如果');
    expect(lines[0]?.tracks?.foregroundPronunciation?.text).toContain('nee');
    expect(lines[1]?.translation?.text).toContain('开心地');
    expect(lines[1]?.tracks?.foregroundPronunciation?.text).toContain('waratte');
  });

  it('attaches QQ-style QRC roma onto QRC primary lines', () => {
    // Simplified bodies matching QQ PlayLyricInfo shapes.
    const primary = parseQrc({
      text: [
        '[607,10789]春(607,322)の(929,933)風(1862,630)',
        '[11396,6537]遥(11396,537)か(11933,463)な(12396,1120)夢(13516,599)',
      ].join('\n'),
      sourceName: 'primary-qrc',
    });
    expect(primary.ok).toBe(true);
    if (!primary.ok) return;

    const roma = parseQrc({
      text: [
        '[606,10788]ha (606,45)ru (652,277)no (929,932)ka (1861,358)ze (2220,272)',
        '[11395,6537]ha (11395,279)ru (11675,256)ka (11932,463)na (12395,1119)yu (13515,353)me (13869,245)',
      ].join('\n'),
      sourceName: 'roma-qrc',
    });
    expect(roma.ok).toBe(true);
    if (!roma.ok) return;

    const merged = mergeLyricSupplements(primary.document, [{
      document: roma.document,
      role: 'pronunciation',
      toleranceMs: 2_000,
    }]);
    const lines = merged.lines.filter((line) => line.tracks !== null);
    const withPron = lines.filter((line) => (
      line.tracks?.foregroundPronunciation?.text?.trim()
    ));
    expect(withPron.length).toBeGreaterThanOrEqual(2);
    expect(withPron[0]?.tracks?.foregroundPronunciation?.text).toMatch(/ha\s*ru/i);
  });

  it('ignores empty or slash-only supplement rows', () => {
    const primary = parseLrc({
      text: '[00:01.00]hello\n[00:02.00]world',
      sourceName: 'primary',
    });
    expect(primary.ok).toBe(true);
    if (!primary.ok) return;
    const translation = parseLrc({
      text: '[00:01.00]/\n[00:02.00]世界',
      sourceName: 'translation',
    });
    expect(translation.ok).toBe(true);
    if (!translation.ok) return;
    const merged = mergeLyricSupplements(primary.document, [{
      document: translation.document,
      role: 'translation',
      toleranceMs: 500,
    }]);
    const lines = merged.lines.filter((line) => line.tracks !== null);
    expect(lines[0]?.translation).toBeUndefined();
    expect(lines[1]?.translation?.text).toBe('世界');
  });
});
