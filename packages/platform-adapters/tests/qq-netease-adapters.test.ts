import { describe, expect, it } from 'vitest';
import { parseRawPlaybackSignal } from '@lyric-stage/playback-core';
import {
  AppleMusicRawSignalAdapter,
  detectPlatform,
  extractAppleMusicCatalogId,
  extractNeteaseSongId,
  extractQqSongMid,
  findAppleMusicCatalogIdFromDocument,
  findQqSongMidFromDocument,
  isQqPlayerPage,
  NeteaseRawSignalAdapter,
  QqMusicRawSignalAdapter,
  type PageClockSample,
} from '../src/index.js';

function mediaStub(overrides: Record<string, unknown> = {}) {
  return {
    currentTime: 10,
    duration: 200,
    paused: false,
    ended: false,
    seeking: false,
    playbackRate: 1,
    currentSrc: '',
    src: '',
    isConnected: true,
    getAttribute: () => null,
    ...overrides,
  } as unknown as HTMLMediaElement;
}

function pageClock(sample: PageClockSample) {
  return {
    getLatestSample: () => sample,
  };
}

describe('platform detection', () => {
  it('detects youtube qq netease and apple music hosts', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
    expect(detectPlatform('https://y.qq.com/n/ryqq/player')).toBe('qqmusic');
    expect(detectPlatform('https://music.163.com/#/song?id=123')).toBe('netease');
    expect(detectPlatform('https://music.apple.com/cn/song/foo/1158763993')).toBe('applemusic');
    expect(detectPlatform('https://example.com')).toBe('unknown');
  });
});

describe('QqMusicRawSignalAdapter', () => {
  it('extracts songmid and emits valid samples', () => {
    expect(extractQqSongMid('https://y.qq.com/n/ryqq/songDetail/00123456789012')).toBe(
      '00123456789012',
    );
    const audio = mediaStub({
      currentSrc: 'https://cdn.example/songmid=00123456789012',
      currentTime: 3.5,
    });
    const documentPort = {
      location: {
        href: 'https://y.qq.com/n/ryqq/player',
        pathname: '/n/ryqq/player',
        search: '',
      },
      querySelectorAll: (sel: string) => {
        if (sel.includes('data-songmid') || sel.includes('songDetail')) {
          return [{
            getAttribute: (name: string) => (name === 'data-songmid' ? '00123456789012' : null),
          }];
        }
        if (sel.includes('audio')) return [audio];
        return [];
      },
      querySelector: () => null,
    };
    const adapter = new QqMusicRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 50 },
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
    const signal = adapter.sample();
    expect(signal).not.toBeNull();
    const parsed = parseRawPlaybackSignal(signal);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.value.mediaIdentity).toEqual({
      platform: 'qqmusic',
      externalId: '00123456789012',
    });
    expect(parsed.value.positionMs).toBe(3500);
  });

  it('recognizes QQ media filenames and prefers the currently playing marker', () => {
    expect(extractQqSongMid(
      'https://isure.stream.qqmusic.qq.com/M800001e7VNQ43nv4W.mp3',
    )).toBe('001e7VNQ43nv4W');
    const activeSelector = [
      '.player_music__info a[href*="/songDetail/"]',
      '.songlist__item--playing [data-songmid]',
      '.songlist__item--playing [data-mid]',
      '.songlist__item--playing a[href*="/songDetail/"]',
      '[aria-current="true"][data-songmid]',
      '[aria-current="true"][data-mid]',
    ].join(', ');
    const documentPort = {
      location: {
        href: 'https://y.qq.com/n/ryqq_v2/player',
        pathname: '/n/ryqq_v2/player',
        search: '',
      },
      querySelector: (selector: string) => selector === activeSelector
        ? { getAttribute: (name: string) => name === 'href' ? '/n/ryqq_v2/songDetail/001e7VNQ43nv4W?' : null }
        : null,
      querySelectorAll: () => [{
        getAttribute: (name: string) => name === 'data-songmid' ? '0039MnYb0qxYhV' : null,
      }],
    };

    const adapter = new QqMusicRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 10 },
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });

    expect(adapter.sample()?.mediaIdentity).toEqual({
      platform: 'qqmusic',
      externalId: '001e7VNQ43nv4W',
    });
  });

  it('uses the trusted page clock when the isolated world has no media node', () => {
    const activeSelector = [
      '.player_music__info a[href*="/songDetail/"]',
      '.songlist__item--playing [data-songmid]',
      '.songlist__item--playing [data-mid]',
      '.songlist__item--playing a[href*="/songDetail/"]',
      '[aria-current="true"][data-songmid]',
      '[aria-current="true"][data-mid]',
    ].join(', ');
    const documentPort = {
      location: {
        href: 'https://y.qq.com/n/ryqq_v2/player',
        pathname: '/n/ryqq_v2/player',
        search: '',
      },
      querySelectorAll: () => [],
      querySelector: (selector: string) => {
        if (selector === activeSelector) {
          return { getAttribute: () => '/n/ryqq_v2/songDetail/001e7VNQ43nv4W?' };
        }
        return null;
      },
    };
    const adapter = new QqMusicRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 48_000 },
      pageClock: pageClock({
        positionMs: 47_000,
        durationMs: 239_000,
        playbackState: 'playing',
        rate: 1,
        seeking: false,
        sourceKind: 'media-element',
        confidence: 0.95,
        mediaExternalIdHint: null,
        capturedAtMs: 47_500,
      }),
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });

    const signal = adapter.sample();

    expect(signal).toMatchObject({
      // Sample was captured 500ms before this poll; playing samples are
      // age-projected so downstream sees true "now" position.
      positionMs: 47_500,
      durationMs: 239_000,
      playbackState: 'playing',
      sourceKind: 'media-element',
      sourceInstanceId: 'qqmusic:001e7VNQ43nv4W:playback',
      mediaIdentity: { platform: 'qqmusic', externalId: '001e7VNQ43nv4W' },
      confidence: 0.95,
      eventKind: 'sample',
    });
    expect(parseRawPlaybackSignal(signal).success).toBe(true);
  });

  it('reports source-lost instead of scraping the progress bar without a page clock', () => {
    const documentPort = {
      location: {
        href: 'https://y.qq.com/n/ryqq_v2/player',
        pathname: '/n/ryqq_v2/player',
        search: '',
      },
      querySelectorAll: () => [],
      querySelector: (selector: string) => {
        if (selector.includes('.player_music__info')) {
          return { getAttribute: () => '/n/ryqq_v2/songDetail/001e7VNQ43nv4W?' };
        }
        // Progress UI still present, but must never become the timeline.
        if (selector === '.player_music__time') {
          return { textContent: '03:59 / 03:59', getAttribute: () => null };
        }
        if (selector.includes('.player_progress__play')) {
          return { getAttribute: () => 'width: 100.18%; margin-left: 0px;' };
        }
        return null;
      },
    };
    const adapter = new QqMusicRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 240_000 },
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });

    expect(adapter.sample()).toMatchObject({
      playbackState: 'unavailable',
      sourceKind: 'page-state',
      eventKind: 'source-lost',
      mediaIdentity: { platform: 'qqmusic', externalId: '001e7VNQ43nv4W' },
      confidence: 0.25,
    });
  });
});

describe('NeteaseRawSignalAdapter', () => {
  it('extracts song id and emits valid samples', () => {
    expect(extractNeteaseSongId('https://music.163.com/song?id=186016')).toBe('186016');
    const audio = mediaStub({
      currentTime: 8,
      paused: true,
      currentSrc: 'https://m701.music.126.net/demo.mp3',
      src: 'https://m701.music.126.net/demo.mp3',
    });
    const documentPort = {
      location: {
        href: 'https://music.163.com/#/song?id=186016',
        pathname: '/',
        search: '',
      },
      querySelectorAll: (sel: string) => (sel === 'audio' ? [audio] : []),
      querySelector: (sel: string) => {
        if (sel.includes('song?id=')) {
          return {
            getAttribute: () => '/song?id=186016',
          } as unknown as Element;
        }
        return null;
      },
    };
    const adapter = new NeteaseRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 9 },
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
    const signal = adapter.sample();
    const parsed = parseRawPlaybackSignal(signal);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.value.mediaIdentity).toEqual({
      platform: 'netease',
      externalId: '186016',
    });
    expect(parsed.value.playbackState).toBe('paused');
    expect(parsed.value.positionMs).toBe(8000);
  });

  it('uses the trusted page clock when the isolated world has no audio node', () => {
    const songLink = {
      getAttribute: (name: string) => name === 'href' ? '/song?id=3369666014' : null,
    };
    const documentPort = {
      location: {
        href: 'https://music.163.com/#/playlist?id=17950787380',
        pathname: '/',
        search: '',
      },
      querySelectorAll: () => [],
      querySelector: (selector: string) => {
        if (selector.includes('/song?id=')) return songLink;
        return null;
      },
    };
    const adapter = new NeteaseRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 25_000 },
      pageClock: pageClock({
        positionMs: 194_000,
        durationMs: 248_000,
        playbackState: 'playing',
        rate: 1,
        seeking: false,
        sourceKind: 'media-element',
        confidence: 0.95,
        mediaExternalIdHint: null,
        capturedAtMs: 24_500,
      }),
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });

    const signal = adapter.sample();

    expect(signal).toMatchObject({
      // 500ms old playing sample → age-projected forward.
      positionMs: 194_500,
      durationMs: 248_000,
      playbackState: 'playing',
      sourceKind: 'media-element',
      sourceInstanceId: 'netease:3369666014:playback',
      mediaIdentity: { platform: 'netease', externalId: '3369666014' },
      confidence: 0.95,
      eventKind: 'sample',
    });
    expect(parseRawPlaybackSignal(signal).success).toBe(true);
  });

  it('prefers a high-confidence page clock over a stale paused DOM audio', () => {
    const audio = mediaStub({
      currentTime: 1,
      duration: 200,
      paused: true,
      currentSrc: 'https://m701.music.126.net/demo.mp3',
    });
    const songLink = {
      getAttribute: (name: string) => (name === 'href' ? '/song?id=186016' : null),
    };
    const documentPort = {
      location: {
        href: 'https://music.163.com/#/song?id=186016',
        pathname: '/',
        search: '',
      },
      querySelectorAll: (selector: string) => (selector === 'audio' ? [audio] : []),
      querySelector: (selector: string) => {
        if (selector.includes('/song?id=')) return songLink;
        return null;
      },
    };
    const adapter = new NeteaseRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 50 },
      pageClock: pageClock({
        positionMs: 42_000,
        durationMs: 200_000,
        playbackState: 'playing',
        rate: 1,
        seeking: false,
        sourceKind: 'platform-api',
        confidence: 0.96,
        mediaExternalIdHint: '186016',
        capturedAtMs: 49,
      }),
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
    expect(adapter.sample()).toMatchObject({
      positionMs: 42_001,
      playbackState: 'playing',
      sourceKind: 'platform-api',
      mediaIdentity: { platform: 'netease', externalId: '186016' },
    });
  });

  it('keeps one source identity while moving between isolated media and page clock', () => {
    let exposeAudio = true;
    const audio = mediaStub({
      currentTime: 10,
      duration: 200,
      currentSrc: 'https://m701.music.126.net/demo.mp3',
    });
    const songLink = {
      getAttribute: (name: string) => name === 'href' ? '/song?id=186016' : null,
    };
    const documentPort = {
      location: {
        href: 'https://music.163.com/#/song?id=186016',
        pathname: '/',
        search: '',
      },
      querySelectorAll: (selector: string) => selector === 'audio' && exposeAudio ? [audio] : [],
      querySelector: (selector: string) => {
        if (selector.includes('.words a[href*="/song?id="]')) return songLink;
        return null;
      },
    };
    const adapter = new NeteaseRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 100 },
      pageClock: pageClock({
        positionMs: 11_000,
        durationMs: 200_000,
        playbackState: 'playing',
        rate: 1,
        seeking: false,
        sourceKind: 'media-element',
        confidence: 0.95,
        mediaExternalIdHint: null,
        capturedAtMs: 90,
      }),
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });

    const mediaSignal = adapter.sample();
    exposeAudio = false;
    const pageSignal = adapter.sample();

    expect(mediaSignal?.sourceKind).toBe('media-element');
    expect(pageSignal?.sourceKind).toBe('media-element');
    expect(pageSignal?.positionMs).toBe(11_010);
    expect(pageSignal?.sourceInstanceId).toBe(mediaSignal?.sourceInstanceId);
    expect(pageSignal?.sessionCandidateId).toBe(mediaSignal?.sessionCandidateId);
  });

  it('reports source-lost instead of scraping .m-pbar without a page clock', () => {
    const songLink = {
      getAttribute: (name: string) => name === 'href' ? '/song?id=186016' : null,
    };
    const documentPort = {
      location: {
        href: 'https://music.163.com/#/song?id=186016',
        pathname: '/',
        search: '',
      },
      querySelectorAll: () => [],
      querySelector: (selector: string) => {
        if (selector.includes('/song?id=')) return songLink;
        if (selector === '#g_player .m-pbar .cur') {
          return { getAttribute: () => 'width: 50%;' };
        }
        return null;
      },
    };
    const adapter = new NeteaseRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 100 },
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });

    expect(adapter.sample()).toMatchObject({
      playbackState: 'unavailable',
      sourceKind: 'page-state',
      eventKind: 'source-lost',
      mediaIdentity: { platform: 'netease', externalId: '186016' },
      confidence: 0.25,
    });
  });
});

describe('AppleMusicRawSignalAdapter', () => {
  it('extracts catalog id from song and album-with-i URLs', () => {
    expect(extractAppleMusicCatalogId(
      'https://music.apple.com/cn/song/drive/1158763993',
    )).toBe('1158763993');
    expect(extractAppleMusicCatalogId(
      'https://music.apple.com/us/album/foo/123456?i=1158763993',
    )).toBe('1158763993');
  });

  it('does not invent catalog ids from browse-page song links only', () => {
    const documentPort = {
      location: {
        href: 'https://music.apple.com/cn/browse',
        pathname: '/cn/browse',
        search: '',
      },
      querySelectorAll: () => [],
      querySelector: (sel: string) => {
        // Non-player page links must be ignored.
        if (sel === 'a[href*="/song/"]') {
          return { getAttribute: () => '/cn/song/wrong/999' };
        }
        return null;
      },
    };
    expect(findAppleMusicCatalogIdFromDocument(documentPort)).toBeNull();
  });

  it('emits samples from the trusted MusicKit page clock', () => {
    const documentPort = {
      location: {
        href: 'https://music.apple.com/cn/song/drive/1158763993',
        pathname: '/cn/song/drive/1158763993',
        search: '',
      },
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const adapter = new AppleMusicRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 12_000 },
      pageClock: pageClock({
        positionMs: 42_500,
        durationMs: 198_000,
        playbackState: 'playing',
        rate: 1,
        seeking: false,
        sourceKind: 'platform-api',
        confidence: 0.98,
        mediaExternalIdHint: '1158763993',
        capturedAtMs: 11_500,
      }),
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });

    const signal = adapter.sample();
    expect(signal).toMatchObject({
      // 500ms old playing sample → age-projected.
      positionMs: 43_000,
      durationMs: 198_000,
      playbackState: 'playing',
      sourceKind: 'platform-api',
      mediaIdentity: { platform: 'applemusic', externalId: '1158763993' },
      confidence: 0.98,
      eventKind: 'sample',
    });
    expect(parseRawPlaybackSignal(signal).success).toBe(true);
  });

  it('prefers page-clock nowPlaying id over page URL after track changes', () => {
    // URL still points at song A while MusicKit nowPlaying is song B — common
    // on music.apple.com SPA after the first track.
    const documentPort = {
      location: {
        href: 'https://music.apple.com/cn/song/old/1111111111',
        pathname: '/cn/song/old/1111111111',
        search: '',
      },
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const adapter = new AppleMusicRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 20_000 },
      pageClock: pageClock({
        positionMs: 8_000,
        durationMs: 180_000,
        playbackState: 'playing',
        rate: 1,
        seeking: false,
        sourceKind: 'platform-api',
        confidence: 0.98,
        mediaExternalIdHint: '2222222222',
        capturedAtMs: 19_500,
      }),
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
    expect(adapter.sample()).toMatchObject({
      mediaIdentity: { platform: 'applemusic', externalId: '2222222222' },
      // 500ms old playing sample → age-projected.
      positionMs: 8_500,
    });
  });

  it('advertises applemusic:listening when MusicKit has no catalog id yet', () => {
    const documentPort = {
      location: {
        href: 'https://music.apple.com/cn/browse',
        pathname: '/cn/browse',
        search: '',
      },
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const adapter = new AppleMusicRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 1_000 },
      pageClock: pageClock({
        positionMs: 0,
        durationMs: null,
        playbackState: 'paused',
        rate: 1,
        seeking: false,
        sourceKind: 'platform-api',
        confidence: 0.2,
        mediaExternalIdHint: null,
        capturedAtMs: 900,
      }),
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
    expect(adapter.sample()).toMatchObject({
      mediaIdentity: { platform: 'applemusic', externalId: 'listening' },
      positionMs: 0,
    });
  });
});


describe('qq player-page evidence gating', () => {
  const playerHref = 'https://y.qq.com/n/ryqq_v2/player';
  const homeHref = 'https://y.qq.com/';
  const detailHref = 'https://y.qq.com/n/ryqq_v2/songDetail/002MicCm2pZIuc';

  it('classifies player vs non-player pages', () => {
    expect(isQqPlayerPage(playerHref)).toBe(true);
    expect(isQqPlayerPage(playerHref + '?x=1')).toBe(true);
    expect(isQqPlayerPage(homeHref)).toBe(false);
    expect(isQqPlayerPage(detailHref)).toBe(false);
    expect(isQqPlayerPage('https://example.com/n/ryqq_v2/player')).toBe(false);
  });

  it('ignores document-wide link markers unless explicitly allowed', () => {
    const linkOnlyDocument = {
      location: { href: homeHref, pathname: '/', search: '' },
      querySelector: () => null,
      querySelectorAll: (selector: string) => (
        selector.includes('songDetail')
          ? [{
            getAttribute: (name: string) => (
              name === 'href' ? '/n/ryqq_v2/songDetail/003gUSz24CSQsT' : null
            ),
          }]
          : []
      ),
    };
    // Default (off-player) scan finds nothing from bare links.
    expect(findQqSongMidFromDocument(linkOnlyDocument)).toBeNull();
    // Player page opts into the wide fallback and still resolves.
    expect(findQqSongMidFromDocument(linkOnlyDocument, {
      includeDocumentWideFallback: true,
    })).toBe('003gUSz24CSQsT');
  });

  it('still honors active-player markers on any page', () => {
    const activeMarkerDocument = {
      location: { href: homeHref, pathname: '/', search: '' },
      querySelector: () => ({
        getAttribute: (name: string) => (
          name === 'data-songmid' ? '004ActiveSong0' : null
        ),
      }),
      querySelectorAll: () => [],
    };
    expect(findQqSongMidFromDocument(activeMarkerDocument)).toBe('004ActiveSong0');
  });
});
