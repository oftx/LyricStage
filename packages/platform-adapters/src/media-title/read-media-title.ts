/**
 * Isolated-world-safe media title/creator extraction, ported from the
 * accepted userscript adapters. Only DOM/meta chains — no page-world state
 * (__INITIAL_STATE__ etc.), so every path works from an MV3 content script.
 * navigator.mediaSession is tried first on music platforms where sites
 * maintain it.
 */
import type { DocumentPort } from '../types.js';

export interface MediaTitleInfo {
  readonly title: string | null;
  readonly creators: readonly string[];
}

const EMPTY: MediaTitleInfo = Object.freeze({ title: null, creators: Object.freeze([]) });

function text(document: DocumentPort, selector: string): string | null {
  const element = document.querySelector(selector);
  if (!element) return null;
  const value = element.getAttribute('content')
    ?? (element as { textContent?: string | null }).textContent
    ?? null;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function firstText(document: DocumentPort, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const value = text(document, selector);
    if (value) return value;
  }
  return null;
}

function fromMediaSession(): MediaTitleInfo | null {
  try {
    const metadata = (globalThis.navigator as Navigator | undefined)?.mediaSession?.metadata;
    const title = metadata?.title?.trim();
    if (!title) return null;
    const artist = metadata?.artist?.trim();
    return {
      title,
      creators: artist ? Object.freeze(artist.split(/\s*[/、]\s*/).filter(Boolean)) : Object.freeze([]),
    };
  } catch {
    return null;
  }
}

export function cleanBilibiliTitle(value: string): string {
  return value
    .replace(/[_\s-]*(?:bilibili|哔哩哔哩)(?:[_\s-]*(?:bilibili|哔哩哔哩))*\s*$/i, '')
    .replace(/第(\d+)(?:集|话)-番剧-全集-高清正版在线观看\s*$/u, '第$1话')
    .trim();
}

function readDocumentTitle(document: DocumentPort): string | null {
  const doc = document as { title?: string };
  const value = doc.title?.trim();
  return value ? value : null;
}

function readYouTube(document: DocumentPort): MediaTitleInfo {
  const title = firstText(document, [
    'ytd-watch-metadata h1 yt-formatted-string',
    '#title h1 yt-formatted-string',
    'ytd-reel-video-renderer[is-active] #video-title',
    'meta[name="title"]',
  ]) ?? readDocumentTitle(document)?.replace(/\s+-\s+YouTube\s*$/i, '').trim()
    ?? null;
  const creator = firstText(document, [
    'ytd-watch-metadata #owner #channel-name a',
    '#owner-name a',
    'ytd-reel-video-renderer[is-active] #channel-name a',
    'ytd-reel-video-renderer[is-active] ytd-channel-name a',
    'meta[itemprop="author"]',
  ]);
  return {
    title: title || null,
    creators: creator ? Object.freeze([creator]) : Object.freeze([]),
  };
}

function readBilibili(document: DocumentPort): MediaTitleInfo {
  const rawTitle = firstText(document, [
    '.video-title',
    'h1[title]',
    'meta[property="og:title"]',
    '[class*="mediaTitle"]',
  ]) ?? readDocumentTitle(document);
  const title = rawTitle ? cleanBilibiliTitle(rawTitle) : null;
  const creator = firstText(document, [
    '.up-info-container .up-name',
    '.up-detail-top .up-name',
    '.up-name',
    'meta[name="author"]',
  ]);
  return {
    title: title || null,
    creators: creator ? Object.freeze([creator.trim()]) : Object.freeze([]),
  };
}

function readNetease(document: DocumentPort): MediaTitleInfo {
  const title = firstText(document, [
    '#g_player .words a[href*="/song?id="]',
    '.m-playbar .words a[href*="/song?id="]',
  ]);
  const creator = firstText(document, [
    '#g_player .words a[href*="/artist?id="]',
    '.m-playbar .words a[href*="/artist?id="]',
  ]);
  return {
    title,
    creators: creator ? Object.freeze([creator]) : Object.freeze([]),
  };
}

function readQq(document: DocumentPort): MediaTitleInfo {
  const title = firstText(document, [
    '.player__ft a[href*="songDetail"]',
    '.player_music__info a[href*="/songDetail/"]',
  ]);
  const creator = firstText(document, [
    '.player__ft .playlist__author',
    '.player_music__info [href*="/singer/"]',
  ]);
  return {
    title,
    creators: creator ? Object.freeze([creator]) : Object.freeze([]),
  };
}

export function readMediaTitleInfo(
  platform: string,
  document: DocumentPort,
): MediaTitleInfo {
  // Music platforms maintain Media Session metadata; video platforms often
  // set it too but their DOM titles are richer (multi-part names etc.), so
  // DOM wins on youtube/bilibili and mediaSession wins on music sites.
  if (platform === 'netease' || platform === 'qqmusic' || platform === 'applemusic') {
    const session = fromMediaSession();
    if (session) return session;
  }
  if (platform === 'youtube') return readYouTube(document);
  if (platform === 'bilibili') {
    const info = readBilibili(document);
    if (info.title) return info;
    return fromMediaSession() ?? EMPTY;
  }
  if (platform === 'netease') return readNetease(document);
  if (platform === 'qqmusic') return readQq(document);
  return fromMediaSession() ?? EMPTY;
}
