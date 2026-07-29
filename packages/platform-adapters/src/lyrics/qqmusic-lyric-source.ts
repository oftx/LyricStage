import {
  buildQqLyricPayload,
  decodeQqLyricBlob,
  extractQqLyricContent,
  parseQqJson,
  type QqLyricTrack,
} from './qqmusic-qrc.js';
import type { LyricLoadRequest, LyricLoadResult, PortableLyricText } from './types.js';

export const QQ_TRACK_ENDPOINT = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg';
export const QQ_LYRIC_ENDPOINT = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function fetchText(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<string> {
  const next: RequestInit = { ...init };
  // Check if we can use normal fetch (same origin) or need proxy
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chromeObj = typeof window !== 'undefined' ? (window as any).chrome : undefined;
  const isQqOrigin = typeof window !== 'undefined' && window.location.hostname.includes('y.qq.com');

  if (!isQqOrigin && chromeObj?.runtime?.sendMessage) {
    const proxyResponse = await chromeObj.runtime.sendMessage({
      kind: 'lyric-stage-fetch-proxy',
      request: { url, init: next },
    });
    if (!proxyResponse) throw new Error('No response from fetch proxy');
    if (proxyResponse.error) throw new Error(proxyResponse.error);
    if (!proxyResponse.ok) throw new Error(`qq-http-${proxyResponse.status}`);
    return proxyResponse.text || '';
  }

  if (signal) next.signal = signal;
  const response = await fetch(url, next);
  if (!response.ok) {
    throw new Error(`qq-http-${response.status}`);
  }
  return response.text();
}

/**
 * Port of apps/lyric-stage QqMusicLyricSource — portable text only.
 * Uses extension host_permissions for c.y.qq.com / u.y.qq.com (not GM_xhr).
 */
export async function loadQqMusicLyricText(
  request: LyricLoadRequest,
): Promise<LyricLoadResult> {
  const songmid = request.externalId;
  if (!/^[0-9A-Za-z]{14}$/.test(songmid)) {
    return { ok: false, reason: `invalid-qq-songmid:${songmid}` };
  }

  let track: QqLyricTrack;
  try {
    track = await fetchQqTrack(songmid, request.signal);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'qq-track-failed',
    };
  }

  try {
    const lyric = await fetchQqLyrics(track, request.signal);
    if (!lyric.text.trim()) {
      return { ok: false, reason: 'qq-empty-body' };
    }
    return {
      ok: true,
      lyric,
      track: {
        title: track.title,
        artists: track.artist ? [track.artist] : [],
        ...(track.album ? { album: track.album } : {}),
        ...(track.durationSeconds > 0
          ? { durationMs: track.durationSeconds * 1000 }
          : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'qq-lyric-failed',
    };
  }
}

async function fetchQqTrack(
  songmid: string,
  signal?: AbortSignal,
): Promise<QqLyricTrack> {
  const url = new URL(QQ_TRACK_ENDPOINT);
  url.searchParams.set('songmid', songmid);
  url.searchParams.set('format', 'json');
  const responseText = await fetchText(url.toString(), {
    method: 'GET',
    headers: { Referer: 'https://y.qq.com/' },
    credentials: 'include',
  }, signal);
  const root = asRecord(parseQqJson(responseText));
  const songs = Array.isArray(root?.data) ? root.data : [];
  const song = asRecord(songs[0]);
  const songId = asFiniteNumber(song?.id ?? song?.songid);
  if (!song || !Number.isInteger(songId) || songId <= 0) {
    throw new Error('qq-track-missing');
  }
  const singers = Array.isArray(song.singer)
    ? song.singer.map((entry) => asString(asRecord(entry)?.name)).filter(Boolean)
    : [];
  const album = asRecord(song.album);
  return {
    songmid: asString(song.mid) || songmid,
    songid: Math.trunc(songId),
    title: asString(song.name) || `QQ ${songmid}`,
    artist: singers.join(', '),
    album: asString(album?.name),
    durationSeconds: Math.max(0, asFiniteNumber(song.interval ?? song.duration)),
  };
}

async function fetchQqLyrics(
  track: QqLyricTrack,
  signal?: AbortSignal,
): Promise<PortableLyricText> {
  const responseText = await fetchText(QQ_LYRIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://y.qq.com/',
    },
    credentials: 'include',
    body: JSON.stringify(buildQqLyricPayload(track)),
  }, signal);
  const root = asRecord(parseQqJson(responseText));
  const request = asRecord(root?.request);
  const data = asRecord(request?.data);
  if (!data) throw new Error('qq-lyric-format');

  const originalBlob = asString(data.lyric);
  if (!originalBlob) {
    return { format: 'lrc', text: '', sourceName: 'qqmusic.empty' };
  }
  const original = extractQqLyricContent(await decodeQqLyricBlob(originalBlob));
  let translation = '';
  const translationBlob = asString(data.trans);
  if (translationBlob) {
    try {
      translation = extractQqLyricContent(await decodeQqLyricBlob(translationBlob));
    } catch {
      // keep main lyric
    }
  }
  let pronunciation = '';
  const pronunciationBlob = asString(data.roma);
  if (pronunciationBlob) {
    try {
      pronunciation = extractQqLyricContent(await decodeQqLyricBlob(pronunciationBlob));
    } catch {
      // keep main lyric
    }
  }

  const isQrc = /^\s*\[\d+,\d+\]/m.test(original);
  return {
    format: isQrc ? 'qrc' : 'lrc',
    text: original,
    sourceName: isQrc ? 'qqmusic.qrc' : 'qqmusic.lrc',
    ...(translation ? { translationText: translation } : {}),
    ...(pronunciation ? { pronunciationText: pronunciation } : {}),
  };
}
