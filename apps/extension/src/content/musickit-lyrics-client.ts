import type { PortableLyricText } from '@lyric-stage/platform-adapters';
import {
  APPLE_REQUEST_CHANNEL,
  APPLE_REQUEST_PROTOCOL_VERSION,
  parseAppleResponse,
  selectBestTtmlCandidate,
  type AppleRequestCommand,
  type AppleRequestEnvelope,
  type AppleRequestResult,
} from '../musickit/protocol.js';

export type AppleMusicLyricLoadResult =
  | {
    readonly ok: true;
    readonly lyric: PortableLyricText;
    /** Catalog id resolved on MAIN (may upgrade applemusic:listening). */
    readonly resolvedExternalId?: string;
  }
  | { readonly ok: false; readonly reason: string };

function isRequestableMediaId(value: string): boolean {
  if (value === 'current') return true;
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value)
    && value !== 'listening'
    && value !== 'unknown';
}

const REQUEST_TIMEOUT_MS = 12_000;

const bridgeInstanceId = `bridge:${crypto.randomUUID()}`;
const nonce = randomSecret();
let sequence = 0;
const pending = new Map<string, {
  readonly sequence: number;
  readonly resolve: (result: AppleRequestResult) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: number;
}>();

let listening = false;

function ensureListener(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('message', onResponse);
}

function onResponse(event: MessageEvent<unknown>): void {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const parsed = parseAppleResponse(event.data);
  if (!parsed.success) return;
  const response = parsed.value;
  if (response.bridgeInstanceId !== bridgeInstanceId || response.nonce !== nonce) {
    return;
  }
  const request = pending.get(response.requestId);
  if (!request || response.sequence !== request.sequence) return;
  window.clearTimeout(request.timeout);
  pending.delete(response.requestId);
  request.resolve(response.result);
}

function request(command: AppleRequestCommand): Promise<AppleRequestResult> {
  ensureListener();
  sequence += 1;
  const requestSequence = sequence;
  const requestId = `request:${crypto.randomUUID()}`;
  const envelope: AppleRequestEnvelope = {
    channel: APPLE_REQUEST_CHANNEL,
    protocolVersion: APPLE_REQUEST_PROTOCOL_VERSION,
    direction: 'isolated-to-main',
    bridgeInstanceId,
    nonce,
    sequence: requestSequence,
    requestId,
    command,
  };

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Apple Music MAIN-world request timed out'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { sequence: requestSequence, resolve, reject, timeout });
    window.postMessage(envelope, window.location.origin);
  });
}

function readLocale(): string {
  const candidates = [
    document.documentElement.lang,
    navigator.language,
    'en-US',
  ];
  return candidates.find((value) => (
    typeof value === 'string'
    && value.length <= 35
    && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(value)
  )) ?? 'en-US';
}

/**
 * Load Apple Music syllable lyrics (TTML) via MAIN-world MusicKit.
 * Pass catalogId "current" to resolve live nowPlaying when mediaId is still
 * applemusic:listening. Credentials stay in the page MusicKit session.
 */
export async function loadAppleMusicLyricText(
  catalogId: string,
  signal?: AbortSignal,
): Promise<AppleMusicLyricLoadResult> {
  if (!isRequestableMediaId(catalogId)) {
    return { ok: false, reason: 'invalid-catalog-id' };
  }
  if (signal?.aborted) {
    return { ok: false, reason: 'aborted' };
  }

  const locale = readLocale();
  let result: AppleRequestResult;
  try {
    result = await request({ type: 'request-lyrics', catalogId, locale });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: `request-failed:${message}` };
  }

  if (signal?.aborted) {
    return { ok: false, reason: 'aborted' };
  }

  if (result.type === 'error') {
    return {
      ok: false,
      reason: result.status != null
        ? `${result.code}:${result.status}`
        : result.code,
    };
  }
  if (result.type !== 'lyrics') {
    return { ok: false, reason: 'unexpected-ack' };
  }

  const best = selectBestTtmlCandidate(result.candidates, locale);
  if (!best || !best.ttml.trim()) {
    return { ok: false, reason: 'no-ttml-candidate' };
  }

  const resolvedId = result.catalogId || (catalogId === 'current' ? '' : catalogId);
  return {
    ok: true,
    lyric: {
      format: 'ttml',
      text: best.ttml,
      sourceName: resolvedId
        ? `applemusic:${resolvedId}`
        : 'applemusic:current',
    },
    ...(resolvedId
      && resolvedId !== 'current'
      && /^[a-zA-Z0-9._-]{1,64}$/.test(resolvedId)
      ? { resolvedExternalId: resolvedId }
      : {}),
  };
}

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
