import { describe, expect, it } from 'vitest';
import {
  createSeekTransactionState,
  reduceSeekTransaction,
  type SeekRequest,
} from '../src/index.js';

function request(requestId: string, sessionId = 'session-1'): SeekRequest {
  return {
    requestId,
    sessionId,
    targetPositionMs: 12_000,
    requestedBySurfaceId: 'surface-1',
    issuedAtMs: 100,
  };
}

describe('seek transaction reducer', () => {
  it('supports accepted then confirmed outcomes', () => {
    let state = createSeekTransactionState('session-1');
    let reduction = reduceSeekTransaction(state, { type: 'request', request: request('seek-1') });
    state = reduction.state;
    expect(reduction.outcomes).toEqual([]);

    reduction = reduceSeekTransaction(state, { type: 'accepted', requestId: 'seek-1' });
    state = reduction.state;
    expect(reduction.outcomes).toEqual([{ status: 'accepted', requestId: 'seek-1' }]);

    reduction = reduceSeekTransaction(state, {
      type: 'confirmed',
      requestId: 'seek-1',
      positionMs: 12_050,
    });
    expect(reduction.state.active).toBeNull();
    expect(reduction.outcomes).toEqual([{
      status: 'confirmed',
      requestId: 'seek-1',
      positionMs: 12_050,
    }]);
  });

  it('supersedes the previous request and ignores its late confirmation', () => {
    let state = reduceSeekTransaction(
      createSeekTransactionState('session-1'),
      { type: 'request', request: request('seek-1') },
    ).state;
    const replacement = reduceSeekTransaction(state, {
      type: 'request',
      request: request('seek-2'),
    });
    state = replacement.state;
    expect(replacement.outcomes).toEqual([{
      status: 'superseded',
      requestId: 'seek-1',
      byRequestId: 'seek-2',
    }]);

    const stale = reduceSeekTransaction(state, {
      type: 'confirmed',
      requestId: 'seek-1',
      positionMs: 12_000,
    });
    expect(stale.state.active?.request.requestId).toBe('seek-2');
    expect(stale.outcomes).toEqual([]);
  });

  it('rejects a request scoped to an old session', () => {
    const result = reduceSeekTransaction(
      createSeekTransactionState('session-2'),
      { type: 'request', request: request('seek-1', 'session-1') },
    );
    expect(result.state.active).toBeNull();
    expect(result.outcomes).toEqual([{
      status: 'rejected',
      requestId: 'seek-1',
      reason: 'stale-session',
    }]);
  });

  it.each(['rejected', 'timed-out'] as const)('settles a %s request', (type) => {
    const active = reduceSeekTransaction(
      createSeekTransactionState('session-1'),
      { type: 'request', request: request('seek-1') },
    ).state;
    const result = type === 'rejected'
      ? reduceSeekTransaction(active, {
        type,
        requestId: 'seek-1',
        reason: 'platform-refused',
      })
      : reduceSeekTransaction(active, { type, requestId: 'seek-1' });
    expect(result.state.active).toBeNull();
    expect(result.outcomes[0]?.status).toBe(type);
  });
});
