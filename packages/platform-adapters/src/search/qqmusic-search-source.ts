import type { LyricSearchRequest, LyricSearchResult, LyricSearchResultItem } from './types.js';

export async function searchQqLyrics(request: LyricSearchRequest): Promise<LyricSearchResult> {
  const url = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp');
  url.searchParams.set('w', request.query);
  url.searchParams.set('t', request.searchType === 'lyric' ? '7' : '0');
  url.searchParams.set('p', '1');
  url.searchParams.set('n', String(request.limit ?? 20));
  url.searchParams.set('format', 'json');

  let proxyResponse: { ok: boolean; status?: number; text?: string; error?: string };
  try {
    const init: RequestInit = {
      method: 'GET',
      headers: {
        'Referer': 'https://y.qq.com/',
      },
    };
    // Send to background script proxy to bypass CORS
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromeObj = typeof window !== 'undefined' ? (window as any).chrome : undefined;
    const isQqOrigin = typeof window !== 'undefined' && window.location.hostname.includes('y.qq.com');

    if (!isQqOrigin && chromeObj?.runtime?.sendMessage) {
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
      reason: error instanceof Error ? error.message : 'qqmusic-search-fetch-failed',
    };
  }

  if (!proxyResponse.ok) {
    return { ok: false, reason: `qqmusic-search-http-${proxyResponse.status}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  try {
    payload = JSON.parse(proxyResponse.text || '{}');
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