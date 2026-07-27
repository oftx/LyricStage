import { describe, expect, it } from 'vitest';
import { cleanBilibiliTitle, readMediaTitleInfo } from '../src/index.js';

function documentPort(
  entries: Record<string, { content?: string; text?: string }>,
  title = '',
) {
  return {
    title,
    location: { href: 'https://example.invalid/', pathname: '/', search: '' },
    querySelectorAll: () => [],
    querySelector: (selector: string) => {
      const hit = entries[selector];
      if (!hit) return null;
      return {
        getAttribute: (name: string) => (name === 'content' ? hit.content ?? null : null),
        textContent: hit.text ?? null,
      };
    },
  };
}

describe('cleanBilibiliTitle', () => {
  it('strips site suffixes and rewrites bangumi SEO tails', () => {
    expect(cleanBilibiliTitle('歌曲名_哔哩哔哩_bilibili')).toBe('歌曲名');
    expect(cleanBilibiliTitle('第3集-番剧-全集-高清正版在线观看')).toBe('第3话');
    expect(cleanBilibiliTitle('普通标题')).toBe('普通标题');
  });
});

describe('readMediaTitleInfo', () => {
  it('reads youtube title/creator from the DOM chain', () => {
    const doc = documentPort({
      'ytd-watch-metadata h1 yt-formatted-string': { text: ' Song Title ' },
      'ytd-watch-metadata #owner #channel-name a': { text: 'Channel' },
    });
    expect(readMediaTitleInfo('youtube', doc)).toEqual({
      title: 'Song Title',
      creators: ['Channel'],
    });
  });

  it('falls back to document.title with the YouTube suffix stripped', () => {
    const doc = documentPort({}, 'My Video - YouTube');
    expect(readMediaTitleInfo('youtube', doc).title).toBe('My Video');
  });

  it('reads bilibili og:title with suffix cleaning and up-name creator', () => {
    const doc = documentPort({
      'meta[property="og:title"]': { content: 'MV标题_哔哩哔哩_bilibili' },
      '.up-name': { text: ' UP主 ' },
    });
    expect(readMediaTitleInfo('bilibili', doc)).toEqual({
      title: 'MV标题',
      creators: ['UP主'],
    });
  });

  it('returns empty info when nothing matches', () => {
    const info = readMediaTitleInfo('bilibili', documentPort({}));
    expect(info.title).toBeNull();
    expect(info.creators).toEqual([]);
  });
});
