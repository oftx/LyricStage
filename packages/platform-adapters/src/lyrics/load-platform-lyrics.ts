import { loadNeteaseLyricText } from './netease-lyric-source.js';
import { loadQqMusicLyricText } from './qqmusic-lyric-source.js';
import type { LyricLoadRequest, LyricLoadResult } from './types.js';

/**
 * Load portable lyric text for supported platforms.
 * Call from extension content (page origin + host_permissions).
 */
export async function loadPlatformLyricText(
  request: LyricLoadRequest,
): Promise<LyricLoadResult> {
  if (request.platform === 'netease') {
    return loadNeteaseLyricText(request);
  }
  if (request.platform === 'qqmusic') {
    return loadQqMusicLyricText(request);
  }
  return { ok: false, reason: `unsupported-platform:${request.platform}` };
}

export function parseMediaId(
  mediaId: string,
): { platform: string; externalId: string } | null {
  // content uses `${platform}:${externalId}`
  const idx = mediaId.indexOf(':');
  if (idx <= 0 || idx === mediaId.length - 1) return null;
  return {
    platform: mediaId.slice(0, idx),
    externalId: mediaId.slice(idx + 1),
  };
}
