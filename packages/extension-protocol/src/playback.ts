import { isRecord } from './envelope.js';

export const SPARSE_ANCHOR_PROTOCOL_VERSION = 1 as const;

export type SparsePlaybackState = 'playing' | 'paused' | 'buffering' | 'ended';

export type SparsePlaybackAnchorV1 = {
  readonly protocolVersion: typeof SPARSE_ANCHOR_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly generation: number;
  readonly mediaId: string;
  readonly positionMs: number;
  readonly rate: number;
  readonly state: SparsePlaybackState;
  readonly producedAtMs: number;
  readonly sequence: number;
  /**
   * Track duration when the producer knows it, else null/absent. Optional so
   * pre-durationMs anchors (older content scripts) keep validating; consumers
   * clamp 'playing' extrapolation at this bound instead of coasting forever.
   */
  readonly durationMs?: number | null;
};

const REQUIRED_ANCHOR_KEYS = new Set([
  'protocolVersion',
  'sessionId',
  'generation',
  'mediaId',
  'positionMs',
  'rate',
  'state',
  'producedAtMs',
  'sequence',
]);

const OPTIONAL_ANCHOR_KEYS = new Set(['durationMs']);

export function isSparsePlaybackAnchorV1(value: unknown): value is SparsePlaybackAnchorV1 {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  // Required keys present plus an optional whitelist — mirrors the tolerant
  // lyric-document pattern so the anchor can evolve compatibly.
  if (!keys.every((key) => REQUIRED_ANCHOR_KEYS.has(key) || OPTIONAL_ANCHOR_KEYS.has(key))) {
    return false;
  }
  for (const key of REQUIRED_ANCHOR_KEYS) {
    if (!keys.includes(key)) return false;
  }
  if (Object.hasOwn(value, 'durationMs')) {
    const durationMs = (value as { durationMs?: unknown }).durationMs;
    if (
      durationMs !== null
      && (
        typeof durationMs !== 'number'
        || !Number.isFinite(durationMs)
        || durationMs <= 0
      )
    ) {
      return false;
    }
  }
  return value.protocolVersion === SPARSE_ANCHOR_PROTOCOL_VERSION
    && typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && typeof value.generation === 'number'
    && Number.isSafeInteger(value.generation)
    && value.generation > 0
    && typeof value.mediaId === 'string'
    && value.mediaId.length > 0
    && typeof value.positionMs === 'number'
    && Number.isFinite(value.positionMs)
    && value.positionMs >= 0
    && typeof value.rate === 'number'
    && Number.isFinite(value.rate)
    && (
      value.state === 'playing'
      || value.state === 'paused'
      || value.state === 'buffering'
      || value.state === 'ended'
    )
    && typeof value.producedAtMs === 'number'
    && Number.isFinite(value.producedAtMs)
    && typeof value.sequence === 'number'
    && Number.isSafeInteger(value.sequence)
    && value.sequence > 0;
}

/** Portable lyric payload — surface parses with player-core parsers. */
export type LyricDocumentFormatV1 = 'lrc' | 'plaintext' | 'ttml' | 'yrc' | 'qrc';

export type LyricDocumentPayloadV1 = {
  readonly mediaId: string;
  readonly format: LyricDocumentFormatV1;
  readonly text: string;
  readonly sourceName: string;
  /** Monotonic per content session; surfaces ignore stale docs. */
  readonly revision: number;
  /**
   * Optional timed translation body (usually LRC-shaped), independent of
   * primary format. Surface merges by line begin time.
   */
  readonly translationText?: string;
  /**
   * Optional timed pronunciation / romaji body (usually LRC-shaped).
   * Surface merges onto primary lines as foregroundPronunciation.
   */
  readonly pronunciationText?: string;
  /** Optional album art URL for the lyric window cover background. */
  readonly coverUrl?: string;
};

/** Lightweight media metadata (cover etc.) without re-sending lyrics. */
export type MediaMetaPayloadV1 = {
  readonly mediaId: string;
  readonly coverUrl: string | null;
  /** Page-derived display title; optional so old producers stay valid. */
  readonly title?: string;
  /** Page-derived creators (uploader/artists); optional like title. */
  readonly creators?: readonly string[];
};

const MAX_MEDIA_TITLE_CHARS = 512;
const MAX_MEDIA_CREATORS = 8;

export type PlaybackChannelPayload =
  | { readonly kind: 'sparse-anchor'; readonly anchor: SparsePlaybackAnchorV1 }
  | {
    readonly kind: 'session-snapshot';
    readonly anchor: SparsePlaybackAnchorV1 | null;
    readonly lyricDocument?: LyricDocumentPayloadV1 | null;
  }
  | {
    readonly kind: 'lyric-document';
    readonly document: LyricDocumentPayloadV1;
  }
  | {
    /**
     * Definitive "this media has no lyrics" (instrumental track, failed
     * fetch, no library match). Without it the surface keeps rendering the
     * previous track's document against the new clock — no message could
     * ever clear it. A new payload KIND (not a new required field): old
     * receivers drop unknown kinds, so this stays forward-compatible.
     */
    readonly kind: 'lyric-clear';
    readonly mediaId: string;
  }
  | {
    readonly kind: 'media-meta';
    readonly meta: MediaMetaPayloadV1;
  }
  | {
    readonly kind: 'seek-intent';
    readonly surfaceId: string;
    readonly targetMs: number;
  }
  | {
    readonly kind: 'seek-outcome';
    readonly surfaceId: string;
    readonly outcome: 'accepted' | 'confirmed' | 'rejected' | 'timedOut' | 'superseded';
    readonly positionMs: number | null;
  };

const LYRIC_FORMATS = new Set<LyricDocumentFormatV1>([
  'lrc',
  'plaintext',
  'ttml',
  'yrc',
  'qrc',
]);
const MAX_LYRIC_TEXT_CHARS = 512_000;

function isOptionalTimedText(value: unknown): boolean {
  return value === undefined
    || (
      typeof value === 'string'
      && value.length > 0
      && value.length <= MAX_LYRIC_TEXT_CHARS
    );
}

const MAX_COVER_URL_CHARS = 2_048;

function isOptionalCoverUrl(value: unknown): boolean {
  return value === undefined
    || (
      typeof value === 'string'
      && value.length > 0
      && value.length <= MAX_COVER_URL_CHARS
      && (
        value.startsWith('https://')
        || value.startsWith('http://')
        || value.startsWith('data:image/')
        || value.startsWith('blob:')
      )
    );
}

function normalizeLyricDocumentPayload(
  value: LyricDocumentPayloadV1,
): LyricDocumentPayloadV1 {
  return Object.freeze({
    mediaId: value.mediaId,
    format: value.format,
    text: value.text,
    sourceName: value.sourceName,
    revision: value.revision,
    ...(typeof value.translationText === 'string'
      ? { translationText: value.translationText }
      : {}),
    ...(typeof value.pronunciationText === 'string'
      ? { pronunciationText: value.pronunciationText }
      : {}),
    ...(typeof value.coverUrl === 'string'
      ? { coverUrl: value.coverUrl }
      : {}),
  });
}

export function isMediaMetaPayloadV1(value: unknown): value is MediaMetaPayloadV1 {
  if (!isRecord(value)) return false;
  if (
    typeof value.mediaId !== 'string'
    || value.mediaId.length === 0
    || value.mediaId.length > 256
  ) {
    return false;
  }
  if (Object.hasOwn(value, 'title')) {
    const title = (value as { title?: unknown }).title;
    if (
      typeof title !== 'string'
      || title.length === 0
      || title.length > MAX_MEDIA_TITLE_CHARS
    ) {
      return false;
    }
  }
  if (Object.hasOwn(value, 'creators')) {
    const creators = (value as { creators?: unknown }).creators;
    if (
      !Array.isArray(creators)
      || creators.length > MAX_MEDIA_CREATORS
      || !creators.every((entry) => (
        typeof entry === 'string'
        && entry.length > 0
        && entry.length <= MAX_MEDIA_TITLE_CHARS
      ))
    ) {
      return false;
    }
  }
  if (value.coverUrl === null) return true;
  return typeof value.coverUrl === 'string'
    && value.coverUrl.length > 0
    && value.coverUrl.length <= MAX_COVER_URL_CHARS
    && (
      value.coverUrl.startsWith('https://')
      || value.coverUrl.startsWith('http://')
      || value.coverUrl.startsWith('data:image/')
      || value.coverUrl.startsWith('blob:')
    );
}

export function isLyricDocumentPayloadV1(value: unknown): value is LyricDocumentPayloadV1 {
  if (!isRecord(value)) return false;
  if (!(
    typeof value.mediaId === 'string'
    && value.mediaId.length > 0
    && value.mediaId.length <= 256
    && typeof value.format === 'string'
    && LYRIC_FORMATS.has(value.format as LyricDocumentFormatV1)
    && typeof value.text === 'string'
    && value.text.length > 0
    && value.text.length <= MAX_LYRIC_TEXT_CHARS
    && typeof value.sourceName === 'string'
    && value.sourceName.length > 0
    && value.sourceName.length <= 256
    && typeof value.revision === 'number'
    && Number.isSafeInteger(value.revision)
    && value.revision > 0
  )) {
    return false;
  }
  if (Object.hasOwn(value, 'translationText') && !isOptionalTimedText(value.translationText)) {
    return false;
  }
  if (
    Object.hasOwn(value, 'pronunciationText')
    && !isOptionalTimedText(value.pronunciationText)
  ) {
    return false;
  }
  if (Object.hasOwn(value, 'coverUrl') && !isOptionalCoverUrl(value.coverUrl)) {
    return false;
  }
  return true;
}

export function parsePlaybackPayload(value: unknown): PlaybackChannelPayload | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'sparse-anchor') {
    if (!isSparsePlaybackAnchorV1(value.anchor)) return null;
    return { kind: 'sparse-anchor', anchor: value.anchor };
  }
  if (value.kind === 'session-snapshot') {
    if (value.anchor !== null && !isSparsePlaybackAnchorV1(value.anchor)) return null;
    let lyricDocument: LyricDocumentPayloadV1 | null | undefined;
    if (Object.hasOwn(value, 'lyricDocument')) {
      if (value.lyricDocument === null) {
        lyricDocument = null;
      } else if (isLyricDocumentPayloadV1(value.lyricDocument)) {
        lyricDocument = normalizeLyricDocumentPayload(value.lyricDocument);
      } else {
        return null;
      }
    }
    return {
      kind: 'session-snapshot',
      anchor: value.anchor as SparsePlaybackAnchorV1 | null,
      ...(lyricDocument !== undefined ? { lyricDocument } : {}),
    };
  }
  if (value.kind === 'lyric-document') {
    if (!isLyricDocumentPayloadV1(value.document)) return null;
    return {
      kind: 'lyric-document',
      document: normalizeLyricDocumentPayload(value.document),
    };
  }
  if (value.kind === 'lyric-clear') {
    if (typeof value.mediaId !== 'string' || value.mediaId.length === 0) return null;
    if (value.mediaId.length > 512) return null;
    return { kind: 'lyric-clear', mediaId: value.mediaId };
  }
  if (value.kind === 'media-meta') {
    if (!isMediaMetaPayloadV1(value.meta)) return null;
    const meta = value.meta;
    return {
      kind: 'media-meta',
      meta: Object.freeze({
        mediaId: meta.mediaId,
        coverUrl: meta.coverUrl,
        ...(meta.title !== undefined ? { title: meta.title } : {}),
        ...(meta.creators !== undefined
          ? { creators: Object.freeze([...meta.creators]) }
          : {}),
      }),
    };
  }
  if (value.kind === 'seek-intent') {
    if (typeof value.surfaceId !== 'string' || typeof value.targetMs !== 'number') return null;
    if (value.surfaceId.length === 0 || value.surfaceId.length > 128) return null;
    if (!Number.isFinite(value.targetMs) || value.targetMs < 0) return null;
    return {
      kind: 'seek-intent',
      surfaceId: value.surfaceId,
      targetMs: value.targetMs,
    };
  }
  if (value.kind === 'seek-outcome') {
    if (typeof value.surfaceId !== 'string') return null;
    if (
      value.outcome !== 'accepted'
      && value.outcome !== 'confirmed'
      && value.outcome !== 'rejected'
      && value.outcome !== 'timedOut'
      && value.outcome !== 'superseded'
    ) return null;
    if (value.positionMs !== null && typeof value.positionMs !== 'number') return null;
    return {
      kind: 'seek-outcome',
      surfaceId: value.surfaceId,
      outcome: value.outcome,
      positionMs: value.positionMs as number | null,
    };
  }
  return null;
}
