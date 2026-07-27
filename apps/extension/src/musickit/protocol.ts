/**
 * Isolated ↔ MAIN Apple Music lyric request protocol (production).
 * Adapted from the P0-D2 spike; credentials never leave the page MusicKit session.
 */

export const APPLE_REQUEST_PROTOCOL_VERSION = 1 as const;
export const APPLE_REQUEST_CHANNEL = 'lyric-stage-apple-music-request-v1' as const;
export const MAX_TTML_CANDIDATES = 16;
export const MAX_TTML_TOTAL_LENGTH = 4_000_000;

export type AppleRequestCommand =
  | {
    readonly type: 'request-lyrics';
    readonly catalogId: string;
    readonly locale: string;
  }
  | { readonly type: 'teardown' };

export interface AppleLyricCandidate {
  readonly locale: string | null;
  readonly ttml: string;
}

export type AppleRequestErrorCode =
  | 'api-unavailable'
  | 'not-authorized'
  | 'no-lyrics'
  | 'request-failed'
  | 'invalid-response'
  | 'lyrics-too-large'
  | 'busy'
  | 'timeout';

export type AppleRequestResult =
  | {
    readonly type: 'lyrics';
    readonly catalogId: string;
    readonly storefront: string;
    readonly locale: string;
    readonly status: number;
    readonly candidates: readonly AppleLyricCandidate[];
  }
  | {
    readonly type: 'error';
    readonly code: AppleRequestErrorCode;
    readonly status: number | null;
  }
  | { readonly type: 'ack' };

export interface AppleRequestEnvelope {
  readonly channel: typeof APPLE_REQUEST_CHANNEL;
  readonly protocolVersion: typeof APPLE_REQUEST_PROTOCOL_VERSION;
  readonly direction: 'isolated-to-main';
  readonly bridgeInstanceId: string;
  readonly nonce: string;
  readonly sequence: number;
  readonly requestId: string;
  readonly command: AppleRequestCommand;
}

export interface AppleResponseEnvelope {
  readonly channel: typeof APPLE_REQUEST_CHANNEL;
  readonly protocolVersion: typeof APPLE_REQUEST_PROTOCOL_VERSION;
  readonly direction: 'main-to-isolated';
  readonly bridgeInstanceId: string;
  readonly nonce: string;
  readonly sequence: number;
  readonly requestId: string;
  readonly result: AppleRequestResult;
}

export type AppleRequestParseResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly reason: string };

const REQUEST_FIELDS = new Set([
  'channel',
  'protocolVersion',
  'direction',
  'bridgeInstanceId',
  'nonce',
  'sequence',
  'requestId',
  'command',
]);
const RESPONSE_FIELDS = new Set([
  'channel',
  'protocolVersion',
  'direction',
  'bridgeInstanceId',
  'nonce',
  'sequence',
  'requestId',
  'result',
]);

export function parseAppleRequest(
  value: unknown,
): AppleRequestParseResult<AppleRequestEnvelope> {
  if (!isRecord(value) || hasUnknownFields(value, REQUEST_FIELDS)) {
    return failure('invalid request envelope fields');
  }
  if (
    value.channel !== APPLE_REQUEST_CHANNEL
    || value.protocolVersion !== APPLE_REQUEST_PROTOCOL_VERSION
    || value.direction !== 'isolated-to-main'
  ) {
    return failure('unsupported request protocol');
  }
  const bridgeInstanceId = parseId(value.bridgeInstanceId);
  const nonce = parseSecret(value.nonce);
  const sequence = parseSequence(value.sequence);
  const requestId = parseId(value.requestId);
  const command = parseCommand(value.command);
  if (!bridgeInstanceId || !nonce || sequence === null || !requestId || !command) {
    return failure('invalid request values');
  }
  return {
    success: true,
    value: {
      channel: APPLE_REQUEST_CHANNEL,
      protocolVersion: APPLE_REQUEST_PROTOCOL_VERSION,
      direction: 'isolated-to-main',
      bridgeInstanceId,
      nonce,
      sequence,
      requestId,
      command,
    },
  };
}

export function parseAppleResponse(
  value: unknown,
): AppleRequestParseResult<AppleResponseEnvelope> {
  if (!isRecord(value) || hasUnknownFields(value, RESPONSE_FIELDS)) {
    return failure('invalid response envelope fields');
  }
  if (
    value.channel !== APPLE_REQUEST_CHANNEL
    || value.protocolVersion !== APPLE_REQUEST_PROTOCOL_VERSION
    || value.direction !== 'main-to-isolated'
  ) {
    return failure('unsupported response protocol');
  }
  const bridgeInstanceId = parseId(value.bridgeInstanceId);
  const nonce = parseSecret(value.nonce);
  const sequence = parseSequence(value.sequence);
  const requestId = parseId(value.requestId);
  const result = parseResult(value.result);
  if (!bridgeInstanceId || !nonce || sequence === null || !requestId || !result) {
    return failure('invalid response values');
  }
  return {
    success: true,
    value: {
      channel: APPLE_REQUEST_CHANNEL,
      protocolVersion: APPLE_REQUEST_PROTOCOL_VERSION,
      direction: 'main-to-isolated',
      bridgeInstanceId,
      nonce,
      sequence,
      requestId,
      result,
    },
  };
}

export function isValidCatalogId(value: string): boolean {
  if (value === 'current') return true;
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value)
    && value !== 'listening'
    && value !== 'unknown';
}

export function selectBestTtmlCandidate(
  candidates: readonly AppleLyricCandidate[],
  preferredLocale: string,
): AppleLyricCandidate | null {
  if (candidates.length === 0) return null;
  const preferred = preferredLocale.toLowerCase();
  const preferredLang = preferred.split('-')[0] ?? preferred;
  const exact = candidates.find(
    (c) => c.locale && c.locale.toLowerCase() === preferred,
  );
  if (exact) return exact;
  const lang = candidates.find(
    (c) => c.locale && c.locale.toLowerCase().startsWith(preferredLang),
  );
  if (lang) return lang;
  return candidates[0] ?? null;
}

function parseCommand(value: unknown): AppleRequestCommand | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'teardown') {
    return Object.keys(value).length === 1 ? { type: 'teardown' } : null;
  }
  if (value.type !== 'request-lyrics' || Object.keys(value).length !== 3) return null;
  const catalogId = parseCatalogId(value.catalogId);
  const locale = parseLocale(value.locale);
  return catalogId && locale
    ? { type: 'request-lyrics', catalogId, locale }
    : null;
}

function parseResult(value: unknown): AppleRequestResult | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'ack') {
    return Object.keys(value).length === 1 ? { type: 'ack' } : null;
  }
  if (value.type === 'error') {
    if (Object.keys(value).length !== 3 || !isErrorCode(value.code)) return null;
    const status = value.status === null ? null : parseStatus(value.status);
    return status !== undefined
      ? { type: 'error', code: value.code, status }
      : null;
  }
  if (value.type !== 'lyrics' || Object.keys(value).length !== 6) return null;
  const catalogId = parseCatalogId(value.catalogId);
  const storefront = parseStorefront(value.storefront);
  const locale = parseLocale(value.locale);
  const status = parseStatus(value.status);
  const candidates = parseCandidates(value.candidates);
  if (!catalogId || !storefront || !locale || status === undefined || !candidates) {
    return null;
  }
  return {
    type: 'lyrics',
    catalogId,
    storefront,
    locale,
    status,
    candidates,
  };
}

function parseCandidates(value: unknown): readonly AppleLyricCandidate[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TTML_CANDIDATES) {
    return null;
  }
  let totalLength = 0;
  const candidates: AppleLyricCandidate[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2) return null;
    const locale = entry.locale === null ? null : parseLocale(entry.locale);
    if (entry.locale !== null && !locale) return null;
    if (typeof entry.ttml !== 'string' || !isTtml(entry.ttml)) return null;
    totalLength += entry.ttml.length;
    if (totalLength > MAX_TTML_TOTAL_LENGTH) return null;
    candidates.push({ locale, ttml: entry.ttml });
  }
  return candidates;
}

function parseId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value)
    ? value
    : null;
}

function parseSecret(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,256}$/.test(value)
    ? value
    : null;
}

function parseSequence(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : null;
}

function parseCatalogId(value: unknown): string | null {
  // "current" = resolve live nowPlaying on MAIN (when popup still shows listening).
  // Digits (catalog) or library-style ids; MAIN re-resolves via nowPlaying.
  if (typeof value !== 'string') return null;
  if (value === 'current') return 'current';
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value)
    && value !== 'listening'
    && value !== 'unknown'
    ? value
    : null;
}

function parseLocale(value: unknown): string | null {
  return typeof value === 'string'
    && value.length <= 35
    && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(value)
    ? value
    : null;
}

function parseStorefront(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z]{2}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function parseStatus(value: unknown): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 599) {
    return undefined;
  }
  return value as number;
}

function isErrorCode(value: unknown): value is AppleRequestErrorCode {
  return value === 'api-unavailable'
    || value === 'not-authorized'
    || value === 'no-lyrics'
    || value === 'request-failed'
    || value === 'invalid-response'
    || value === 'lyrics-too-large'
    || value === 'busy'
    || value === 'timeout';
}

function isTtml(value: string): boolean {
  const start = value.trimStart().slice(0, 32).toLowerCase();
  return start.startsWith('<tt') || start.startsWith('<?xml');
}

function hasUnknownFields(
  value: Readonly<Record<string, unknown>>,
  fields: ReadonlySet<string>,
): boolean {
  return Object.keys(value).some((key) => !fields.has(key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure<T>(reason: string): AppleRequestParseResult<T> {
  return { success: false, reason };
}
