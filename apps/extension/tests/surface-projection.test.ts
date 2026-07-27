import { describe, expect, it } from 'vitest';
import type { SparsePlaybackAnchorV1 } from '@lyric-stage/extension-protocol';
import { projectSparseAnchor } from '../src/surface/project-sparse-anchor.js';

function anchor(
  overrides: Partial<SparsePlaybackAnchorV1> = {},
): SparsePlaybackAnchorV1 {
  return {
    protocolVersion: 1,
    sessionId: 'session:test',
    generation: 1,
    mediaId: 'media:demo',
    positionMs: 12_000,
    rate: 1,
    state: 'playing',
    producedAtMs: 1,
    sequence: 3,
    ...overrides,
  };
}

describe('projectSparseAnchor', () => {
  it('coasts forward while playing using surface receive time', () => {
    const held = {
      anchor: anchor({ positionMs: 10_000, rate: 1, state: 'playing' }),
      receivedAtMs: 1000,
    };
    const projected = projectSparseAnchor(held, 2500);
    expect(projected).toEqual({
      positionMs: 11_500,
      ageMs: 1500,
      state: 'playing',
    });
  });

  it('does not coast while paused or buffering', () => {
    const held = {
      anchor: anchor({ positionMs: 40_000, state: 'paused' }),
      receivedAtMs: 500,
    };
    const projected = projectSparseAnchor(held, 5000);
    expect(projected?.positionMs).toBe(40_000);
    expect(projected?.state).toBe('paused');
    expect(projected?.ageMs).toBe(4500);
  });

  it('returns null without an anchor', () => {
    expect(projectSparseAnchor(null, 1000)).toBeNull();
  });

  it('clamps playing extrapolation at durationMs and projects ended', () => {
    const held = {
      anchor: anchor({
        positionMs: 139_000,
        state: 'playing',
        durationMs: 140_000,
      }),
      receivedAtMs: 0,
    };
    // Coasting within bounds stays playing.
    expect(projectSparseAnchor(held, 500)).toEqual({
      positionMs: 139_500,
      ageMs: 500,
      state: 'playing',
    });
    // Reaching the bound pins the position and flips to ended — never past it.
    expect(projectSparseAnchor(held, 30_000)).toEqual({
      positionMs: 140_000,
      ageMs: 30_000,
      state: 'ended',
    });
  });

  it('clamps a held non-playing position into the duration bound', () => {
    const held = {
      anchor: anchor({
        positionMs: 150_000,
        state: 'paused',
        durationMs: 140_000,
      }),
      receivedAtMs: 0,
    };
    expect(projectSparseAnchor(held, 1000)?.positionMs).toBe(140_000);
  });

  it('coasts unbounded when durationMs is absent (legacy anchors)', () => {
    const held = {
      anchor: anchor({ positionMs: 139_000, state: 'playing' }),
      receivedAtMs: 0,
    };
    expect(projectSparseAnchor(held, 30_000)?.positionMs).toBe(169_000);
  });
});
