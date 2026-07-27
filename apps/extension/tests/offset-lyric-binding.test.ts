import { describe, expect, it } from 'vitest';
import {
  clearTimingOffset,
  loadGlobalTimingOffset,
  loadStoredTimingOffset,
  loadTimingOffset,
  OffsetLyricBinding,
  saveGlobalTimingOffset,
  saveTimingOffset,
} from '../src/surface/offset-lyric-binding.js';
import type { PlaybackSnapshot } from '@lyric-stage/player';

function sourceClock(positionMs: number) {
  const listeners = new Set<() => void>();
  return {
    clock: {
      getSnapshot: (): PlaybackSnapshot => ({
        positionMs,
        playing: true,
        rate: 1,
        seeking: false,
        revision: 1,
        discontinuity: null,
      }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    listeners,
  };
}

function memoryStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys: string | string[] | null) {
      const wanted = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (data.has(key)) out[key] = data.get(key);
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
  };
}

describe('OffsetLyricBinding', () => {
  it('advances lyric time by the offset and clamps at zero', () => {
    const { clock } = sourceClock(10_000);
    const binding = new OffsetLyricBinding(clock, () => {});
    binding.setOffsetMs(2_500);
    expect(binding.clock.getSnapshot().positionMs).toBe(12_500);
    binding.setOffsetMs(-15_000);
    expect(binding.clock.getSnapshot().positionMs).toBe(0);
  });

  it('maps click-seek lyric targets back to source time', () => {
    const seeks: number[] = [];
    const { clock } = sourceClock(0);
    const binding = new OffsetLyricBinding(clock, (positionMs) => seeks.push(positionMs));
    binding.setOffsetMs(3_000);
    binding.commands().seekTo(45_000);
    expect(seeks).toEqual([42_000]);
    binding.setOffsetMs(-3_000);
    binding.commands().seekTo(1_000);
    expect(seeks).toEqual([42_000, 4_000]);
  });

  it('notifies subscribers and bumps revision on offset change', () => {
    const { clock } = sourceClock(5_000);
    const binding = new OffsetLyricBinding(clock, () => {});
    let notified = 0;
    binding.clock.subscribe(() => { notified += 1; });
    const before = binding.clock.getSnapshot().revision;
    binding.setOffsetMs(100);
    expect(notified).toBe(1);
    expect(binding.clock.getSnapshot().revision).toBeGreaterThan(before);
    // Same value: no redundant notify.
    binding.setOffsetMs(100);
    expect(notified).toBe(1);
  });

  it('clamps offsets to ±60s', () => {
    const { clock } = sourceClock(0);
    const binding = new OffsetLyricBinding(clock, () => {});
    binding.setOffsetMs(120_000);
    expect(binding.offsetMs).toBe(60_000);
    binding.setOffsetMs(-999_999);
    expect(binding.offsetMs).toBe(-60_000);
  });
});

describe('timing offset persistence', () => {
  it('round-trips per media and removes zero entries', async () => {
    const storage = memoryStorage();
    await saveTimingOffset(storage, 'bilibili:BV1:p:1', 2_500);
    expect(await loadTimingOffset(storage, 'bilibili:BV1:p:1')).toBe(2_500);
    expect(await loadTimingOffset(storage, 'bilibili:BV2:p:1')).toBe(0);
    await saveTimingOffset(storage, 'bilibili:BV1:p:1', 0);
    expect(storage.data.size).toBe(0);
  });
});

describe('site-global timing offset', () => {
  it('stores per platform, independent of per-media keys', async () => {
    const storage = memoryStorage();
    await saveGlobalTimingOffset(storage, 'netease', 800);
    expect(await loadGlobalTimingOffset(storage, 'netease')).toBe(800);
    expect(await loadGlobalTimingOffset(storage, 'bilibili')).toBeNull();
    // Global never touches per-media keys.
    expect(await loadStoredTimingOffset(storage, 'netease:1')).toBeNull();
    // Deactivation removes the key entirely.
    await saveGlobalTimingOffset(storage, 'netease', null);
    expect(await loadGlobalTimingOffset(storage, 'netease')).toBeNull();
  });

  it('keepZero persists an explicit per-media 0 (opt out of the global)', async () => {
    const storage = memoryStorage();
    await saveTimingOffset(storage, 'netease:1', 0, { keepZero: true });
    // Stored 0 is distinguishable from "never calibrated".
    expect(await loadStoredTimingOffset(storage, 'netease:1')).toBe(0);
    await saveTimingOffset(storage, 'netease:2', 0);
    expect(await loadStoredTimingOffset(storage, 'netease:2')).toBeNull();
    // loadTimingOffset keeps the old 0 fallback for plain callers.
    expect(await loadTimingOffset(storage, 'netease:2')).toBe(0);
  });

  it('clearTimingOffset removes a per-media value (reset to ride the global)', async () => {
    const storage = memoryStorage();
    await saveTimingOffset(storage, 'netease:1', 1200);
    expect(await loadStoredTimingOffset(storage, 'netease:1')).toBe(1200);
    await clearTimingOffset(storage, 'netease:1');
    expect(await loadStoredTimingOffset(storage, 'netease:1')).toBeNull();
  });
});
