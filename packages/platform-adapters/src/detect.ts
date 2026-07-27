import type { DocumentPort, PageClockPort, RawSignalAdapter } from './types.js';
import { isAppleMusicHost } from './applemusic/route.js';
import { AppleMusicRawSignalAdapter } from './applemusic/apple-music-raw-signal-adapter.js';
import { isNeteaseHost } from './netease/route.js';
import { NeteaseRawSignalAdapter } from './netease/netease-raw-signal-adapter.js';
import { isQqMusicHost } from './qqmusic/route.js';
import { QqMusicRawSignalAdapter } from './qqmusic/qqmusic-raw-signal-adapter.js';
import { parseYouTubeRoute } from './youtube/route.js';
import { YouTubeRawSignalAdapter } from './youtube/youtube-raw-signal-adapter.js';
import { isBilibiliHost } from './bilibili/route.js';
import { BilibiliRawSignalAdapter } from './bilibili/bilibili-raw-signal-adapter.js';
import type { AdapterClock } from './types.js';

export type SupportedPlatform =
  | 'youtube'
  | 'bilibili'
  | 'qqmusic'
  | 'netease'
  | 'applemusic'
  | 'unknown';

export function detectPlatform(href: string): SupportedPlatform {
  if (parseYouTubeRoute(href) || /youtube\.com|youtu\.be|music\.youtube\.com/i.test(href)) {
    return 'youtube';
  }
  if (isBilibiliHost(href)) return 'bilibili';
  if (isQqMusicHost(href)) return 'qqmusic';
  if (isNeteaseHost(href)) return 'netease';
  if (isAppleMusicHost(href)) return 'applemusic';
  return 'unknown';
}

export function createRawSignalAdapter(options: {
  readonly document: DocumentPort;
  readonly clock: AdapterClock;
  readonly platform?: SupportedPlatform;
  readonly pollIntervalMs?: number;
  readonly pageClock?: PageClockPort | null;
}): RawSignalAdapter | null {
  const platform = options.platform ?? detectPlatform(options.document.location.href);
  const common = {
    document: options.document,
    clock: options.clock,
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.pageClock !== undefined ? { pageClock: options.pageClock } : {}),
  };
  if (platform === 'youtube') return new YouTubeRawSignalAdapter(common);
  if (platform === 'bilibili') return new BilibiliRawSignalAdapter(common);
  if (platform === 'qqmusic') return new QqMusicRawSignalAdapter(common);
  if (platform === 'netease') return new NeteaseRawSignalAdapter(common);
  if (platform === 'applemusic') return new AppleMusicRawSignalAdapter(common);
  return null;
}
