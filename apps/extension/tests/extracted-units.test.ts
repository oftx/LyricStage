import { describe, expect, it } from 'vitest';
import {
  isWakeSourcesRequest,
  wakeMusicTabContentScripts,
  type WakeDependencies,
} from '../src/background/wake.js';
import {
  isPlaceholderMediaId,
  rankFailoverSessions,
} from '../src/background/selection-policy.js';
import { LyricRefreshController } from '../src/content/lyric-refresh.js';
import type { PortableLyricText } from '@lyric-stage/platform-adapters';

function wakeDeps(overrides: Partial<WakeDependencies> = {}): WakeDependencies & {
  readonly sent: Array<{ tabId: number; message: unknown }>;
  readonly injected: number[];
} {
  const sent: Array<{ tabId: number; message: unknown }> = [];
  const injected: number[] = [];
  return {
    sent,
    injected,
    queryTabs: async () => [{ id: 1 }],
    sendTabMessage: async (tabId, message) => {
      sent.push({ tabId, message });
      return { ok: true };
    },
    injectContentScript: async (tabId) => {
      injected.push(tabId);
    },
    liveTabIds: () => new Set<number>(),
    settle: async () => {},
    ...overrides,
  };
}

describe('wakeMusicTabContentScripts', () => {
  it('recognizes wake requests', () => {
    expect(isWakeSourcesRequest({ kind: 'lyric-stage-wake-sources' })).toBe(true);
    expect(isWakeSourcesRequest({ kind: 'other' })).toBe(false);
    expect(isWakeSourcesRequest(null)).toBe(false);
  });

  it('soft-pings live tabs without reinjecting', async () => {
    const deps = wakeDeps({ liveTabIds: () => new Set([1]) });
    const result = await wakeMusicTabContentScripts(deps);
    expect(result).toEqual({ tabs: 1, connected: 1, reinjected: 0 });
    expect(deps.injected).toEqual([]);
    expect(deps.sent).toHaveLength(1);
  });

  it('counts answering tabs as connected without injection', async () => {
    const deps = wakeDeps();
    const result = await wakeMusicTabContentScripts(deps);
    expect(result).toEqual({ tabs: 1, connected: 1, reinjected: 0 });
    expect(deps.injected).toEqual([]);
  });

  it('reinjects then re-pings when the tab does not answer', async () => {
    let calls = 0;
    const deps = wakeDeps({
      sendTabMessage: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Receiving end does not exist');
        return { ok: true };
      },
    });
    const result = await wakeMusicTabContentScripts(deps);
    expect(result).toEqual({ tabs: 1, connected: 1, reinjected: 1 });
    expect(deps.injected).toEqual([1]);
  });

  it('skips restricted tabs whose injection fails', async () => {
    const deps = wakeDeps({
      sendTabMessage: async () => {
        throw new Error('no receiver');
      },
      injectContentScript: async () => {
        throw new Error('restricted');
      },
    });
    const result = await wakeMusicTabContentScripts(deps);
    expect(result).toEqual({ tabs: 1, connected: 0, reinjected: 0 });
  });

  it('returns zeros when tab query rejects', async () => {
    const deps = wakeDeps({
      queryTabs: async () => {
        throw new Error('no permission');
      },
    });
    const result = await wakeMusicTabContentScripts(deps);
    expect(result).toEqual({ tabs: 0, connected: 0, reinjected: 0 });
  });
});

describe('wake message ordering (P0-2)', () => {
  it('recognizes a bare wake message that would fail envelope parsing', async () => {
    // The worker must check isWakeSourcesRequest BEFORE parseMessageEnvelopeV1;
    // this pins the classifier itself so the bare shape keeps matching.
    const bare = { kind: 'lyric-stage-wake-sources' };
    expect(isWakeSourcesRequest(bare)).toBe(true);
    const { parseMessageEnvelopeV1 } = await import('@lyric-stage/extension-protocol');
    expect(parseMessageEnvelopeV1(bare).ok).toBe(false);
  });
});

describe('selection policy', () => {
  it('flags placeholder media ids', () => {
    expect(isPlaceholderMediaId(null)).toBe(true);
    expect(isPlaceholderMediaId('media:unbound')).toBe(true);
    expect(isPlaceholderMediaId('media:unknown')).toBe(true);
    expect(isPlaceholderMediaId('qqmusic:unbound')).toBe(true);
    expect(isPlaceholderMediaId('qqmusic:002MicCm2pZIuc')).toBe(false);
  });

  it('ranks playing sources ahead of recently seen paused ones', () => {
    const ranked = rankFailoverSessions([
      { sessionId: 'paused-recent', lastState: 'paused', lastSeenAtMs: 300 },
      { sessionId: 'playing-old', lastState: 'playing', lastSeenAtMs: 100 },
      { sessionId: 'buffering', lastState: 'buffering', lastSeenAtMs: 200 },
      { sessionId: 'no-anchor', lastState: null, lastSeenAtMs: 400 },
    ]);
    expect(ranked).toEqual([
      'buffering',
      'playing-old',
      'no-anchor',
      'paused-recent',
    ]);
  });
});

function lyric(text = 'line one'): PortableLyricText {
  return { format: 'lrc', text, sourceName: 'test' };
}

interface RefreshHarness {
  controller: LyricRefreshController;
  readonly published: Array<{ mediaId: string; revision: number }>;
  platformValue: string;
  mediaIdValue: string;
  portOpenValue: boolean;
  platformRequests: number;
  nowMs: number;
  readonly resolved: Array<{ platform: string; externalId: string }>;
  readonly cleared: string[];
  /** Resolves pending platform fetches FIFO. */
  resolvePlatform: (result: { ok: boolean; text?: string }) => void;
}

function refreshHarness(): RefreshHarness {
  const published: Array<{ mediaId: string; revision: number }> = [];
  const pending: Array<(value: { ok: boolean; text?: string }) => void> = [];
  const harness: RefreshHarness = {
    controller: null as unknown as LyricRefreshController,
    published,
    platformValue: 'qqmusic',
    mediaIdValue: 'qqmusic:song1',
    portOpenValue: true,
    platformRequests: 0,
    nowMs: 0,
    resolved: [],
    cleared: [],
    resolvePlatform: (result) => {
      pending.shift()?.(result);
    },
  };
  harness.controller = new LyricRefreshController({
    platform: () => harness.platformValue,
    mediaId: () => harness.mediaIdValue,
    portOpen: () => harness.portOpenValue,
    now: () => harness.nowMs,
    onLyricResolved: (input) => {
      harness.resolved.push({ platform: input.platform, externalId: input.externalId });
    },
    parseMediaId: (id) => {
      const [platform, externalId] = id.split(':');
      return platform && externalId ? { platform, externalId } : null;
    },
    loadAppleMusicLyricText: async () => ({ ok: false }),
    loadPlatformLyricText: async () => {
      harness.platformRequests += 1;
      const outcome = await new Promise<{ ok: boolean; text?: string }>(
        (resolve) => {
          pending.push(resolve);
        },
      );
      return outcome.ok
        ? { ok: true, lyric: lyric(outcome.text) }
        : { ok: false };
    },
    applyMediaIdentity: () => {},
    publishLyric: (mediaId, revision) => {
      published.push({ mediaId, revision });
    },
    publishLyricClear: (mediaId) => {
      harness.cleared.push(mediaId);
    },
    publishSnapshotOrHold: () => {},
  });
  return harness;
}

describe('LyricRefreshController', () => {
  it('publishes once and dedups subsequent refreshes for the same media', async () => {
    const harness = refreshHarness();
    const first = harness.controller.refresh(false);
    harness.resolvePlatform({ ok: true });
    await first;
    expect(harness.published).toEqual([{ mediaId: 'qqmusic:song1', revision: 1 }]);
    await harness.controller.refresh(false);
    expect(harness.platformRequests).toBe(1);
  });

  it('single-flights concurrent refreshes for the same media', async () => {
    const harness = refreshHarness();
    const first = harness.controller.refresh(false);
    // Snapshot-driven refreshes while the first request is in flight no-op.
    const second = harness.controller.refresh(false);
    const third = harness.controller.refresh(true);
    await Promise.resolve();
    expect(harness.platformRequests).toBe(1);
    harness.resolvePlatform({ ok: true });
    await Promise.all([first, second, third]);
    expect(harness.published).toHaveLength(1);
  });

  it('backs off after failure instead of retrying every snapshot', async () => {
    const harness = refreshHarness();
    const first = harness.controller.refresh(false);
    harness.resolvePlatform({ ok: false });
    await first;
    expect(harness.published).toEqual([]);
    // Snapshot cadence during the backoff window: no new requests.
    await harness.controller.refresh(false);
    await harness.controller.refresh(false);
    expect(harness.platformRequests).toBe(1);
    // After the first 2s window a retry is allowed...
    harness.nowMs = 2_100;
    const retry = harness.controller.refresh(false);
    harness.resolvePlatform({ ok: false });
    await retry;
    expect(harness.platformRequests).toBe(2);
    // ...and the second failure doubles the window.
    harness.nowMs = 4_100;
    await harness.controller.refresh(false);
    expect(harness.platformRequests).toBe(2);
    harness.nowMs = 6_200;
    const third = harness.controller.refresh(false);
    harness.resolvePlatform({ ok: true });
    await third;
    expect(harness.platformRequests).toBe(3);
    expect(harness.published).toHaveLength(1);
  });

  it('fires onLyricResolved exactly once per success, never on failure', async () => {
    const harness = refreshHarness();
    const fail = harness.controller.refresh(false);
    harness.resolvePlatform({ ok: false });
    await fail;
    expect(harness.resolved).toEqual([]);
    harness.nowMs = 2_100;
    const succeed = harness.controller.refresh(false);
    harness.resolvePlatform({ ok: true });
    await succeed;
    expect(harness.resolved).toEqual([
      { platform: 'qqmusic', externalId: 'song1' },
    ]);
    // Deduped follow-up refresh does not re-fire.
    await harness.controller.refresh(false);
    expect(harness.resolved).toHaveLength(1);
  });

  it('publishes lyric-clear when a fetch definitively resolves empty', async () => {
    const harness = refreshHarness();
    const fail = harness.controller.refresh(false);
    harness.resolvePlatform({ ok: false });
    await fail;
    // Without this signal a surface showing the PREVIOUS track's lyrics had
    // no message that could ever clear them (user-reported: instrumental
    // next track kept rendering the prior song).
    expect(harness.cleared).toEqual(['qqmusic:song1']);
    // Success never emits a clear.
    harness.nowMs = 2_100;
    const succeed = harness.controller.refresh(false);
    harness.resolvePlatform({ ok: true });
    await succeed;
    expect(harness.cleared).toHaveLength(1);
  });

  it('media change clears failure backoff for the new track', async () => {
    const harness = refreshHarness();
    const first = harness.controller.refresh(false);
    harness.resolvePlatform({ ok: false });
    await first;
    // New track: resetBinding clears the slate; fetch proceeds immediately.
    harness.mediaIdValue = 'qqmusic:song2';
    harness.controller.resetBinding();
    const second = harness.controller.refresh(true);
    harness.resolvePlatform({ ok: true });
    await second;
    expect(harness.platformRequests).toBe(2);
    expect(harness.published).toEqual([{ mediaId: 'qqmusic:song2', revision: 1 }]);
  });

  it('drops a stale slow response after the media changed', async () => {
    const harness = refreshHarness();
    const slow = harness.controller.refresh(false);
    harness.mediaIdValue = 'qqmusic:song2';
    harness.controller.resetBinding();
    const fast = harness.controller.refresh(false);
    // Resolve FIFO: the slow (stale) request first, then the fresh one.
    harness.resolvePlatform({ ok: true, text: 'for song1' });
    await slow;
    harness.resolvePlatform({ ok: true, text: 'for song2' });
    await fast;
    expect(harness.published).toEqual([{ mediaId: 'qqmusic:song2', revision: 1 }]);
  });

  it('does not fetch for provisional ids and never publishes with the port closed', async () => {
    const harness = refreshHarness();
    harness.mediaIdValue = 'qqmusic:unbound-x';
    await harness.controller.refresh(true);
    expect(harness.platformRequests).toBe(0);

    harness.mediaIdValue = 'qqmusic:song1';
    harness.portOpenValue = false;
    await harness.controller.refresh(true);
    expect(harness.platformRequests).toBe(0);
  });
});
