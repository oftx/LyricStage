import { weapiEncrypt } from '../lyrics/netease-weapi-crypto.js';
import type { LyricSearchRequest, LyricSearchResult, LyricSearchResultItem } from './types.js';

export async function searchNeteaseLyrics(request: LyricSearchRequest): Promise<LyricSearchResult> {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://music.163.com';
  const url = new URL('/weapi/cloudsearch/get/web', origin);

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
      reason: error instanceof Error ? error.message : 'netease-search-fetch-failed',
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `netease-search-http-${response.status}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: 'netease-search-invalid-json' };
  }

  if (payload.code !== 200) {
    return { ok: false, reason: `netease-search-code-${payload.code}` };
  }

  const songs = payload.result?.songs || [];
  const items: LyricSearchResultItem[] = songs.map((s: any) => {
    return {
      platform: 'netease',
      externalId: String(s.id),
      title: s.name,
      artists: (s.ar || []).map((a: any) => a.name),
      ...(s.al?.name ? { album: s.al.name } : {}),
      ...(typeof s.dt === 'number' ? { durationMs: s.dt } : {}),
      ...(s.lyrics && s.lyrics.length > 0 ? { snippet: s.lyrics[0] } : {}),
    };
  });

  return { ok: true, items };
}