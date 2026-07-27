import type { DocumentPort } from '../types.js';

const CATALOG_ID = /^\d{1,20}$/;
/** Catalog or library song id as exposed by MusicKit. */
const MEDIA_ID = /^[a-zA-Z0-9._-]{1,64}$/;

export function isAppleMusicHost(href: string): boolean {
  try {
    const host = new URL(href).hostname.replace(/^www\./, '');
    return host === 'music.apple.com' || host.endsWith('.music.apple.com');
  } catch {
    return false;
  }
}

function asId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * Catalog id extraction matching the lyric-stage userscript:
 * playParams.catalogId → playParams.id → item.id
 * Never invent an id by scraping random digits out of library ids.
 */
export function getAppleMusicCatalogIdFromItem(item: {
  readonly id?: unknown;
  readonly attributes?: {
    readonly playParams?: {
      readonly catalogId?: unknown;
      readonly id?: unknown;
    } | null;
  } | null;
} | null | undefined): string {
  if (!item) return '';
  const playParams = item.attributes?.playParams;
  return asId(playParams?.catalogId)
    || asId(playParams?.id)
    || asId(item.id);
}

export function isAppleMusicCatalogId(value: string): boolean {
  return CATALOG_ID.test(value);
}

export function isAppleMusicMediaId(value: string): boolean {
  return MEDIA_ID.test(value) && value !== 'listening' && value !== 'unknown';
}

/**
 * Extract Apple Music catalog song id from a URL or path fragment.
 * Supports:
 * - /song/{slug}/{id}
 * - /album/{slug}/{albumId}?i={songId}
 * - trailing /{id} on song routes
 */
export function extractAppleMusicCatalogId(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // keep raw
  }

  try {
    const url = new URL(decoded, 'https://music.apple.com');
    const fromQuery = url.searchParams.get('i');
    if (fromQuery && CATALOG_ID.test(fromQuery)) return fromQuery;

    const songMatch = url.pathname.match(/\/song\/[^/]+\/(\d{1,20})(?:\/|$)/i);
    if (songMatch?.[1]) return songMatch[1];

    const bareSong = url.pathname.match(/\/song\/(\d{1,20})(?:\/|$)/i);
    if (bareSong?.[1]) return bareSong[1];
  } catch {
    // fall through
  }

  const queryMatch = decoded.match(/[?&]i=(\d{1,20})(?:[&#]|$)/);
  if (queryMatch?.[1]) return queryMatch[1];

  const pathMatch = decoded.match(/\/song\/(?:[^/]+\/)?(\d{1,20})(?:\/|[?#]|$)/i);
  if (pathMatch?.[1]) return pathMatch[1];

  if (CATALOG_ID.test(decoded.trim())) return decoded.trim();
  return null;
}

/**
 * Prefer the mini-player / LCD now-playing link over arbitrary page song links.
 * Browse/library pages list many /song/ anchors that are not the active track —
 * never use those as a last resort (userscript only trusts MusicKit item).
 */
export function findAppleMusicCatalogIdFromDocument(
  document: DocumentPort,
): string | null {
  const fromHref = extractAppleMusicCatalogId(document.location.href);
  if (fromHref) return fromHref;

  const playerSelectors = [
    'amp-lcd a[href*="/song/"]',
    '[data-testid="lcd-song-link"]',
    '[data-testid="player-title"] a[href*="/song/"]',
    '.web-chrome-playback-lcd__song-name-scroll a[href*="/song/"]',
    '.web-chrome-playback-lcd a[href*="/song/"]',
    'div[class*="playback-lcd"] a[href*="/song/"]',
  ];
  for (const selector of playerSelectors) {
    const link = document.querySelector(selector);
    if (!link) continue;
    const id = extractAppleMusicCatalogId(link.getAttribute('href'));
    if (id) return id;
  }
  return null;
}
