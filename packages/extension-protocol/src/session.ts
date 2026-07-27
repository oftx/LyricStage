import { isRecord } from './envelope.js';

/** One content tab / content-runtime producer visible to the control plane. */
export type SourceListEntryV1 = {
  readonly sessionId: string;
  readonly generation: number;
  readonly mediaId: string;
  readonly tabId: number | null;
  readonly state: 'playing' | 'paused' | 'buffering' | 'ended' | 'unknown';
  readonly positionMs: number | null;
  readonly selected: boolean;
  /** Short platform label derived from mediaId when possible. */
  readonly platformLabel: string;
};

export type SessionChannelPayload =
  | {
    readonly kind: 'source-hello';
    readonly sessionId: string;
    readonly generation: number;
    readonly mediaId: string;
  }
  | {
    readonly kind: 'source-goodbye';
    readonly sessionId: string;
    readonly generation: number;
    readonly reason: string;
  }
  | {
    readonly kind: 'select-source';
    /** Prefer sessionId; tabId remains for Flow G / popup convenience. */
    readonly tabId?: number;
    readonly sessionId?: string;
  }
  | {
    readonly kind: 'selected-source';
    readonly tabId: number;
    readonly sessionId: string;
    readonly generation: number;
  }
  | {
    readonly kind: 'request-source-list';
  }
  | {
    readonly kind: 'source-list';
    readonly selectedSessionId: string | null;
    readonly sources: readonly SourceListEntryV1[];
  };

const SOURCE_STATES = new Set([
  'playing',
  'paused',
  'buffering',
  'ended',
  'unknown',
]);

function isSourceListEntry(value: unknown): value is SourceListEntryV1 {
  if (!isRecord(value)) return false;
  return typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && typeof value.generation === 'number'
    && Number.isSafeInteger(value.generation)
    && value.generation > 0
    && typeof value.mediaId === 'string'
    && value.mediaId.length > 0
    && (value.tabId === null
      || (typeof value.tabId === 'number' && Number.isSafeInteger(value.tabId)))
    && typeof value.state === 'string'
    && SOURCE_STATES.has(value.state)
    && (value.positionMs === null
      || (typeof value.positionMs === 'number' && Number.isFinite(value.positionMs)))
    && typeof value.selected === 'boolean'
    && typeof value.platformLabel === 'string';
}

export function parseSessionPayload(value: unknown): SessionChannelPayload | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'source-hello') {
    if (
      typeof value.sessionId !== 'string'
      || typeof value.generation !== 'number'
      || !Number.isSafeInteger(value.generation)
      || value.generation <= 0
      || typeof value.mediaId !== 'string'
    ) return null;
    return {
      kind: 'source-hello',
      sessionId: value.sessionId,
      generation: value.generation,
      mediaId: value.mediaId,
    };
  }
  if (value.kind === 'source-goodbye') {
    if (
      typeof value.sessionId !== 'string'
      || typeof value.generation !== 'number'
      || typeof value.reason !== 'string'
    ) return null;
    return {
      kind: 'source-goodbye',
      sessionId: value.sessionId,
      generation: value.generation,
      reason: value.reason,
    };
  }
  if (value.kind === 'select-source') {
    const hasTab = typeof value.tabId === 'number' && Number.isSafeInteger(value.tabId);
    const hasSession = typeof value.sessionId === 'string' && value.sessionId.length > 0;
    if (!hasTab && !hasSession) return null;
    return {
      kind: 'select-source',
      ...(hasTab ? { tabId: value.tabId as number } : {}),
      ...(hasSession ? { sessionId: value.sessionId as string } : {}),
    };
  }
  if (value.kind === 'selected-source') {
    if (
      typeof value.tabId !== 'number'
      || typeof value.sessionId !== 'string'
      || typeof value.generation !== 'number'
    ) return null;
    return {
      kind: 'selected-source',
      tabId: value.tabId,
      sessionId: value.sessionId,
      generation: value.generation,
    };
  }
  if (value.kind === 'request-source-list') {
    return { kind: 'request-source-list' };
  }
  if (value.kind === 'source-list') {
    if (
      !(value.selectedSessionId === null || typeof value.selectedSessionId === 'string')
      || !Array.isArray(value.sources)
      || !value.sources.every(isSourceListEntry)
    ) {
      return null;
    }
    return {
      kind: 'source-list',
      selectedSessionId: value.selectedSessionId,
      sources: Object.freeze([...value.sources]) as readonly SourceListEntryV1[],
    };
  }
  return null;
}

/** Derive a short platform chip from mediaId `platform:externalId`. */
export function platformLabelFromMediaId(mediaId: string): string {
  const colon = mediaId.indexOf(':');
  const raw = colon > 0 ? mediaId.slice(0, colon) : mediaId;
  switch (raw) {
    case 'netease':
      return 'NetEase';
    case 'qqmusic':
      return 'QQ Music';
    case 'youtube':
      return 'YouTube';
    case 'bilibili':
      return 'Bilibili';
    case 'applemusic':
      return 'Apple Music';
    case 'synthetic':
      return 'Demo';
    default:
      // mediaId may be `applemusic:listening` — already handled above.
      return raw || 'Unknown';
  }
}
