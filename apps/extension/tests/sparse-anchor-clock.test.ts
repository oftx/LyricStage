import { describe, expect, it } from 'vitest';
import type { SparsePlaybackAnchorV1 } from '@lyric-stage/extension-protocol';
import { createSparseAnchorClock } from '../src/surface/sparse-anchor-clock.js';

function anchor(
  overrides: Partial<SparsePlaybackAnchorV1> = {},
): SparsePlaybackAnchorV1 {
  return {
    protocolVersion: 1,
    sessionId: 'session:test',
    generation: 1,
    mediaId: 'media:demo',
    positionMs: 10_000,
    rate: 1,
    state: 'playing',
    producedAtMs: 1,
    sequence: 1,
    ...overrides,
  };
}

describe('createSparseAnchorClock', () => {
  it('projects playing anchors forward from receive time', () => {
    let now = 1_000;
    const clock = createSparseAnchorClock(() => now, () => 1_700_000_000_000);
    clock.applyAnchor(anchor({ positionMs: 5_000, state: 'playing' }));
    now = 2_500;
    const snap = clock.getSnapshot();
    expect(snap.playing).toBe(true);
    expect(snap.positionMs).toBe(6_500);
  });

  it('freezes while paused', () => {
    let now = 100;
    const clock = createSparseAnchorClock(() => now, () => 1_700_000_000_000);
    clock.applyAnchor(anchor({ positionMs: 20_000, state: 'paused', sequence: 2 }));
    now = 5_000;
    const snap = clock.getSnapshot();
    expect(snap.playing).toBe(false);
    expect(snap.positionMs).toBe(20_000);
  });

  it('marks seek discontinuity on large backward jump', () => {
    let now = 0;
    const clock = createSparseAnchorClock(() => now, () => 1_700_000_000_000);
    clock.applyAnchor(anchor({ positionMs: 90_000, sequence: 1 }));
    now = 10;
    clock.applyAnchor(anchor({ positionMs: 1_000, sequence: 2 }));
    const snap = clock.getSnapshot();
    expect(snap.discontinuity?.reason).toBe('seek');
  });

  it('coasts smoothly and only micro-slews toward lagging content', () => {
    let now = 1_000;
    let wall = 1_700_000_000_000;
    const clock = createSparseAnchorClock(() => now, () => wall);
    clock.applyAnchor(anchor({
      positionMs: 5_000,
      state: 'playing',
      sequence: 1,
      producedAtMs: wall,
    }));

    // Content heartbeats lag coast by ~200ms (would sawtooth if hard-snapped).
    const samples = [
      { t: 1_250, pos: 5_050 },
      { t: 1_500, pos: 5_300 },
      { t: 1_750, pos: 5_550 },
      { t: 2_000, pos: 5_800 },
    ];
    for (const sample of samples) {
      now = sample.t;
      wall = 1_700_000_000_000 + (sample.t - 1_000);
      clock.applyAnchor(anchor({
        positionMs: sample.pos,
        state: 'playing',
        sequence: sample.t,
        producedAtMs: wall,
      }));
    }

    now = 2_000;
    const snap = clock.getSnapshot();
    // Near pure coast 6000, not hard-snapped to 5800; micro-slew may pull slightly.
    expect(snap.positionMs).toBeGreaterThan(5_900);
    expect(snap.positionMs).toBeLessThan(6_100);
    expect(snap.discontinuity).toBeNull();
  });

  it('compensates wall-clock transport lag on first accept', () => {
    const now = 0;
    const wall = 1_700_000_000_500;
    const clock = createSparseAnchorClock(() => now, () => wall);
    // Content stamped position 10s at wall-200ms → lag 200ms.
    clock.applyAnchor(anchor({
      positionMs: 10_000,
      state: 'playing',
      sequence: 1,
      producedAtMs: wall - 200,
    }));
    const snap = clock.getSnapshot();
    expect(snap.positionMs).toBeCloseTo(10_200, 0);
  });

  it('returns seek discontinuity only once', () => {
    let now = 0;
    const clock = createSparseAnchorClock(() => now, () => 1_700_000_000_000);
    clock.applyAnchor(anchor({ positionMs: 90_000, sequence: 1 }));
    now = 10;
    clock.applyAnchor(anchor({ positionMs: 1_000, sequence: 2 }));
    expect(clock.getSnapshot().discontinuity?.reason).toBe('seek');
    expect(clock.getSnapshot().discontinuity).toBeNull();
  });

  it('hard-accepts real forward seeks beyond threshold', () => {
    let now = 1_000;
    const clock = createSparseAnchorClock(() => now, () => 1_700_000_000_000);
    clock.applyAnchor(anchor({ positionMs: 5_000, state: 'playing', sequence: 1 }));
    now = 1_100;
    clock.applyAnchor(anchor({
      positionMs: 20_000,
      state: 'playing',
      sequence: 2,
    }));
    const snap = clock.getSnapshot();
    expect(snap.discontinuity?.reason).toBe('seek');
    expect(snap.positionMs).toBe(20_000);
  });

  it('hard-accepts content position on mediaId change (no continuous carry)', () => {
    let now = 1_000;
    const wall = 1_700_000_000_000;
    const clock = createSparseAnchorClock(() => now, () => wall);
    clock.applyAnchor(anchor({
      mediaId: 'applemusic:1',
      positionMs: 90_000,
      state: 'playing',
      sequence: 1,
      producedAtMs: wall,
    }));
    now = 1_500;
    // Next track near start — must not keep ~90.5s coast phase.
    clock.applyAnchor(anchor({
      mediaId: 'applemusic:2',
      positionMs: 800,
      state: 'playing',
      sequence: 2,
      producedAtMs: wall,
    }));
    const snap = clock.getSnapshot();
    expect(snap.positionMs).toBeLessThan(2_000);
    expect(snap.positionMs).toBeGreaterThanOrEqual(800);
    expect(snap.discontinuity?.reason).toBe('source-change');
  });
});
