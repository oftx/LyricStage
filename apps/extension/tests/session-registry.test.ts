import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../src/background/session-registry.js';
import type { SparsePlaybackAnchorV1 } from '@lyric-stage/extension-protocol';

function anchor(
  overrides: Partial<SparsePlaybackAnchorV1> & Pick<SparsePlaybackAnchorV1, 'sessionId' | 'sequence'>,
): SparsePlaybackAnchorV1 {
  return {
    protocolVersion: 1,
    generation: 1,
    mediaId: 'media:a',
    positionMs: 0,
    rate: 1,
    state: 'playing',
    producedAtMs: 1,
    ...overrides,
  };
}

describe('extension session registry sticky multi-source', () => {
  it('accepts ordered anchors and rejects stale sequences within one session', () => {
    const registry = new SessionRegistry('boot');
    const base = anchor({ sessionId: 'session:1', sequence: 1 });
    expect(registry.acceptAnchor(base)).toBe(true);
    expect(registry.acceptAnchor({ ...base, sequence: 1 })).toBe(false);
    expect(registry.acceptAnchor({ ...base, sequence: 2, positionMs: 10 })).toBe(true);
    expect(registry.latest?.positionMs).toBe(10);
    expect(registry.selectedSessionId).toBe('session:1');
  });

  it('lets an active producer take over an implicit idle selection', () => {
    const registry = new SessionRegistry('boot');
    // Idle tab connects first: paused anchor claims selection implicitly.
    expect(registry.acceptAnchor(anchor({
      sessionId: 'session:idle-first',
      sequence: 1,
      mediaId: 'qqmusic:idle',
      state: 'paused',
    }))).toBe(true);
    expect(registry.selectedSessionId).toBe('session:idle-first');

    // The tab the user is actually listening to connects second and wins.
    expect(registry.acceptAnchor(anchor({
      sessionId: 'session:playing-second',
      sequence: 1,
      mediaId: 'netease:song',
      positionMs: 42_000,
      state: 'playing',
    }))).toBe(true);
    expect(registry.selectedSessionId).toBe('session:playing-second');
    expect(registry.latest?.mediaId).toBe('netease:song');
  });

  it('never lets an active producer steal an explicit user selection', () => {
    const registry = new SessionRegistry('boot');
    registry.acceptAnchor(anchor({
      sessionId: 'session:chosen',
      sequence: 1,
      mediaId: 'qqmusic:chosen',
      state: 'paused',
    }));
    registry.selectSession('session:chosen');

    expect(registry.acceptAnchor(anchor({
      sessionId: 'session:other',
      sequence: 1,
      mediaId: 'netease:other',
      state: 'playing',
    }))).toBe(false);
    expect(registry.selectedSessionId).toBe('session:chosen');
  });

  it('does not let a second session steal a healthy selected session', () => {
    const registry = new SessionRegistry('boot');
    expect(registry.acceptAnchor(anchor({
      sessionId: 'session:netease',
      sequence: 1,
      mediaId: 'netease:1',
      positionMs: 1_000,
    }))).toBe(true);
    expect(registry.selectedSessionId).toBe('session:netease');

    // QQ also playing — must not replace selected latest.
    expect(registry.acceptAnchor(anchor({
      sessionId: 'session:qq',
      sequence: 1,
      mediaId: 'qqmusic:2',
      positionMs: 50_000,
      state: 'playing',
    }))).toBe(false);
    expect(registry.selectedSessionId).toBe('session:netease');
    expect(registry.latest?.mediaId).toBe('netease:1');
    expect(registry.latest?.positionMs).toBe(1_000);

    // Selected session still advances.
    expect(registry.acceptAnchor(anchor({
      sessionId: 'session:netease',
      sequence: 2,
      mediaId: 'netease:1',
      positionMs: 1_500,
    }))).toBe(true);
    expect(registry.latest?.positionMs).toBe(1_500);

    // Non-selected session is still cached for failover.
    expect(registry.latestFor('session:qq')?.positionMs).toBe(50_000);
  });

  it('promotes another known session after selected is released', () => {
    const registry = new SessionRegistry('boot');
    registry.acceptAnchor(anchor({
      sessionId: 'session:a',
      sequence: 1,
      mediaId: 'netease:a',
      positionMs: 100,
      state: 'playing',
    }));
    registry.acceptAnchor(anchor({
      sessionId: 'session:b',
      sequence: 1,
      mediaId: 'qqmusic:b',
      positionMs: 9_000,
      state: 'playing',
    }));
    expect(registry.selectedSessionId).toBe('session:a');

    expect(registry.releaseSession('session:a')).toBe(true);
    expect(registry.selectedSessionId).toBeNull();
    expect(registry.latest).toBeNull();

    const promoted = registry.promoteSession(['session:b']);
    expect(promoted?.sessionId).toBe('session:b');
    expect(registry.selectedSessionId).toBe('session:b');
    expect(registry.latest?.mediaId).toBe('qqmusic:b');
  });

  it('selectSession explicitly switches sticky ownership', () => {
    const registry = new SessionRegistry('boot');
    registry.acceptAnchor(anchor({
      sessionId: 'session:a',
      sequence: 1,
      mediaId: 'netease:a',
    }));
    registry.acceptAnchor(anchor({
      sessionId: 'session:b',
      sequence: 1,
      mediaId: 'qqmusic:b',
      positionMs: 3_000,
    }));
    expect(registry.selectSession('session:b')).toBe(true);
    expect(registry.selectedSessionId).toBe('session:b');
    expect(registry.latest?.mediaId).toBe('qqmusic:b');
    expect(registry.latest?.positionMs).toBe(3_000);

    // After explicit switch, only B publishes.
    expect(registry.acceptAnchor(anchor({
      sessionId: 'session:a',
      sequence: 2,
      mediaId: 'netease:a',
      positionMs: 99_000,
    }))).toBe(false);
    expect(registry.latest?.mediaId).toBe('qqmusic:b');
  });

  it('clears completely when no residual sessions remain', () => {
    const registry = new SessionRegistry('boot');
    registry.acceptAnchor(anchor({ sessionId: 'session:only', sequence: 1 }));
    expect(registry.releaseSession('session:only')).toBe(true);
    expect(registry.promoteSession([])).toBeNull();
    expect(registry.latest).toBeNull();
    expect(registry.selectedSessionId).toBeNull();
  });
});
