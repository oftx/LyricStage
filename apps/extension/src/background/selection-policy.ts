/**
 * Source selection policy, extracted from the service worker so ranking is
 * unit-testable ahead of the P0 selection-order fix. Behavior matches the
 * original worker implementation.
 */

export interface SelectableSource {
  readonly sessionId: string;
  /** Last sparse-anchor state, or null before any anchor arrived. */
  readonly lastState: string | null;
  readonly lastSeenAtMs: number;
}

/** Placeholder media ids never announce a selectable source. */
export function isPlaceholderMediaId(mediaId: string | null | undefined): boolean {
  return !mediaId
    || mediaId === 'media:unbound'
    || mediaId === 'media:unknown'
    || mediaId.endsWith(':unbound');
}

function isActiveState(state: string | null): boolean {
  return state === 'playing' || state === 'buffering';
}

/**
 * Failover preference: playing/buffering sources first, then most recently
 * seen. Used when the selected session is lost.
 */
export function rankFailoverSessions(
  sources: Iterable<SelectableSource>,
): string[] {
  const rows = [...sources].map((source) => ({
    sessionId: source.sessionId,
    playing: isActiveState(source.lastState),
    lastSeenAtMs: source.lastSeenAtMs,
  }));
  rows.sort((left, right) => {
    if (left.playing !== right.playing) return left.playing ? -1 : 1;
    return right.lastSeenAtMs - left.lastSeenAtMs;
  });
  return rows.map((row) => row.sessionId);
}
