/**
 * Bilibili route parsing for the extension raw-signal adapter. Ported from
 * the accepted userscript implementation
 * (apps/lyric-stage/src/platforms/bilibili/BilibiliPlaybackAdapter.ts).
 *
 * Supported page families:
 * - /video/BV*|av* — normal videos; multi-part identity carries the part
 *   number as contextId so lyrics/positions never bind to the wrong part;
 * - /bangumi/play/ep*|ss* — bangumi; ss ids resolve to the episode when the
 *   document exposes it (canonical link / og:url / active episode anchor).
 */
import type { DocumentPort } from '../types.js';

export type BilibiliRoute =
  | {
    readonly type: 'video';
    /** Normalized BV id ("BV..." casing) or lowercase "av<aid>". */
    readonly externalId: string;
  }
  | {
    readonly type: 'bangumi';
    /** "ep<id>" when known, else the raw "ss<id>". */
    readonly externalId: string;
  }
  | null;

export function isBilibiliHost(href: string): boolean {
  try {
    const host = new URL(href).hostname.replace(/^www\./, '');
    return host === 'bilibili.com' || host === 'm.bilibili.com';
  } catch {
    return false;
  }
}

export function parseBilibiliRoute(href: string): BilibiliRoute {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!isBilibiliHost(href)) return null;

  const videoMatch = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)(?:\/|$)/i);
  if (videoMatch?.[1]) {
    const rawId = videoMatch[1];
    return {
      type: 'video',
      externalId: /^bv/i.test(rawId) ? `BV${rawId.slice(2)}` : rawId.toLowerCase(),
    };
  }

  const bangumiMatch = url.pathname.match(/^\/bangumi\/play\/(ep|ss)(\d+)(?:\/|$)/i);
  if (!bangumiMatch?.[1] || !bangumiMatch[2]) return null;
  return {
    type: 'bangumi',
    externalId: `${bangumiMatch[1].toLowerCase()}${bangumiMatch[2]}`,
  };
}

/**
 * Part number for multi-part videos: URL ?p= first, then the active playlist
 * anchor in the DOM. The userscript's __INITIAL_STATE__ tier is unavailable
 * from the isolated world and the remaining tiers cover real pages.
 */
export function readBilibiliPageNumber(
  href: string,
  document: DocumentPort,
): number {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return 1;
  }
  const queryPage = positiveInteger(url.searchParams.get('p'));
  if (queryPage) return queryPage;

  const activeSelectors = [
    '.video-pod__item.active a[href*="?p="]',
    '.video-pod__item--active a[href*="?p="]',
    '.multi-page .list-box li.on a[href*="?p="]',
    '.cur-list li.on a[href*="?p="]',
  ];
  for (const selector of activeSelectors) {
    const anchor = document.querySelector(selector);
    const anchorHref = anchor?.getAttribute('href');
    if (!anchorHref) continue;
    try {
      const page = positiveInteger(
        new URL(anchorHref, url).searchParams.get('p'),
      );
      if (page) return page;
    } catch {
      // malformed anchor href — try the next selector
    }
  }
  return 1;
}

/**
 * Resolve an ss-route to its current episode from document metadata: the
 * canonical link, og:url, or the active episode anchor. Returns "ep<id>" or
 * null when the page does not expose it (identity then stays on the ss id).
 */
export function resolveBilibiliEpisodeId(document: DocumentPort): string | null {
  const candidates = [
    document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    document.querySelector('meta[property="og:url"]')?.getAttribute('content'),
    document.querySelector('a[href*="/bangumi/play/ep"][class*="active"]')?.getAttribute('href'),
  ];
  for (const candidate of candidates) {
    const match = candidate?.match(/\/bangumi\/play\/ep(\d+)/i);
    if (match?.[1]) return `ep${match[1]}`;
  }
  return null;
}

function positiveInteger(value: string | number | null | undefined): number | null {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}
