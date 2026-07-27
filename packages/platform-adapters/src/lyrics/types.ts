/**
 * Portable lyric text for extension-protocol lyric-document.
 * Surface parses with @lyric-stage/player parsers (lrc/yrc/qrc/plaintext).
 */
export type PortableLyricFormat = 'lrc' | 'yrc' | 'qrc' | 'ttml' | 'plaintext';

export type PortableLyricText = {
  readonly format: PortableLyricFormat;
  readonly text: string;
  readonly sourceName: string;
  /** Optional translation / pronunciation as separate timed texts (LRC-shaped). */
  readonly translationText?: string;
  readonly pronunciationText?: string;
};

export type LyricLoadRequest = {
  readonly platform: 'netease' | 'qqmusic' | 'youtube' | 'unknown' | string;
  readonly externalId: string;
  readonly signal?: AbortSignal;
  readonly origin?: string;
};

export type LyricTrackMeta = {
  readonly title: string;
  readonly artists: readonly string[];
  readonly album?: string;
  readonly durationMs?: number;
};

export type LyricLoadResult =
  | {
    readonly ok: true;
    readonly lyric: PortableLyricText;
    /** API-side track metadata when the platform provides it (QQ does). */
    readonly track?: LyricTrackMeta;
  }
  | { readonly ok: false; readonly reason: string };
