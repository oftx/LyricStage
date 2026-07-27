import { describe, expect, it } from 'vitest';
import {
  attachSecondaryTracks,
  looksLikeTimedLyricBody,
  normalizeFullwidthAscii,
  parsePrimaryDocument,
  stripEmptyTimedLines,
} from '../src/surface/parse-lyric-payload.js';
import type { LyricDocumentPayloadV1 } from '@lyric-stage/extension-protocol';

function payload(overrides: Partial<LyricDocumentPayloadV1> = {}): LyricDocumentPayloadV1 {
  return {
    mediaId: 'test:1',
    format: 'lrc',
    text: '[00:01.00] 第一行\n[00:03.00] 第二行',
    sourceName: 'test',
    revision: 1,
    ...overrides,
  };
}

describe('looksLikeTimedLyricBody', () => {
  it('recognizes LRC/QRC timing and rejects prose', () => {
    expect(looksLikeTimedLyricBody('[00:01.00] hi')).toBe(true);
    expect(looksLikeTimedLyricBody('[123,456] word')).toBe(true);
    expect(looksLikeTimedLyricBody('just a poem line\n\nanother')).toBe(false);
  });
});

describe('parsePrimaryDocument', () => {
  it('routes mislabeled untimed lrc through the plaintext parser', () => {
    const doc = parsePrimaryDocument(payload({
      format: 'lrc',
      text: '第一行\n\n第三行',
    }));
    expect(doc).not.toBeNull();
    // Plaintext keeps the blank poem row; timed LRC would have dropped it.
    expect(doc!.lines.length).toBeGreaterThanOrEqual(2);
  });

  it('never falls back from TTML to LRC on XML bodies', () => {
    const doc = parsePrimaryDocument(payload({
      format: 'ttml',
      text: '<tt><broken',
    }));
    expect(doc).toBeNull();
  });

  it('parses timed lrc normally', () => {
    const doc = parsePrimaryDocument(payload());
    expect(doc?.lines.some((line) => line.tracks?.foreground?.text.includes('第一行'))).toBe(true);
  });
});

describe('attachSecondaryTracks', () => {
  it('merges LRC translation and detects QRC-timed pronunciation', () => {
    const primary = parsePrimaryDocument(payload())!;
    const result = attachSecondaryTracks(primary, payload({
      translationText: '[00:01.00] first line\n[00:03.00] second line',
      pronunciationText: '[1000,2000]di (1000,500)yi (1500,500)hang',
    }));
    expect(result.hasTranslation).toBe(true);
    expect(result.hasPronunciation).toBe(true);
  });

  it('ignores useless secondary rows (QQ // padding)', () => {
    const primary = parsePrimaryDocument(payload())!;
    const result = attachSecondaryTracks(primary, payload({
      translationText: '[00:01.00] //\n[00:03.00] //',
    }));
    expect(result.hasTranslation).toBe(false);
  });
});

describe('blank timed lines (NetEase spacer rows)', () => {
  it('drops bare-timestamp and text-empty timed lines from primary docs', () => {
    const doc = parsePrimaryDocument(payload({
      format: 'lrc',
      // NetEase-style: a bare timestamp spacer and a timestamp with only spaces.
      text: '[00:01.00] 第一行\n[00:03.00]\n[00:05.00]   \n[00:07.00] 第二行',
    }));
    expect(doc).not.toBeNull();
    const texts = doc!.lines
      .filter((line) => line.tracks !== null)
      .map((line) => line.tracks!.foreground.text.trim());
    expect(texts).toEqual(['第一行', '第二行']);
  });

  it('keeps the spacer timestamp as the previous line end boundary', () => {
    const doc = parsePrimaryDocument(payload({
      format: 'lrc',
      text: '[00:01.00] 第一行\n[00:03.00]\n[00:30.00] 第二行',
    }));
    // The 00:03 spacer must still terminate 第一行 (not stretch it to 00:30),
    // which is what post-parse filtering (vs pre-parse text stripping) buys.
    const first = doc!.lines.find(
      (line) => line.tracks?.foreground.text.trim() === '第一行',
    );
    expect(first?.end.valueMs).toBe(3000);
  });

  it('keeps blank lines in plaintext (poem spacing)', () => {
    const doc = parsePrimaryDocument(payload({
      format: 'plaintext',
      text: '第一行\n\n第三行',
    }));
    expect(doc!.lines.length).toBeGreaterThanOrEqual(3);
  });

  it('stripEmptyTimedLines removes spacer rows from secondary bodies', () => {
    expect(stripEmptyTimedLines('[00:01.00] 译文\n[00:03.00]\n[00:05.00] 译二'))
      .toBe('[00:01.00] 译文\n[00:05.00] 译二');
    expect(stripEmptyTimedLines('[123,456]\n[789,100] word'))
      .toBe('[789,100] word');
  });
});

describe('multi-timestamp chorus lines (netease:31967045)', () => {
  it('reorders repeated-timestamp occurrences chronologically', () => {
    const doc = parsePrimaryDocument(payload({
      format: 'lrc',
      // ごめんね pattern: one source line carrying two timestamps far apart.
      text: '[00:10.00][00:40.00] 副歌行\n[00:12.00] 第二行\n[00:14.00] 第三行',
    }));
    expect(doc).not.toBeNull();
    const timed = doc!.lines.filter((line) => line.begin.valueMs !== null);
    expect(timed.map((line) => line.begin.valueMs)).toEqual([10_000, 12_000, 14_000, 40_000]);
    // Renderer order follows array order — the 40s occurrence must sit last.
    expect(timed[timed.length - 1]!.tracks!.foreground.text.trim()).toBe('副歌行');
  });

  it('leaves monotonic documents untouched (no re-index churn)', () => {
    const doc = parsePrimaryDocument(payload({
      format: 'lrc',
      text: '[00:01.00] 一\n[00:02.00] 二',
    }));
    expect(doc!.lines.map((line) => line.index)).toEqual(
      doc!.lines.map((_, i) => i),
    );
  });
});

describe('normalizeFullwidthAscii (romalrc glyph-width fix)', () => {
  it('folds fullwidth latin and ideographic space to halfwidth', () => {
    expect(normalizeFullwidthAscii('ｓｅ\u3000ｋａ ｉ')).toBe('se ka i');
    // Mixed body: only the fullwidth chars change.
    expect(normalizeFullwidthAscii('ka ｉ no')).toBe('ka i no');
  });

  it('applies to pronunciation tracks end to end', () => {
    const { document } = attachSecondaryTracks(
      parsePrimaryDocument(payload())!,
      payload({
        pronunciationText: '[00:01.00] ｋａｉ ta i\n[00:03.00] tsu',
      }),
    );
    const roma = document.lines
      .map((line) => line.tracks?.foregroundPronunciation?.text ?? '')
      .join(' ');
    expect(roma).toContain('kai ta i');
    expect(roma).not.toMatch(/[\uFF01-\uFF5E]/);
  });
});

describe('translation language consistency (netease:2013870113)', () => {
  it('stamps one document-level language across all translation lines', () => {
    const { document } = attachSecondaryTracks(
      parsePrimaryDocument(payload({
        text: '[00:01.00] 想像なんてしてなかった現状\n[00:03.00] 君もそう思った？',
      }))!,
      payload({
        // Line 1 has no Simplified-hint char (per-line inference gave
        // und-Hani -> JP font); line 2 has 这 (zh-Hans -> CN font).
        translationText: '[00:01.00] 未曾设想的现状\n[00:03.00] 你也是这样的吧?',
      }),
    );
    const langs = document.lines
      .map((line) =>
        line.tracks === null ? undefined : line.translation?.language.effective,
      )
      .filter((lang): lang is string => Boolean(lang));
    expect(langs.length).toBe(2);
    expect(new Set(langs).size).toBe(1);
    expect(langs[0]).toBe('zh-Hans');
  });
});
