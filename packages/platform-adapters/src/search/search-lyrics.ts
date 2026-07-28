import { searchNeteaseLyrics } from './netease-search-source.js';
import { searchQqLyrics } from './qqmusic-search-source.js';
import type { LyricSearchRequest, LyricSearchResult } from './types.js';

export async function searchPlatformLyrics(request: LyricSearchRequest): Promise<LyricSearchResult> {
  if (request.platform === 'netease') {
    return searchNeteaseLyrics(request);
  }
  if (request.platform === 'qqmusic') {
    return searchQqLyrics(request);
  }
  return { ok: false, reason: `unsupported-platform:${request.platform}` };
}