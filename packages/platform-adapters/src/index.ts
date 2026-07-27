export type {
  AdapterClock,
  DocumentPort,
  PageClockPort,
  PageClockSample,
  RawSignalAdapter,
  RawSignalListener,
} from './types.js';
export {
  createRawSignalAdapter,
  detectPlatform,
  type SupportedPlatform,
} from './detect.js';
export {
  isLikelyYouTubeAdvertisement,
  parseYouTubeRoute,
  type YouTubeRoute,
} from './youtube/route.js';
export {
  YouTubeRawSignalAdapter,
  type YouTubeRawSignalAdapterOptions,
} from './youtube/youtube-raw-signal-adapter.js';
export {
  isBilibiliHost,
  parseBilibiliRoute,
  readBilibiliPageNumber,
  resolveBilibiliEpisodeId,
  type BilibiliRoute,
} from './bilibili/route.js';
export {
  BilibiliRawSignalAdapter,
  type BilibiliRawSignalAdapterOptions,
} from './bilibili/bilibili-raw-signal-adapter.js';
export {
  cleanBilibiliTitle,
  readMediaTitleInfo,
  type MediaTitleInfo,
} from './media-title/read-media-title.js';
export {
  extractQqSongMid,
  findQqSongMidFromDocument,
  isQqPlayerPage,
  isQqMusicHost,
} from './qqmusic/route.js';
export {
  QqMusicRawSignalAdapter,
  type QqMusicRawSignalAdapterOptions,
} from './qqmusic/qqmusic-raw-signal-adapter.js';
export {
  extractNeteaseSongId,
  findNeteaseSongIdFromDocument,
  isNeteaseHost,
} from './netease/route.js';
export {
  NeteaseRawSignalAdapter,
  type NeteaseRawSignalAdapterOptions,
} from './netease/netease-raw-signal-adapter.js';
export {
  extractAppleMusicCatalogId,
  findAppleMusicCatalogIdFromDocument,
  getAppleMusicCatalogIdFromItem,
  isAppleMusicCatalogId,
  isAppleMusicHost,
  isAppleMusicMediaId,
} from './applemusic/route.js';
export {
  AppleMusicRawSignalAdapter,
  type AppleMusicRawSignalAdapterOptions,
} from './applemusic/apple-music-raw-signal-adapter.js';
export {
  loadPlatformLyricText,
  parseMediaId,
} from './lyrics/load-platform-lyrics.js';
export {
  loadNeteaseLyricText,
  stripNeteaseNonLyricLines,
  type NeteaseLyricApiResponse,
} from './lyrics/netease-lyric-source.js';
export {
  loadQqMusicLyricText,
  QQ_LYRIC_ENDPOINT,
  QQ_TRACK_ENDPOINT,
} from './lyrics/qqmusic-lyric-source.js';
export type {
  LyricLoadRequest,
  LyricLoadResult,
  LyricTrackMeta,
  PortableLyricFormat,
  PortableLyricText,
} from './lyrics/types.js';
