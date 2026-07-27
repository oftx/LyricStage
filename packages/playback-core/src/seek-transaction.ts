import type { SeekOutcome, SeekRequest } from './types.js';

export interface ActiveSeekTransaction {
  readonly request: SeekRequest;
  readonly phase: 'requested' | 'accepted';
}

export interface SeekTransactionState {
  readonly sessionId: string | null;
  readonly active: ActiveSeekTransaction | null;
}

export type SeekTransactionEvent =
  | { readonly type: 'replace-session'; readonly sessionId: string | null }
  | { readonly type: 'request'; readonly request: SeekRequest }
  | { readonly type: 'accepted'; readonly requestId: string }
  | { readonly type: 'confirmed'; readonly requestId: string; readonly positionMs: number }
  | { readonly type: 'rejected'; readonly requestId: string; readonly reason: string }
  | { readonly type: 'timed-out'; readonly requestId: string };

export interface SeekTransactionReduction {
  readonly state: SeekTransactionState;
  readonly outcomes: readonly SeekOutcome[];
}

export function createSeekTransactionState(sessionId: string | null): SeekTransactionState {
  return Object.freeze({ sessionId, active: null });
}

/** Pure reducer; old acknowledgements can never settle a newer active request. */
export function reduceSeekTransaction(
  state: SeekTransactionState,
  event: SeekTransactionEvent,
): SeekTransactionReduction {
  switch (event.type) {
    case 'replace-session': {
      const outcomes: SeekOutcome[] = state.active
        ? [{
          status: 'rejected',
          requestId: state.active.request.requestId,
          reason: 'session-replaced',
        }]
        : [];
      return reduction(
        Object.freeze({ sessionId: event.sessionId, active: null }),
        outcomes,
      );
    }

    case 'request': {
      const invalidReason = validateSeekRequest(event.request, state.sessionId);
      if (invalidReason) {
        return reduction(state, [{
          status: 'rejected',
          requestId: event.request.requestId,
          reason: invalidReason,
        }]);
      }
      if (state.active?.request.requestId === event.request.requestId) {
        return reduction(state, []);
      }
      const outcomes: SeekOutcome[] = state.active
        ? [{
          status: 'superseded',
          requestId: state.active.request.requestId,
          byRequestId: event.request.requestId,
        }]
        : [];
      return reduction(Object.freeze({
        sessionId: state.sessionId,
        active: Object.freeze({ request: event.request, phase: 'requested' }),
      }), outcomes);
    }

    case 'accepted': {
      if (state.active?.request.requestId !== event.requestId) return reduction(state, []);
      if (state.active.phase === 'accepted') return reduction(state, []);
      return reduction(Object.freeze({
        sessionId: state.sessionId,
        active: Object.freeze({ request: state.active.request, phase: 'accepted' }),
      }), [{ status: 'accepted', requestId: event.requestId }]);
    }

    case 'confirmed': {
      if (state.active?.request.requestId !== event.requestId) return reduction(state, []);
      if (!Number.isFinite(event.positionMs) || event.positionMs < 0) {
        return reduction(state, []);
      }
      return reduction(Object.freeze({ sessionId: state.sessionId, active: null }), [{
        status: 'confirmed',
        requestId: event.requestId,
        positionMs: event.positionMs,
      }]);
    }

    case 'rejected': {
      if (state.active?.request.requestId !== event.requestId) return reduction(state, []);
      return reduction(Object.freeze({ sessionId: state.sessionId, active: null }), [{
        status: 'rejected',
        requestId: event.requestId,
        reason: event.reason,
      }]);
    }

    case 'timed-out': {
      if (state.active?.request.requestId !== event.requestId) return reduction(state, []);
      return reduction(Object.freeze({ sessionId: state.sessionId, active: null }), [{
        status: 'timed-out',
        requestId: event.requestId,
      }]);
    }
  }
}

function validateSeekRequest(request: SeekRequest, sessionId: string | null): string | null {
  if (sessionId === null || request.sessionId !== sessionId) return 'stale-session';
  if (request.requestId.trim().length === 0) return 'invalid-request-id';
  if (request.requestedBySurfaceId.trim().length === 0) return 'invalid-surface-id';
  if (!Number.isFinite(request.targetPositionMs) || request.targetPositionMs < 0) {
    return 'invalid-target';
  }
  if (!Number.isFinite(request.issuedAtMs) || request.issuedAtMs < 0) {
    return 'invalid-issued-time';
  }
  return null;
}

function reduction(
  state: SeekTransactionState,
  outcomes: readonly SeekOutcome[],
): SeekTransactionReduction {
  return Object.freeze({ state, outcomes: Object.freeze([...outcomes]) });
}
