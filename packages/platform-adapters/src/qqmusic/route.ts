import type { DocumentPort, ElementPort, MediaElementPort } from '../types.js';

const SONGMID_PATTERN = /(?:songDetail\/|[?&]songmid=)([0-9A-Za-z]{14})(?:[/?&#.]|$)/i;
const MEDIA_SONGMID_PATTERN = /(?:M800|M500|C400|C200|O600|O400|O200|F000|A000|RS02)([0-9A-Za-z]{14})(?:\.|[?&#]|$)/i;

export function extractQqSongMid(value: string | null | undefined): string | null {
  if (!value) return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // keep raw
  }
  const match = decoded.match(SONGMID_PATTERN);
  if (match?.[1]) return match[1];
  const mediaMatch = decoded.match(MEDIA_SONGMID_PATTERN);
  if (mediaMatch?.[1]) return mediaMatch[1];
  if (/^[0-9A-Za-z]{14}$/.test(value)) return value;
  return null;
}

export function isQqMusicHost(href: string): boolean {
  try {
    const host = new URL(href).hostname.replace(/^www\./, '');
    return host === 'y.qq.com' || host.endsWith('.y.qq.com');
  } catch {
    return false;
  }
}

/**
 * Only the dedicated player page may treat page content as media evidence.
 * Homepage, search, and songDetail pages are full of /songDetail/ links
 * (recommendations, charts, suggestions) that say nothing about playback.
 */
export function isQqPlayerPage(href: string): boolean {
  if (!isQqMusicHost(href)) return false;
  try {
    const pathname = new URL(href).pathname;
    return /^\/n\/[^/]+\/player(?:$|[/?#])/.test(pathname);
  } catch {
    return false;
  }
}

export interface FindQqSongMidOptions {
  /**
   * Allow the document-wide marker scan. Off-player pages must not enable
   * this — the first matching anchor there is an arbitrary recommended song,
   * not the playing one.
   */
  readonly includeDocumentWideFallback?: boolean;
}

export function findQqSongMidFromDocument(
  document: DocumentPort,
  options: FindQqSongMidOptions = {},
): string | null {
  const activeMarker = document.querySelector([
    '.player_music__info a[href*="/songDetail/"]',
    '.songlist__item--playing [data-songmid]',
    '.songlist__item--playing [data-mid]',
    '.songlist__item--playing a[href*="/songDetail/"]',
    '[aria-current="true"][data-songmid]',
    '[aria-current="true"][data-mid]',
  ].join(', '));
  if (activeMarker) {
    const activeMid = extractQqSongMid(
      activeMarker.getAttribute('data-songmid')
        ?? activeMarker.getAttribute('data-mid')
        ?? activeMarker.getAttribute('href'),
    );
    if (activeMid) return activeMid;
  }

  if (!options.includeDocumentWideFallback) return null;

  const markers = document.querySelectorAll(
    '[data-songmid], [data-mid], a[href*="/songDetail/"], a[href*="songmid="]',
  );
  for (const element of markers) {
    const mid = extractQqSongMid(
      element.getAttribute('data-songmid')
        ?? element.getAttribute('data-mid')
        ?? element.getAttribute('href'),
    );
    if (mid) return mid;
  }
  return null;
}

export function pickBestMediaElement(
  elements: Iterable<MediaElementPort | ElementPort>,
  preferredSongmid: string | null,
): MediaElementPort | null {
  let best: MediaElementPort | null = null;
  let bestScore = -1;
  for (const candidate of elements) {
    if (!isMediaElement(candidate) || !candidate.isConnected) continue;
    const source = `${candidate.currentSrc || candidate.src || ''}`;
    const sourceMid = extractQqSongMid(source);
    if (preferredSongmid && sourceMid && sourceMid !== preferredSongmid) continue;
    const score = (!candidate.paused && !candidate.ended ? 100 : 0)
      + (candidate.currentTime > 0 ? 20 : 0)
      + (Number.isFinite(candidate.duration) && candidate.duration > 0 ? 10 : 0)
      + (sourceMid ? 30 : 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function isMediaElement(value: MediaElementPort | ElementPort): value is MediaElementPort {
  return typeof (value as MediaElementPort).currentTime === 'number'
    && typeof (value as MediaElementPort).paused === 'boolean';
}
