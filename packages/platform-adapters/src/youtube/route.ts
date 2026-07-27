export type YouTubeRoute =
  | { readonly type: 'watch' | 'shorts'; readonly externalId: string }
  | null;

const VIDEO_ID_PATTERN = /^[\w-]{6,20}$/;

export function parseYouTubeRoute(href: string): YouTubeRoute {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be' && host !== 'music.youtube.com') {
    // Allow local smoke hosts that embed youtube-like paths for tests.
    if (!url.pathname.includes('/watch') && !url.pathname.includes('/shorts/')) {
      return null;
    }
  }
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return VIDEO_ID_PATTERN.test(id) ? { type: 'watch', externalId: id } : null;
  }
  const shorts = url.pathname.match(/\/shorts\/([\w-]{6,20})/);
  if (shorts?.[1]) return { type: 'shorts', externalId: shorts[1] };
  const watchId = url.searchParams.get('v');
  if (watchId && VIDEO_ID_PATTERN.test(watchId)) {
    return { type: 'watch', externalId: watchId };
  }
  return null;
}

export function isLikelyYouTubeAdvertisement(
  player: {
    classList?: { contains(token: string): boolean };
    querySelector?(sel: string): unknown;
  } | null,
  video: { currentSrc?: string; src?: string } | null,
): boolean {
  // Authoritative player chrome flags — residual empty ad containers stay in the
  // DOM after ads end and must not freeze content as "buffering" forever.
  if (player?.classList?.contains('ad-showing') || player?.classList?.contains('ad-interrupting')) {
    return true;
  }
  if (video) {
    const src = `${video.currentSrc || video.src || ''}`.toLowerCase();
    // blob: main content is never the ad stream; googlevideo with oad=* is.
    if (src.startsWith('blob:')) {
      return false;
    }
    if (src.includes('googlevideo.com/videoplayback') && /[?&]oad[^=]*=/.test(src)) {
      return true;
    }
  }
  // Only treat overlay DOM as ad when something is actually painted/visible.
  const overlay = player?.querySelector?.(
    '.ytp-ad-player-overlay, .ytp-ad-module .ytp-ad-player-overlay-instream-info, .video-ads .ad-showing',
  );
  return isVisibleAdNode(overlay);
}

function isVisibleAdNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const el = node as {
    offsetWidth?: number;
    offsetHeight?: number;
    getClientRects?: () => { length: number };
    checkVisibility?: (options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean;
  };
  try {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
  } catch {
    // fall through
  }
  const w = el.offsetWidth ?? 0;
  const h = el.offsetHeight ?? 0;
  if (w > 0 && h > 0) return true;
  try {
    return Boolean(el.getClientRects && el.getClientRects().length > 0);
  } catch {
    return false;
  }
}
