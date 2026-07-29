import { weapiEncrypt } from '../lyrics/netease-weapi-crypto.js';
import type { LyricSearchRequest, LyricSearchResult, LyricSearchResultItem } from './types.js';

export async function searchNeteaseLyrics(request: LyricSearchRequest): Promise<LyricSearchResult> {
  const url = new URL('/weapi/search/get', 'https://music.163.com');

  // Need csrf token from cookie
  const csrf = typeof document !== 'undefined' ? (document.cookie.match(/__csrf=([^;]+)/)?.[1] ?? '') : '';
  if (csrf) url.searchParams.set('csrf_token', csrf);

  const plaintext = JSON.stringify({
    hlpretag: '<em>',
    hlposttag: '</em>',
    s: request.query,
    type: request.searchType === 'lyric' ? 1006 : 1,
    offset: 0,
    total: true,
    limit: request.limit ?? 20,
  });

  let encrypted: { params: string; encSecKey: string };
  try {
    encrypted = await weapiEncrypt(plaintext);
  } catch {
    return { ok: false, reason: 'netease-search-encrypt-failed' };
  }

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
      reason: error instanceof Error ? error.message : 'netease-search-fetch-failed',
    };
  }

  if (!proxyResponse.ok) {
    return { ok: false, reason: `netease-search-http-${proxyResponse.status}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  try {
    payload = JSON.parse(proxyResponse.text || '{}');
  } catch {
    return { ok: false, reason: 'netease-search-invalid-json' };
  }

  if (payload.code !== 200) {
    return { ok: false, reason: `netease-search-code-${payload.code}` };
  }

  const songs = payload.result?.songs || [];
  const items: LyricSearchResultItem[] = songs.map((s: any) => {
    const artistsArr = s.artists || s.ar || [];
    const albumName = s.album?.name || s.al?.name;
    const duration = typeof s.duration === 'number' ? s.duration : s.dt;
    let snippet: string | undefined;
    if (s.lyrics) {
      snippet = Array.isArray(s.lyrics) ? s.lyrics[0] : s.lyrics.txt;
    }

    return {
      platform: 'netease',
      externalId: String(s.id),
      title: s.name,
      artists: artistsArr.map((a: any) => a.name),
      ...(albumName ? { album: albumName } : {}),
      ...(typeof duration === 'number' ? { durationMs: duration } : {}),
      ...(snippet ? { snippet } : {}),
    };
  });

  return { ok: true, items };
}