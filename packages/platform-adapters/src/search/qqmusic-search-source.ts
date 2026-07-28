import type { LyricSearchRequest, LyricSearchResult, LyricSearchResultItem } from './types.js';

export async function searchQqLyrics(request: LyricSearchRequest): Promise<LyricSearchResult> {
  const url = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp');
  url.searchParams.set('w', request.query);
  url.searchParams.set('t', request.searchType === 'lyric' ? '7' : '0');
  url.searchParams.set('p', '1');
  url.searchParams.set('n', String(request.limit ?? 20));
  url.searchParams.set('format', 'json');

  let response: Response;
  try {
    const init: RequestInit = {
      method: 'GET',
      headers: {
        'Referer': 'https://y.qq.com/',
      },
    };
    if (request.signal) init.signal = request.signal;
    response = await fetch(url, init);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'qqmusic-search-fetch-failed',
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `qqmusic-search-http-${response.status}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: 'qqmusic-search-invalid-json' };
  }

  if (payload.code !== 0) {
    return { ok: false, reason: `qqmusic-search-code-${payload.code}` };
  }

  const items: LyricSearchResultItem[] = [];

  if (request.searchType === 'lyric') {
    const list = payload.data?.lyric?.list || [];
    for (const s of list) {
      items.push({
        platform: 'qqmusic',
        externalId: s.songmid,
        title: s.songname,
        artists: (s.singer || []).map((a: any) => a.name),
        ...(s.content ? { snippet: s.content.replace(/\\n/g, '  ') } : {}),
      });
    }
  } else {
    const list = payload.data?.song?.list || [];
    for (const s of list) {
      items.push({
        platform: 'qqmusic',
        externalId: s.songmid,
        title: s.songname,
        artists: (s.singer || []).map((a: any) => a.name),
        ...(s.albumname ? { album: s.albumname } : {}),
        ...(typeof s.interval === 'number' ? { durationMs: s.interval * 1000 } : {}),
      });
    }
  }

  return { ok: true, items };
}