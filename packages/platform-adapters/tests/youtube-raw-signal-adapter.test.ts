import { describe, expect, it, vi } from 'vitest';
import {
  parseRawPlaybackSignal,
  SourceArbiter,
  StablePlaybackTimeline,
} from '@lyric-stage/playback-core';
import {
  isLikelyYouTubeAdvertisement,
  parseYouTubeRoute,
  YouTubeRawSignalAdapter,
} from '../src/index.js';

function videoStub(overrides: Partial<HTMLVideoElement> & {
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
} = {}): HTMLVideoElement {
  return {
    currentTime: overrides.currentTime ?? 12.5,
    duration: overrides.duration ?? 120,
    paused: overrides.paused ?? false,
    ended: overrides.ended ?? false,
    seeking: overrides.seeking ?? false,
    playbackRate: overrides.playbackRate ?? 1,
    readyState: overrides.readyState ?? 4,
    currentSrc: overrides.currentSrc ?? 'https://example.googlevideo.com/video',
    src: overrides.src ?? '',
    clientWidth: overrides.clientWidth ?? 640,
    clientHeight: overrides.clientHeight ?? 360,
    isConnected: overrides.isConnected ?? true,
    closest: () => null,
  } as unknown as HTMLVideoElement;
}

describe('parseYouTubeRoute', () => {
  it('parses watch and shorts ids', () => {
    expect(parseYouTubeRoute('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      type: 'watch',
      externalId: 'dQw4w9WgXcQ',
    });
    expect(parseYouTubeRoute('https://www.youtube.com/shorts/abcdefghijk')).toEqual({
      type: 'shorts',
      externalId: 'abcdefghijk',
    });
    expect(parseYouTubeRoute('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      type: 'watch',
      externalId: 'dQw4w9WgXcQ',
    });
  });
});

describe('YouTubeRawSignalAdapter', () => {
  it('emits a playback-core valid sample from a media element', () => {
    const video = videoStub();
    const documentPort = {
      location: {
        href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        pathname: '/watch',
        search: '?v=dQw4w9WgXcQ',
      },
      querySelectorAll: () => [video],
      querySelector: () => null,
    };
    let now = 1000;
    const adapter = new YouTubeRawSignalAdapter({
      document: documentPort,
      clock: { now: () => now },
      producerInstanceId: 'producer-test',
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
    const signal = adapter.sample();
    expect(signal).not.toBeNull();
    const parsed = parseRawPlaybackSignal(signal);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.value.mediaIdentity).toEqual({
      platform: 'youtube',
      externalId: 'dQw4w9WgXcQ',
      contextId: 'watch',
    });
    expect(parsed.value.positionMs).toBe(12_500);
    expect(parsed.value.playbackState).toBe('playing');
    expect(parsed.value.sourceKind).toBe('media-element');

    now = 1500;
    const second = adapter.sample();
    expect(second?.producerSequence).toBe(2);
  });

  it('does not treat residual empty ad containers as advertisements', () => {
    const video = videoStub({
      currentTime: 12,
      currentSrc: 'blob:https://www.youtube.com/abc',
    });
    const residual = { offsetWidth: 0, offsetHeight: 0, getClientRects: () => [] };
    const player = {
      classList: { contains: () => false },
      querySelector: () => residual,
    };
    expect(isLikelyYouTubeAdvertisement(player as unknown as Element, video)).toBe(false);
  });

  it('freezes content position while an advertisement is showing', () => {
    const video = videoStub({ currentTime: 3 });
    const player = {
      classList: { contains: (name: string) => name === 'ad-showing' },
      querySelector: () => null,
    };
    video.closest = () => player as unknown as Element;
    const documentPort = {
      location: {
        href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        pathname: '/watch',
        search: '?v=dQw4w9WgXcQ',
      },
      querySelectorAll: () => [video],
      querySelector: () => player as unknown as Element,
    };
    const adapter = new YouTubeRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 1 },
      producerInstanceId: 'producer-ad',
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
    // seed content position
    (video as { currentTime: number }).currentTime = 40;
    Object.assign(player.classList, { contains: () => false });
    const content = adapter.sample();
    expect(content?.positionMs).toBe(40_000);

    Object.assign(player.classList, {
      contains: (name: string) => name === 'ad-showing',
    });
    (video as { currentTime: number }).currentTime = 1;
    const ad = adapter.sample();
    expect(ad?.playbackState).toBe('buffering');
    expect(ad?.positionMs).toBe(40_000);
    expect(ad?.sourceKind).toBe('page-state');
    expect(isLikelyYouTubeAdvertisement(player as unknown as Element, video)).toBe(true);
  });

  it('keeps ad state on the authoritative source and freezes immediately', () => {
    const video = videoStub({ currentTime: 40 });
    let advertising = false;
    const player = {
      classList: { contains: () => advertising },
      querySelector: () => null,
    };
    video.closest = () => player as unknown as Element;
    const documentPort = {
      location: {
        href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        pathname: '/watch',
        search: '?v=dQw4w9WgXcQ',
      },
      querySelectorAll: () => [video],
      querySelector: () => player as unknown as Element,
    };
    let now = 0;
    const adapter = new YouTubeRawSignalAdapter({
      document: documentPort,
      clock: { now: () => now },
      producerInstanceId: 'producer-pipeline-ad',
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
    const arbiter = new SourceArbiter();
    const timeline = new StablePlaybackTimeline();
    const sessionId = 'session:youtube-ad';

    const content = adapter.sample();
    expect(content).not.toBeNull();
    if (!content) return;
    const initial = arbiter.observe(content, now);
    expect(initial.signalIsAuthoritative).toBe(true);
    timeline.startSession(sessionId, content, now);

    now = 250;
    advertising = true;
    (video as { currentTime: number }).currentTime = 1;
    const ad = adapter.sample();
    expect(ad).not.toBeNull();
    if (!ad) return;
    const adArbitration = arbiter.observe(ad, now);
    expect(ad.sourceInstanceId).toBe(content.sourceInstanceId);
    expect(adArbitration.signalIsAuthoritative).toBe(true);
    expect(adArbitration.changed).toBe(false);
    timeline.ingest(sessionId, ad, now);

    const frozen = timeline.getSnapshot(now + 1_000);
    expect(frozen?.playbackState).toBe('buffering');
    expect(frozen?.positionMs).toBe(40_250);
  });

  it('notifies listeners on start and interval', () => {
    const video = videoStub();
    const documentPort = {
      location: {
        href: 'https://www.youtube.com/watch?v=abcdefghi01',
        pathname: '/watch',
        search: '?v=abcdefghi01',
      },
      querySelectorAll: () => [video],
      querySelector: () => null,
    };
    const handlers: Array<() => void> = [];
    const adapter = new YouTubeRawSignalAdapter({
      document: documentPort,
      clock: { now: () => 10 },
      setIntervalFn: (handler) => {
        handlers.push(handler);
        return 7;
      },
      clearIntervalFn: vi.fn(),
    });
    const listener = vi.fn();
    adapter.start(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    handlers[0]?.();
    expect(listener).toHaveBeenCalledTimes(2);
    adapter.stop();
  });
});
