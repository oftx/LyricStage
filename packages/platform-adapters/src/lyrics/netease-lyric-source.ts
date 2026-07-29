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

  const url = new URL('/api/song/lyric/v1', 'https://music.163.com');
  url.searchParams.set('id', songId);
  url.searchParams.set('cp', 'false');
  for (const parameter of ['lv', 'kv', 'tv', 'rv', 'yv', 'ytv', 'yrv']) {
    url.searchParams.set(parameter, '0');
  }

  let proxyResponse: { ok: boolean; status?: number; text?: string; error?: string };
  try {
    const init: RequestInit = { credentials: 'include' };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromeObj = typeof window !== 'undefined' ? (window as any).chrome : undefined;
    const isNeteaseOrigin = typeof window !== 'undefined' && window.location.hostname.includes('music.163.com');

    if (!isNeteaseOrigin && chromeObj?.runtime?.sendMessage) {
      proxyResponse = await chromeObj.runtime.sendMessage({
        kind: 'lyric-stage-fetch-proxy',
        request: { url: url.toString(), init },
      });
      if (!proxyResponse) throw new Error('No response from fetch proxy');
      if (proxyResponse.error) throw new Error(proxyResponse.error);
    } else {
      if (request.signal) init.signal = request.signal;
      const response = await fetch(url, init);
      proxyResponse = {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'netease-fetch-failed',
    };
  }
  if (!proxyResponse.ok) {
    return { ok: false, reason: `netease-http-${proxyResponse.status}` };
  }

  let payload: NeteaseLyricApiResponse;
  try {
    payload = JSON.parse(proxyResponse.text || '{}') as NeteaseLyricApiResponse;
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

  const url = new URL('/weapi/cloud/lyric/get', 'https://music.163.com');
  // The weapi endpoint requires the csrf_token query param from the __csrf cookie.
  const csrf = typeof document !== 'undefined'
    ? (document.cookie.match(/__csrf=([^;]+)/)?.[1] ?? '')
    : '';
  if (csrf) url.searchParams.set('csrf_token', csrf);

  let proxyResponse: { ok: boolean; status?: number; text?: string; error?: string };
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      body: `params=${encodeURIComponent(encrypted.params)}&encSecKey=${encodeURIComponent(encrypted.encSecKey)}`,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromeObj = typeof window !== 'undefined' ? (window as any).chrome : undefined;
    const isNeteaseOrigin = typeof window !== 'undefined' && window.location.hostname.includes('music.163.com');

    if (!isNeteaseOrigin && chromeObj?.runtime?.sendMessage) {
      proxyResponse = await chromeObj.runtime.sendMessage({
        kind: 'lyric-stage-fetch-proxy',
        request: { url: url.toString(), init },
      });
      if (!proxyResponse) throw new Error('No response from fetch proxy');
      if (proxyResponse.error) throw new Error(proxyResponse.error);
    } else {
      if (request.signal) init.signal = request.signal;
      const response = await fetch(url, init);
      proxyResponse = {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'netease-cloud-fetch-failed',
    };
  }
  if (!proxyResponse.ok) {
    return { ok: false, reason: `netease-cloud-http-${proxyResponse.status}` };
  }

  let payload: CloudLyricResponse;
  try {
    payload = JSON.parse(proxyResponse.text || '{}') as CloudLyricResponse;
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
