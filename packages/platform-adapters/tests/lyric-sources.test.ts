import { describe, expect, it } from 'vitest';
import { parseMediaId } from '../src/lyrics/load-platform-lyrics.js';
import { stripNeteaseNonLyricLines } from '../src/lyrics/netease-lyric-source.js';

describe('parseMediaId', () => {
  it('splits platform and external id', () => {
    expect(parseMediaId('netease:1859245776')).toEqual({
      platform: 'netease',
      externalId: '1859245776',
    });
    expect(parseMediaId('qqmusic:004Z8Ihr0JIu5s')).toEqual({
      platform: 'qqmusic',
      externalId: '004Z8Ihr0JIu5s',
    });
  });

  it('rejects invalid ids', () => {
    expect(parseMediaId('')).toBeNull();
    expect(parseMediaId('nocolon')).toBeNull();
    expect(parseMediaId(':only')).toBeNull();
  });
});

describe('stripNeteaseNonLyricLines', () => {
  it('removes NetEase JSON credit lines and keeps timed lyrics', () => {
    const input = [
      '{"t":0,"c":[{"tx":"作词: "},{"tx":"一之瀬ユウ"}]}',
      '{"t":0,"c":[{"tx":"作词: "},{"tx":"一之瀬ユウ"}]}',
      '{"t":226,"c":[{"tx":"作曲: "},{"tx":"一之瀬ユウ"}]}',
      '{"t":452,"c":[{"tx":"编曲: "},{"tx":"一之瀬ユウ"}]}',
      '[00:00.68]ねえ もしも全て投げ捨てられたら',
      '[00:06.52]笑って生きることが楽になるの',
    ].join('\n');
    const out = stripNeteaseNonLyricLines(input);
    expect(out).toBe([
      '[00:00.68]ねえ もしも全て投げ捨てられたら',
      '[00:06.52]笑って生きることが楽になるの',
    ].join('\n'));
    expect(out).not.toContain('作词');
    expect(out).not.toContain('"tx"');
  });

  it('keeps ordinary LRC metadata tags', () => {
    const input = '[ti:title]\n[00:01.00]hello';
    expect(stripNeteaseNonLyricLines(input)).toBe(input);
  });
});
