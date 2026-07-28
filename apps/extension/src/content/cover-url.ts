/**
 * Best-effort album art URL for the current track (DOM / Media Session).
 * Used for lyric-window cover background; never blocks playback.
 */

function isUsableCoverUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 2_048) return false;
  if (trimmed.startsWith('data:image/')) return true;
  if (trimmed.startsWith('blob:')) return true;
  if (!/^https?:\/\//i.test(trimmed)) return false;
  // Skip obvious 1×1 / placeholder assets.
  if (/pixel|spacer|blank|transparent|default_album|default_cover/i.test(trimmed)) {
    return false;
  }
  return true;
}

function firstImgSrc(selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    try {
      const img = document.querySelector<HTMLImageElement>(selector);
      const src = img?.currentSrc || img?.src || '';
      if (src && isUsableCoverUrl(src)) return src;
    } catch {
      // ignore invalid selectors
    }
  }
  return null;
}

function fromMediaSession(): string | null {
  try {
    const meta = navigator.mediaSession?.metadata;
    const art = meta?.artwork;
    if (!art || art.length === 0) return null;
    // Prefer larger artwork entries when sizes are advertised.
    const sorted = [...art].sort((a, b) => {
      const sizeOf = (entry: MediaImage): number => {
        const sizes = entry.sizes?.trim() ?? '';
        const match = /^(\d+)x(\d+)$/i.exec(sizes);
        if (!match) return 0;
        return Number(match[1]) * Number(match[2]);
      };
      return sizeOf(b) - sizeOf(a);
    });
    for (const entry of sorted) {
      if (entry.src && isUsableCoverUrl(entry.src)) return entry.src;
    }
  } catch {
    // ignore
  }
  return null;
}

function fromNeteaseDom(): string | null {
  return firstImgSrc([
    '#g_player .head img',
    '.m-playbar .head img',
    '.m-player .head img',
    '[class*="playbar"] .head img',
  ]);
}

function fromQqDom(): string | null {
  return firstImgSrc([
    '#player .song_info__pic',
    '#player img.song_info__pic',
    '.player_music__pic img',
    '.mod_player img',
    '#player img[src*="y.gtimg.cn"]',
    '#player img[src*="y.qq.com"]',
  ]);
}

function fromAppleMusicDom(): string | null {
  return firstImgSrc([
    'amp-chrome-player img',
    '.lcd-meta img',
    '[data-testid="lcd-artwork"] img',
    'picture.media-artwork img',
    '.media-artwork-v2 img',
    'img[src*="mzstatic.com"]',
  ]);
}

function fromAppleMusicKit(): string | null {
  try {
    const mk = (window as unknown as {
      MusicKit?: { getInstance?: () => {
        nowPlayingItem?: {
          attributes?: {
            artwork?: { url?: string };
          };
        } | null;
      } };
    }).MusicKit?.getInstance?.();
    const template = mk?.nowPlayingItem?.attributes?.artwork?.url?.trim() ?? '';
    if (!template) return null;
    const url = template
      .replace(/\{w\}/gi, '512')
      .replace(/\{h\}/gi, '512')
      .replace(/\{f\}/gi, 'jpg');
    return isUsableCoverUrl(url) ? url : null;
  } catch {
    return null;
  }
}

function upgradeToHttps(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return url.replace(/^http:/, 'https:');
  return url;
}

export function readCurrentCoverUrl(
  platform: 'netease' | 'qqmusic' | 'applemusic' | 'youtube' | 'bilibili' | 'unknown',
): string | null {
  let url = fromMediaSession();

  if (!url) {
    if (platform === 'applemusic') {
      url = fromAppleMusicKit() ?? fromAppleMusicDom();
    } else if (platform === 'netease') {
      url = fromNeteaseDom();
    } else if (platform === 'qqmusic') {
      url = fromQqDom();
    } else if (platform === 'youtube') {
      url = firstImgSrc([
        'ytd-video-primary-info-renderer img',
        '#movie_player .ytp-cued-thumbnail-overlay-image',
      ]);
    } else if (platform === 'bilibili') {
      // Media Session (checked above) covers most cases; og:image is the
      // stable document-level fallback for video and bangumi pages.
      const og = document
        .querySelector('meta[property="og:image"]')
        ?.getAttribute('content');
      if (og) {
        url = og;
      }
    } else {
      url = fromNeteaseDom() ?? fromQqDom() ?? fromAppleMusicDom();
    }
  }

  const httpsUrl = upgradeToHttps(url);
  return httpsUrl && isUsableCoverUrl(httpsUrl) ? httpsUrl : null;
}
