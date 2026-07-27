import { describe, expect, it } from 'vitest';
import { parseRawPlaybackSignal } from '@lyric-stage/playback-core';
import {
  BilibiliRawSignalAdapter,
  isBilibiliHost,
  parseBilibiliRoute,
  readBilibiliPageNumber,
  resolveBilibiliEpisodeId,
} from '../src/index.js';

function videoStub(overrides: {
  currentTime?: number;
  duration?: number;
  paused?: boolean;
  ended?: boolean;
  seeking?: boolean;
  playbackRate?: number;
  readyState?: number;
  currentSrc?: string;
  src?: string;
  clientWidth?: number;
  clientHeight?: number;
  isConnected?: boolean;
} = {}) {
  return {
    currentTime: overrides.currentTime ?? 30.5,
    duration: overrides.duration ?? 240,
    paused: overrides.paused ?? false,
    ended: overrides.ended ?? false,
    seeking: overrides.seeking ?? false,
    playbackRate: overrides.playbackRate ?? 1,
    readyState: overrides.readyState ?? 4,
    currentSrc: overrides.currentSrc ?? 'blob:https://www.bilibili.com/abc',
    src: overrides.src ?? '',
    clientWidth: overrides.clientWidth ?? 960,
    clientHeight: overrides.clientHeight ?? 540,
    isConnected: overrides.isConnected ?? true,
    closest: () => null,
  };
}

function documentPort(
  href: string,
  videos: unknown[] = [],
  selectorResults: Record<string, { getAttribute(name: string): string | null }> = {},
) {
  const url = new URL(href);
  return {
    location: { href, pathname: url.pathname, search: url.search },
    querySelectorAll: () => videos as never[],
    querySelector: (selector: string) => selectorResults[selector] ?? null,
  };
}

describe('parseBilibiliRoute', () => {
  it('parses BV, av, and bangumi routes with normalized casing', () => {
    expect(parseBilibiliRoute('https://www.bilibili.com/video/BV1xx411c7mD')).toEqual({
      type: 'video',
      externalId: 'BV1xx411c7mD',
    });
    expect(parseBilibiliRoute('https://www.bilibili.com/video/bv1XX411C7MD/')).toEqual({
      type: 'video',
      externalId: 'BV1XX411C7MD',
    });
    expect(parseBilibiliRoute('https://www.bilibili.com/video/AV170001')).toEqual({
      type: 'video',
      externalId: 'av170001',
    });
    expect(parseBilibiliRoute('https://www.bilibili.com/bangumi/play/ep123456')).toEqual({
      type: 'bangumi',
      externalId: 'ep123456',
    });
    expect(parseBilibiliRoute('https://www.bilibili.com/bangumi/play/ss4152')).toEqual({
      type: 'bangumi',
      externalId: 'ss4152',
    });
  });

  it('rejects non-player pages and foreign hosts', () => {
    expect(parseBilibiliRoute('https://www.bilibili.com/')).toBeNull();
    expect(parseBilibiliRoute('https://space.bilibili.com/12345')).toBeNull();
    expect(parseBilibiliRoute('https://example.com/video/BV1xx411c7mD')).toBeNull();
    expect(isBilibiliHost('https://www.bilibili.com/video/BV1xx411c7mD')).toBe(true);
    expect(isBilibiliHost('https://space.bilibili.com/1')).toBe(false);
  });
});

describe('readBilibiliPageNumber', () => {
  it('prefers the ?p= query, then the active playlist anchor, then 1', () => {
    const doc = documentPort('https://www.bilibili.com/video/BV1xx411c7mD?p=3');
    expect(readBilibiliPageNumber(doc.location.href, doc)).toBe(3);

    const withAnchor = documentPort(
      'https://www.bilibili.com/video/BV1xx411c7mD',
      [],
      {
        '.video-pod__item.active a[href*="?p="]': {
          getAttribute: (name) => (name === 'href' ? '/video/BV1xx411c7mD?p=5' : null),
        },
      },
    );
    expect(readBilibiliPageNumber(withAnchor.location.href, withAnchor)).toBe(5);

    const plain = documentPort('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(readBilibiliPageNumber(plain.location.href, plain)).toBe(1);
  });
});

describe('resolveBilibiliEpisodeId', () => {
  it('resolves the episode from canonical link or og:url', () => {
    const doc = documentPort('https://www.bilibili.com/bangumi/play/ss4152', [], {
      'link[rel="canonical"]': {
        getAttribute: (name) => (
          name === 'href' ? 'https://www.bilibili.com/bangumi/play/ep123456' : null
        ),
      },
    });
    expect(resolveBilibiliEpisodeId(doc)).toBe('ep123456');
    expect(resolveBilibiliEpisodeId(
      documentPort('https://www.bilibili.com/bangumi/play/ss4152'),
    )).toBeNull();
  });
});

describe('BilibiliRawSignalAdapter', () => {
  function makeAdapter(doc: ReturnType<typeof documentPort>) {
    return new BilibiliRawSignalAdapter({
      document: doc,
      clock: { now: () => 1_000 },
      producerInstanceId: 'producer-test',
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
  }

  it('emits a playback-core valid sample with part-scoped identity', () => {
    const doc = documentPort(
      'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
      [videoStub()],
    );
    const signal = makeAdapter(doc).sample();
    expect(signal).not.toBeNull();
    expect(parseRawPlaybackSignal(signal)).not.toBeNull();
    expect(signal?.mediaIdentity).toEqual({
      platform: 'bilibili',
      externalId: 'BV1xx411c7mD',
      contextId: 'p:2',
    });
    expect(signal?.positionMs).toBe(30_500);
    expect(signal?.durationMs).toBe(240_000);
    expect(signal?.playbackState).toBe('playing');
    expect(signal?.sourceKind).toBe('media-element');
    expect(signal?.confidence).toBe(1);
  });

  it('rotates the session candidate on part switch and video change', () => {
    const doc = documentPort(
      'https://www.bilibili.com/video/BV1xx411c7mD?p=1',
      [videoStub()],
    );
    const adapter = makeAdapter(doc);
    const first = adapter.sample();
    // Same identity: session candidate is stable.
    expect(adapter.sample()?.sessionCandidateId).toBe(first?.sessionCandidateId);
    // Part switch rotates the session.
    doc.location = {
      href: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
      pathname: '/video/BV1xx411c7mD',
      search: '?p=2',
    } as never;
    const second = adapter.sample();
    expect(second?.sessionCandidateId).not.toBe(first?.sessionCandidateId);
    expect(second?.mediaIdentity?.contextId).toBe('p:2');
    // SPA navigation to a different video rotates again.
    doc.location = {
      href: 'https://www.bilibili.com/video/av170001',
      pathname: '/video/av170001',
      search: '',
    } as never;
    const third = adapter.sample();
    expect(third?.sessionCandidateId).not.toBe(second?.sessionCandidateId);
    expect(third?.mediaIdentity?.externalId).toBe('av170001');
  });

  it('reports source-lost with identity when the video is missing', () => {
    const doc = documentPort('https://www.bilibili.com/video/BV1xx411c7mD', []);
    const signal = makeAdapter(doc).sample();
    expect(signal?.eventKind).toBe('source-lost');
    expect(signal?.playbackState).toBe('unavailable');
    expect(signal?.mediaIdentity?.externalId).toBe('BV1xx411c7mD');
    expect(signal?.confidence).toBe(0.2);
  });

  it('reports nothing bindable off player pages', () => {
    const doc = documentPort('https://www.bilibili.com/', []);
    const signal = makeAdapter(doc).sample();
    expect(signal?.eventKind).toBe('source-lost');
    expect(signal?.mediaIdentity).toBeNull();
    expect(signal?.confidence).toBe(0);
  });

  it('prefers the playing player video over larger idle previews', () => {
    const preview = videoStub({
      paused: true,
      clientWidth: 1920,
      clientHeight: 1080,
      readyState: 0,
    });
    const player = videoStub({ paused: false, clientWidth: 640, clientHeight: 360 });
    const doc = documentPort(
      'https://www.bilibili.com/video/BV1xx411c7mD',
      [preview, player],
    );
    const signal = makeAdapter(doc).sample();
    expect(signal?.playbackState).toBe('playing');
    expect(signal?.positionMs).toBe(30_500);
  });

  it('resolves bangumi ss to the episode when the document exposes it', () => {
    const doc = documentPort(
      'https://www.bilibili.com/bangumi/play/ss4152',
      [videoStub()],
      {
        'link[rel="canonical"]': {
          getAttribute: (name) => (
            name === 'href' ? 'https://www.bilibili.com/bangumi/play/ep123456' : null
          ),
        },
      },
    );
    const signal = makeAdapter(doc).sample();
    expect(signal?.mediaIdentity).toEqual({
      platform: 'bilibili',
      externalId: 'ep123456',
    });
  });
});
