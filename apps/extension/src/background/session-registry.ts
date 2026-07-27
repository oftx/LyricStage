import {
  isSparsePlaybackAnchorV1,
  type SparsePlaybackAnchorV1,
} from '@lyric-stage/extension-protocol';

/**
 * Restartable control-plane session registry.
 *
 * Stores sparse anchors only (never advances a live clock). Multi-tab policy
 * matches Flow G: a healthy selected session is sticky — a new playing tab
 * does not steal the lyric window. Explicit selectSession() or releasing the
 * selected session (goodbye / disconnect) is required to switch.
 */
export class SessionRegistry {
  #latestBySession = new Map<string, SparsePlaybackAnchorV1>();
  #selectedSessionId: string | null = null;
  /** True only for user-driven selection; implicit claims stay upgradeable. */
  #selectionExplicit = false;
  readonly #bootId: string;

  constructor(bootId: string) {
    this.#bootId = bootId;
  }

  public get bootId(): string {
    return this.#bootId;
  }

  /** Selected session's latest anchor, if any. */
  public get latest(): SparsePlaybackAnchorV1 | null {
    if (!this.#selectedSessionId) return null;
    return this.#latestBySession.get(this.#selectedSessionId) ?? null;
  }

  public get selectedSessionId(): string | null {
    return this.#selectedSessionId;
  }

  public get knownSessionIds(): readonly string[] {
    return Object.freeze([...this.#latestBySession.keys()]);
  }

  public latestFor(sessionId: string): SparsePlaybackAnchorV1 | null {
    return this.#latestBySession.get(sessionId) ?? null;
  }

  /**
   * Ingest an anchor under sticky multi-source policy.
   * @returns whether the selected session's published latest changed
   *   (surfaces should rebroadcast only on true).
   */
  public acceptAnchor(anchor: SparsePlaybackAnchorV1): boolean {
    if (!isSparsePlaybackAnchorV1(anchor)) return false;

    const previousSelected = this.#selectedSessionId;
    const cached = this.#latestBySession.get(anchor.sessionId) ?? null;
    const nextForSession = mergeSessionAnchor(cached, anchor);
    if (nextForSession) {
      this.#latestBySession.set(anchor.sessionId, nextForSession);
    }

    // First producer becomes selected (implicitly — an active producer may
    // still take over below).
    if (this.#selectedSessionId === null) {
      this.#selectedSessionId = anchor.sessionId;
      this.#selectionExplicit = false;
      return nextForSession !== null;
    }

    if (anchor.sessionId !== this.#selectedSessionId) {
      // Sticky between active sources: a new playing tab never steals a
      // playing lyric window (Flow G). But an implicit selection whose holder
      // is not actively playing (idle tab that merely connected first) must
      // not lock out the tab the user is actually listening to.
      const incomingActive = anchor.state === 'playing' || anchor.state === 'buffering';
      const selectedAnchor = this.#latestBySession.get(this.#selectedSessionId) ?? null;
      const selectedActive = selectedAnchor !== null
        && (selectedAnchor.state === 'playing' || selectedAnchor.state === 'buffering');
      if (incomingActive && !selectedActive && !this.#selectionExplicit) {
        this.#selectedSessionId = anchor.sessionId;
        return nextForSession !== null;
      }
      return false;
    }

    // Selected session: publish when the stored anchor advanced.
    if (!nextForSession) return false;
    if (previousSelected !== this.#selectedSessionId) return true;
    if (!cached) return true;
    return nextForSession !== cached
      && (
        nextForSession.generation !== cached.generation
        || nextForSession.sequence !== cached.sequence
        || nextForSession.positionMs !== cached.positionMs
        || nextForSession.state !== cached.state
        || nextForSession.mediaId !== cached.mediaId
        || (nextForSession.durationMs ?? null) !== (cached.durationMs ?? null)
      );
  }

  /**
   * Explicit user/source selection. Session may not have an anchor yet; it
   * still becomes sticky so the next anchors from that tab win.
   */
  public selectSession(
    sessionId: string,
    options: { readonly explicit?: boolean } = {},
  ): boolean {
    if (!sessionId) return false;
    const explicit = options.explicit ?? true;
    if (this.#selectedSessionId === sessionId) {
      // Re-selecting can upgrade an implicit claim to an explicit one.
      this.#selectionExplicit = this.#selectionExplicit || explicit;
      return false;
    }
    this.#selectedSessionId = sessionId;
    this.#selectionExplicit = explicit;
    return true;
  }

  /**
   * Drop a session (port disconnect / source-goodbye). If it was selected,
   * clears selection so the worker can promote another known session.
   * @returns true when the selected session was released
   */
  public releaseSession(sessionId: string): boolean {
    this.#latestBySession.delete(sessionId);
    if (this.#selectedSessionId !== sessionId) return false;
    this.#selectedSessionId = null;
    this.#selectionExplicit = false;
    return true;
  }

  /**
   * Promote a preferred session after the selected one is gone.
   * Prefer currently-playing candidates, then any remaining known session.
   */
  public promoteSession(
    preferredSessionIds: readonly string[],
  ): SparsePlaybackAnchorV1 | null {
    if (this.#selectedSessionId !== null) {
      return this.latest;
    }
    const known = new Set(this.#latestBySession.keys());
    for (const sessionId of preferredSessionIds) {
      if (!known.has(sessionId)) continue;
      this.#selectedSessionId = sessionId;
      this.#selectionExplicit = false;
      return this.latest;
    }
    // Prefer a playing residual if preference list missed.
    for (const [sessionId, anchor] of this.#latestBySession) {
      if (anchor.state === 'playing' || anchor.state === 'buffering') {
        this.#selectedSessionId = sessionId;
        this.#selectionExplicit = false;
        return anchor;
      }
    }
    const first = this.#latestBySession.keys().next();
    if (!first.done) {
      this.#selectedSessionId = first.value;
      this.#selectionExplicit = false;
      return this.latest;
    }
    return null;
  }

  public clear(): void {
    this.#latestBySession.clear();
    this.#selectedSessionId = null;
    this.#selectionExplicit = false;
  }
}

/** Same-session generation/sequence ordering; returns null if stale. */
function mergeSessionAnchor(
  previous: SparsePlaybackAnchorV1 | null,
  incoming: SparsePlaybackAnchorV1,
): SparsePlaybackAnchorV1 | null {
  if (!previous) return incoming;
  if (incoming.generation < previous.generation) return null;
  if (incoming.generation > previous.generation) return incoming;
  if (incoming.sequence <= previous.sequence) return null;
  return incoming;
}
