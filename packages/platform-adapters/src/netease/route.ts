import type { DocumentPort, ElementPort, MediaElementPort } from '../types.js';

export function isNeteaseHost(href: string): boolean {
  try {
    const host = new URL(href).hostname.replace(/^www\./, '');
    return host === 'music.163.com' || host.endsWith('.music.163.com');
  } catch {
    return false;
  }
}

export function extractNeteaseSongId(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    // Hash routes: https://music.163.com/#/song?id=123
    const hashIdx = value.indexOf('#');
    if (hashIdx >= 0) {
      const hash = value.slice(hashIdx + 1);
      const hashMatch = hash.match(/[?&]?id=(\d{1,18})(?:[&#]|$)/)
        ?? hash.match(/\/song\?id=(\d{1,18})/);
      if (hashMatch?.[1]) return hashMatch[1];
    }
    const url = new URL(value, 'https://music.163.com');
    const id = url.searchParams.get('id');
    if (id && /^\d{1,18}$/.test(id)) return id;
  } catch {
    // fall through
  }
  const match = value.match(/[?&]id=(\d{1,18})(?:[&#]|$)/);
  return match?.[1] ?? null;
}

export function findNeteaseSongIdFromDocument(document: DocumentPort): string | null {
  const selectors = [
    '#g_player .words a[href*="/song?id="]',
    '#g_player .words a[href*="song?id="]',
    '.m-playbar .words a[href*="/song?id="]',
    '.m-playbar .words a[href*="song?id="]',
    '.m-player .words a[href*="/song?id="]',
    'a.f-thide[href*="song?id="]',
    'a[href*="/song?id="]',
    'a[href*="song?id="]',
  ];
  for (const selector of selectors) {
    const link = document.querySelector(selector);
    if (!link) continue;
    const id = extractNeteaseSongId(link.getAttribute('href'));
    if (id) return id;
  }
  // Hash routes: music.163.com/#/song?id=123
  const hash = typeof document.location.href === 'string'
    ? document.location.href
    : '';
  return extractNeteaseSongId(hash)
    ?? extractNeteaseSongId(document.location.search);
}

export function pickTrustedAudio(
  elements: Iterable<MediaElementPort | ElementPort>,
): MediaElementPort | null {
  const list = [...elements].filter(isMediaElement).filter((audio) =>
    audio.isConnected && Boolean(audio.currentSrc || audio.src || audio.getAttribute('src'))
  );
  const playing = list.find((audio) => !audio.paused && !audio.ended);
  return playing ?? list[0] ?? null;
}

function isMediaElement(value: MediaElementPort | ElementPort): value is MediaElementPort {
  return typeof (value as MediaElementPort).currentTime === 'number'
    && typeof (value as MediaElementPort).paused === 'boolean';
}
