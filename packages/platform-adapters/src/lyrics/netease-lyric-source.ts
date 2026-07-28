import type { LyricLoadRequest, LyricLoadResult, PortableLyricText } from './types.js';
import { weapiEncrypt } from './netease-weapi-crypto.js';

export type NeteaseLyricApiResponse = {
  code?: number;
  lrc?: { lyric?: string };
  tlyric?: { lyric?: string };
  yrc?: { lyric?: string };
  ytlrc?: { lyric?: string };
  romalrc?: { lyric?: string };
  yromalrc?: { lyric?: string };
  rv?: { lyric?: string };
  yrv?: { lyric?: string };
  nolyric?: boolean;
  uncollected?: boolean;
};

/**
 * NetEase embeds song credits as one JSON object per physical line, e.g.
 * `{"t":0,"c":[{"tx":"作词: "},{"tx":"…"}]}`.
 * parseLrc treats those as static lyric rows and shows the raw JSON in the UI.
 */
export function stripNeteaseNonLyricLines(text: string): string {
  if (!text) return text;
  const kept: string[] = [];
  for (const line of text.replace(/^\uFEFF/u, '').split(/\r\n?|\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push(line);
      continue;
    }
    if (isNeteaseJsonCreditLine(trimmed)) continue;
    kept.push(line);
  }
  // Drop leading/trailing blank runs created by credit removal.
  return kept.join('\n').replace(/^\n+|\n+$/gu, '');
}

function isNeteaseJsonCreditLine(trimmed: string): boolean {
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) return false;
  // Fast path: credit JSON always uses "tx" text fragments.
  if (!/"tx"\s*:/.test(trimmed)) return false;
  try {
    const parsed = JSON.parse(trimmed) as {
      t?: unknown;
      c?: unknown;
    };
    if (typeof parsed.t !== 'number' || !Array.isArray(parsed.c)) return false;
    return parsed.c.every((part) => {
      if (!part || typeof part !== 'object') return false;
      const tx = (part as { tx?: unknown }).tx;
      return typeof tx === 'string';
    });
  } catch {
    return false;
  }
}

/**
 * Port of apps/lyric-stage NeteaseLyricSource — returns portable text only.
 * Must run in page context with credentials (same-origin music.163.com).
 */
export async function loadNeteaseLyricText(
  request: LyricLoadRequest,
): Promise<LyricLoadResult> {
  const songId = request.externalId;
  if (!/^\d+$/.test(songId)) {
    return { ok: false, reason: `invalid-netease-id:${songId}` };
  }

  const origin = request.origin
    ?? (typeof window !== 'undefined' ? window.location.origin : 'https://music.163.com');
  const url = new URL('/api/song/lyric/v1', origin);
  url.searchParams.set('id', songId);
  url.searchParams.set('cp', 'false');
  for (const parameter of ['lv', 'kv', 'tv', 'rv', 'yv', 'ytv', 'yrv']) {
    url.searchParams.set(parameter, '0');
  }

  let response: Response;
  try {
    const init: RequestInit = { credentials: 'include' };
    if (request.signal) init.signal = request.signal;
    response = await fetch(url, init);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'netease-fetch-failed',
    };
  }
  if (!response.ok) {
    return { ok: false, reason: `netease-http-${response.status}` };
  }

  let payload: NeteaseLyricApiResponse;
  try {
    payload = (await response.json()) as NeteaseLyricApiResponse;
  } catch {
    return { ok: false, reason: 'netease-invalid-json' };
  }
  if (payload.code !== undefined && payload.code !== 200) {
    return { ok: false, reason: `netease-code-${payload.code}` };
  }
  if (payload.nolyric) {
    return { ok: false, reason: 'netease-no-lyric' };
  }
  if (payload.uncollected) {
    return loadNeteaseCloudLyricText(request);
  }

  const yrc = stripNeteaseNonLyricLines(payload.yrc?.lyric?.trim() ?? '');
  const lrc = stripNeteaseNonLyricLines(payload.lrc?.lyric?.trim() ?? '');
  const translation = stripNeteaseNonLyricLines(
    (payload.ytlrc?.lyric || payload.tlyric?.lyric || '').trim(),
  );
  const pronunciation = stripNeteaseNonLyricLines((
    payload.yromalrc?.lyric
    || payload.yrv?.lyric
    || payload.romalrc?.lyric
    || payload.rv?.lyric
    || ''
  ).trim());

  if (yrc) {
    const lyric: PortableLyricText = {
      format: 'yrc',
      text: yrc,
      sourceName: 'netease.yrc',
      ...(translation ? { translationText: translation } : {}),
      ...(pronunciation ? { pronunciationText: pronunciation } : {}),
    };
    return { ok: true, lyric };
  }
  if (!lrc) {
    return { ok: false, reason: 'netease-empty-body' };
  }
  return {
    ok: true,
    lyric: {
      format: 'lrc',
      text: lrc,
      sourceName: 'netease.lrc',
      ...(translation ? { translationText: translation } : {}),
      ...(pronunciation ? { pronunciationText: pronunciation } : {}),
    },
  };
}

type CloudLyricResponse = {
  code?: number;
  lrc?: string;
};

function readNeteaseUserId(): number {
  try {
    // The song detail page defines `GUser` in an inline script.
    // Check main document first, then the contentFrame iframe (SPA layout).
    for (const doc of [document, ...contentFrameDocuments()]) {
      const scripts = doc.querySelectorAll('script:not([src])');
      for (const script of scripts) {
        const text = script.textContent ?? '';
        const match = text.match(/GUser\s*=\s*\{[^}]*userId\s*:\s*(\d+)/);
        if (match) return Number(match[1]);
      }
    }
  } catch {
    // Not on a NetEase page or DOM unavailable.
  }
  return 0;
}

function contentFrameDocuments(): Document[] {
  const docs: Document[] = [];
  try {
    for (const iframe of document.querySelectorAll('iframe')) {
      if (iframe.contentDocument) docs.push(iframe.contentDocument);
    }
  } catch { /* cross-origin */ }
  return docs;
}

/**
 * Fallback: fetch user-contributed lyrics from the cloud lyric endpoint.
 * Used when the primary API returns `uncollected: true`.
 * Requires weapi encryption; the plaintext `/api/` path is not available.
 */
async function loadNeteaseCloudLyricText(
  request: LyricLoadRequest,
): Promise<LyricLoadResult> {
  const songId = request.externalId;
  const origin = request.origin
    ?? (typeof window !== 'undefined' ? window.location.origin : 'https://music.163.com');

  const plaintext = JSON.stringify({
    songId,
    userId: readNeteaseUserId(),
    lv: -1,
    tv: -1,
  });

  let encrypted: { params: string; encSecKey: string };
  try {
    encrypted = await weapiEncrypt(plaintext);
  } catch {
    return { ok: false, reason: 'netease-weapi-encrypt-failed' };
  }

  const url = new URL('/weapi/cloud/lyric/get', origin);
  // The weapi endpoint requires the csrf_token query param from the __csrf cookie.
  const csrf = typeof document !== 'undefined'
    ? (document.cookie.match(/__csrf=([^;]+)/)?.[1] ?? '')
    : '';
  if (csrf) url.searchParams.set('csrf_token', csrf);
  let response: Response;
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      body: `params=${encodeURIComponent(encrypted.params)}&encSecKey=${encodeURIComponent(encrypted.encSecKey)}`,
    };
    if (request.signal) init.signal = request.signal;
    response = await fetch(url, init);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'netease-cloud-fetch-failed',
    };
  }
  if (!response.ok) {
    return { ok: false, reason: `netease-cloud-http-${response.status}` };
  }

  let payload: CloudLyricResponse;
  try {
    payload = (await response.json()) as CloudLyricResponse;
  } catch {
    return { ok: false, reason: 'netease-cloud-invalid-json' };
  }
  if (payload.code !== undefined && payload.code !== 200) {
    return { ok: false, reason: `netease-cloud-code-${payload.code}` };
  }

  const lrc = (payload.lrc ?? '').trim();
  if (!lrc) {
    return { ok: false, reason: 'netease-cloud-empty' };
  }
  return {
    ok: true,
    lyric: {
      format: 'lrc',
      text: lrc,
      sourceName: 'netease.cloud',
    },
  };
}
