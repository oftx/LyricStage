import {
  createMessageEnvelopeV1,
  parseMessageEnvelopeV1,
  parsePlaybackPayload,
  type SparsePlaybackAnchorV1,
  type SparsePlaybackState,
} from '@lyric-stage/extension-protocol';
import {
  RawPlaybackSignalRecorder,
  RawSignalDiagnosticSampler,
  type RawPlaybackEventKind,
} from '@lyric-stage/diagnostics';
import {
  SourceArbiter,
  StablePlaybackTimeline,
  type RawPlaybackSignal,
} from '@lyric-stage/playback-core';
import {
  createRawSignalAdapter,
  detectPlatform,
  extractAppleMusicCatalogId,
  findAppleMusicCatalogIdFromDocument,
  loadPlatformLyricText,
  parseMediaId,
  readMediaTitleInfo,
  type PortableLyricText,
} from '@lyric-stage/platform-adapters';
import { createPageClockClient } from './page-clock-client.js';
import { loadAppleMusicLyricText } from './musickit-lyrics-client.js';
import { LyricRefreshController } from './lyric-refresh.js';
import { createFloatingLyricPanel } from './floating-panel.js';
import {
  chromeLyricStorage,
  ExtensionLyricLibrary,
} from '../library/extension-lyric-library.js';
import { resolveLibraryLyric } from '../library/resolve-library-lyric.js';
import { readCurrentCoverUrl } from './cover-url.js';
import { seekPlatformTo } from './platform-seek.js';
import type { LyricDocumentPayloadV1 } from '@lyric-stage/extension-protocol';

declare global {
  interface Window {
    __lyricStageContentRuntime?: {
      readonly ownerId: string;
      readonly sessionId: string;
      ensureConnected: () => boolean;
      isAlive: () => boolean;
    };
  }
}

const ownerId = `content:${crypto.randomUUID()}`;
const now = () => performance.now();
const sessionId = `session:${crypto.randomUUID()}`;
let generation = 1;
let mediaId = 'media:unbound';
let port: chrome.runtime.Port | null = null;
let sessionStarted = false;
let lastAnchorSequence = 0;
/** Last non-provisional position published to the surface. */
let lastPublishedPositionMs = 0;
let lastPublishedState: SparsePlaybackState = 'paused';
/** Coalesce sparse-anchor publishes — free-run on surface does not need 4–5 Hz. */
const ANCHOR_PUBLISH_PLAYING_MS = 400;
const ANCHOR_PUBLISH_PAUSED_MS = 1_200;
const ANCHOR_PUBLISH_HIDDEN_MS = 2_500;
let lastSparsePublishAtMs = 0;
let lastSparsePublishKey = '';
let pendingSparsePublishTimer: ReturnType<typeof setTimeout> | null = null;
/** Apple Music: require 2 hits before leaving a stable numeric catalog id. */
let pendingAppleMediaId: string | null = null;
let pendingAppleMediaHits = 0;
/** Apple Music warm-up / lyric retry interval handle. */
let appleWarmupTimer: number | null = null;
/** Last published cover art URL (dedupe media-meta). */
let lastPublishedCoverUrl: string | null = null;
let coverPollTimer: number | null = null;
const platform = detectPlatform(window.location.href);
/**
 * executeScript re-injection after extension reload can stack multiple content
 * scripts in one tab. Only the first owner may open a worker port / publish.
 */
const existingOwner = window.__lyricStageContentRuntime;
const isDuplicateInject = Boolean(existingOwner?.isAlive?.());
if (isDuplicateInject && existingOwner) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      typeof message === 'object'
      && message !== null
      && (message as { kind?: string }).kind === 'lyric-stage-ensure-connected'
    ) {
      const ok = existingOwner.ensureConnected();
      sendResponse({
        ok,
        sessionId: existingOwner.sessionId,
        delegated: true,
        ownerId: existingOwner.ownerId,
      });
      return true;
    }
    return false;
  });
}

/** Primary inject owns the port; duplicate injects only delegate ensure-connected. */
const runtimeActive = !isDuplicateInject;

const diagnosticRecorder = new RawPlaybackSignalRecorder(platform, { now });
// 250ms heartbeat matches the adapter poll so 1000ms-stepping platform clocks
// (NetEase platform-api) don't alias against the recording cadence; position
// jumps still record immediately regardless of heartbeat.
const diagnosticSampler = new RawSignalDiagnosticSampler(diagnosticRecorder, {
  heartbeatMs: 250,
});

const arbiter = new SourceArbiter();
const timeline = new StablePlaybackTimeline();

/** When true, page is unloading — do not reconnect to the worker. */
let pageUnloading = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 8_000;

function clearReconnectTimer(): void {
  if (reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(): void {
  if (!runtimeActive || pageUnloading || port) return;
  clearReconnectTimer();
  const delay = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * (2 ** Math.min(reconnectAttempt, 5)),
  );
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureConnected();
  }, delay);
}

/**
 * MV3 service workers sleep and extension reloads drop content ports.
 * Reconnect aggressively so the popup source list and lyric window stay live
 * without requiring a full music-tab refresh after every worker cycle.
 */
function ensureConnected(): boolean {
  if (!runtimeActive || pageUnloading) return false;
  if (port) {
    try {
      // Touch the port; a dead handle throws on post.
      postHello();
      // A wake ping usually means a surface just opened; it missed earlier
      // media-meta (not part of the session snapshot), so republish once.
      refreshCoverMetaForced();
      return true;
    } catch {
      port = null;
    }
  }
  try {
    port = chrome.runtime.connect({ name: 'content-runtime' });
  } catch {
    port = null;
    scheduleReconnect();
    return false;
  }
  reconnectAttempt = 0;
  clearReconnectTimer();
  port.onDisconnect.addListener(() => {
    port = null;
    if (!pageUnloading) scheduleReconnect();
  });
  port.onMessage.addListener((message: unknown) => {
    handleWorkerMessage(message);
  });
  postHello();
  void refreshAndPublishLyrics(true);
  // Push a timeline sample soon so the worker has an anchor for this session.
  window.setTimeout(() => {
    try {
      publishSnapshot();
    } catch {
      // ignore while warming up
    }
  }, 50);
  return true;
}

function connect(): void {
  if (!runtimeActive) return;
  ensureConnected();
}

function isProvisionalMediaId(id: string): boolean {
  return id === 'media:unbound'
    || id.endsWith(':unbound')
    || id === 'media:unknown'
    || id === 'applemusic:listening'
    || id === 'applemusic:unknown';
}

function isNumericAppleCatalogMediaId(id: string): boolean {
  return /^applemusic:\d{1,20}$/.test(id);
}

/**
 * Bind media identity and advertise to the worker so the popup source list
 * can show this tab. Provisional ids (e.g. applemusic:listening) are allowed
 * so Apple Music appears before MusicKit exposes a catalog id.
 *
 * Apple Music after track 1 often flaps catalog id ↔ library id (or previous
 * song). That does not always re-fetch lyrics, but it still thrashes anchors
 * and makes karaoke feel like a seek every few hundred ms.
 */
function applyMediaIdentity(nextMediaId: string): void {
  if (!runtimeActive || !nextMediaId) return;
  if (nextMediaId === mediaId) return;
  // Never downgrade a real catalog id to a provisional placeholder.
  if (
    mediaId.startsWith('applemusic:')
    && !isProvisionalMediaId(mediaId)
    && isProvisionalMediaId(nextMediaId)
  ) {
    return;
  }
  // Prefer sticky numeric catalog id over library-style ids for the same play.
  // Example thrash: applemusic:1118757877 ↔ applemusic:i.xxxxx
  if (
    platform === 'applemusic'
    && isNumericAppleCatalogMediaId(mediaId)
    && nextMediaId.startsWith('applemusic:')
    && !isProvisionalMediaId(nextMediaId)
    && !isNumericAppleCatalogMediaId(nextMediaId)
  ) {
    return;
  }
  // Require a second consecutive observation before leaving a stable catalog id
  // for a different catalog id (filters one-sample network/DOM ghosts).
  if (
    platform === 'applemusic'
    && isNumericAppleCatalogMediaId(mediaId)
    && isNumericAppleCatalogMediaId(nextMediaId)
  ) {
    if (pendingAppleMediaId !== nextMediaId) {
      pendingAppleMediaId = nextMediaId;
      pendingAppleMediaHits = 1;
      return;
    }
    pendingAppleMediaHits += 1;
    if (pendingAppleMediaHits < 2) return;
  } else {
    pendingAppleMediaId = null;
    pendingAppleMediaHits = 0;
  }

  mediaId = nextMediaId;
  pendingAppleMediaId = null;
  pendingAppleMediaHits = 0;
  generation += 1;
  sessionStarted = false;
  lyricRefresh.resetBinding();
  seekSuppressTargetMs = null;
  lastPublishedCoverUrl = null;
  // Always clear held progress on media change — otherwise next track can
  // inherit a high watermark and publish stale/leading positions.
  lastPublishedPositionMs = 0;
  lastPublishedState = 'paused';
  postHello();
  refreshCoverMeta();
  // Apple Music may stay on applemusic:listening until MAIN resolves the
  // nowPlaying catalog id — still attempt lyric fetch with catalogId "current".
  if (!isProvisionalMediaId(mediaId) || platform === 'applemusic') {
    void refreshAndPublishLyrics(true);
  }
}

function isAppleMediaExternalId(value: string | null | undefined): value is string {
  return typeof value === 'string'
    && /^[a-zA-Z0-9._-]{1,64}$/.test(value)
    && value !== 'listening'
    && value !== 'unknown';
}

/** Early / periodic identity seed for Apple Music SPA (URL often has no song id). */
function seedAppleMusicPresence(): void {
  if (platform !== 'applemusic' || !runtimeActive) return;
  // Prefer MusicKit nowPlaying (via page-clock) only. After song 1, URL/DOM
  // often point at a different catalog id and caused media thrash.
  const clockHint = pageClock.getLatestSample?.()?.mediaExternalIdHint ?? null;
  const fromClock = isAppleMediaExternalId(clockHint) ? clockHint : null;
  if (fromClock) {
    applyMediaIdentity(`applemusic:${fromClock}`);
    return;
  }
  // Cold start only: allow URL/LCD when we still have no real id.
  if (isProvisionalMediaId(mediaId) || mediaId === 'media:unbound') {
    const fromDoc = findAppleMusicCatalogIdFromDocument(documentPort);
    const fromHref = extractAppleMusicCatalogId(window.location.href);
    const catalogId = fromDoc ?? fromHref;
    if (catalogId) {
      applyMediaIdentity(`applemusic:${catalogId}`);
      return;
    }
  }
  if (mediaId === 'media:unbound') {
    applyMediaIdentity('applemusic:listening');
  } else {
    // Keep provisional hello alive after SW reconnect.
    postHello();
  }
}

function postHello(): void {
  if (!runtimeActive || !port) return;
  // Do not advertise unbound placeholders — they become ghost popup sources.
  // applemusic:listening is intentional so the tab appears before catalog id.
  if (
    mediaId === 'media:unbound'
    || mediaId === 'media:unknown'
    || mediaId.endsWith(':unbound')
  ) {
    return;
  }
  try {
    port.postMessage(createMessageEnvelopeV1({
      channel: 'session',
      type: 'source-hello',
      messageId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      sessionId,
      generation,
      payload: {
        kind: 'source-hello',
        sessionId,
        generation,
        mediaId,
      },
    }));
  } catch {
    port = null;
    scheduleReconnect();
  }
}

function postGoodbye(reason: string): void {
  if (!port) return;
  try {
    port.postMessage(createMessageEnvelopeV1({
      channel: 'session',
      type: 'source-goodbye',
      messageId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      sessionId,
      generation,
      payload: {
        kind: 'source-goodbye',
        sessionId,
        generation,
        reason,
      },
    }));
  } catch {
    port = null;
  }
}

function mapState(state: string): SparsePlaybackState {
  if (state === 'playing') return 'playing';
  if (state === 'ended') return 'ended';
  if (state === 'buffering') return 'buffering';
  return 'paused';
}

/**
 * Post-seek suppression (fixes the "target → bounce back → target" triple
 * jump). Platform seeks are async: after seek() the 250ms pollers keep
 * observing the PRE-seek position for a few beats. Publishing those samples
 * verbatim makes the surface clock hard-seek BACK to the old position (its
 * backward threshold is 1.5s), killing the optimistic click-seek scroll,
 * before the real post-seek sample jumps it forward again. While armed,
 * non-forced anchors are dropped until a sample lands near the target or the
 * window expires (platform silently dropped the seek).
 */
let seekSuppressUntilMs = 0;
let seekSuppressTargetMs: number | null = null;
/** ~ page-clock poll (250) + adapter poll (250) + publish budget margin. */
const SEEK_SUPPRESS_MAX_MS = 900;
const SEEK_SETTLE_TOLERANCE_MS = 400;

function seekSuppressionActive(positionMs: number): boolean {
  if (seekSuppressTargetMs === null) return false;
  if (now() >= seekSuppressUntilMs) {
    seekSuppressTargetMs = null;
    return false;
  }
  if (Math.abs(positionMs - seekSuppressTargetMs) <= SEEK_SETTLE_TOLERANCE_MS) {
    // Platform seek confirmed — disarm and let this sample through.
    seekSuppressTargetMs = null;
    return false;
  }
  return true;
}

function publishLyricClear(forMediaId: string): void {
  if (!port) return;
  try {
    port.postMessage(createMessageEnvelopeV1({
      channel: 'playback',
      type: 'lyric-clear',
      messageId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      sessionId,
      generation,
      payload: { kind: 'lyric-clear', mediaId: forMediaId },
    }));
  } catch {
    port = null;
  }
}

function publishLyricPayload(documentPayload: LyricDocumentPayloadV1): void {
  if (!port) return;
  try {
    port.postMessage(createMessageEnvelopeV1({
      channel: 'playback',
      type: 'lyric-document',
      messageId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      sessionId,
      generation,
      payload: { kind: 'lyric-document', document: documentPayload },
    }));
  } catch {
    port = null;
  }
}

function portableToPayload(
  media: string,
  revision: number,
  lyric: PortableLyricText,
): LyricDocumentPayloadV1 {
  const format = lyric.format === 'plaintext'
    ? 'plaintext' as const
    : lyric.format === 'ttml'
      ? 'ttml' as const
      : lyric.format === 'yrc'
        ? 'yrc' as const
        : lyric.format === 'qrc'
          ? 'qrc' as const
          : 'lrc' as const;
  const coverUrl = readCurrentCoverUrl(
    platform === 'netease' || platform === 'qqmusic' || platform === 'applemusic' || platform === 'youtube' || platform === 'bilibili'
      ? platform
      : 'unknown',
  );
  if (coverUrl) lastPublishedCoverUrl = coverUrl;
  return {
    mediaId: media,
    format,
    text: lyric.text,
    sourceName: lyric.sourceName,
    revision,
    ...(lyric.translationText?.trim()
      ? { translationText: lyric.translationText }
      : {}),
    ...(lyric.pronunciationText?.trim()
      ? { pronunciationText: lyric.pronunciationText }
      : {}),
    ...(coverUrl ? { coverUrl } : {}),
  };
}

let lastPublishedTitleKey = '';

function publishMediaMeta(coverUrl: string | null, force = false): void {
  if (!runtimeActive || !port) return;
  if (mediaId === 'media:unbound' || mediaId.endsWith(':unbound')) return;
  const titleInfo = readMediaTitleInfo(platform, document);
  const titleKey = `${titleInfo.title ?? ''}\u0000${titleInfo.creators.join('\u0000')}`;
  if (!force && coverUrl === lastPublishedCoverUrl && titleKey === lastPublishedTitleKey) {
    return;
  }
  lastPublishedCoverUrl = coverUrl;
  lastPublishedTitleKey = titleKey;
  try {
    port.postMessage(createMessageEnvelopeV1({
      channel: 'playback',
      type: 'media-meta',
      messageId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      sessionId,
      generation,
      payload: {
        kind: 'media-meta',
        meta: {
          mediaId,
          coverUrl,
          ...(titleInfo.title ? { title: titleInfo.title } : {}),
          ...(titleInfo.creators.length > 0
            ? { creators: [...titleInfo.creators] }
            : {}),
        },
      },
    }));
  } catch {
    port = null;
    scheduleReconnect();
  }
}

function refreshCoverMeta(): void {
  if (!runtimeActive || document.visibilityState === 'hidden') return;
  const cover = readCurrentCoverUrl(
    platform === 'netease' || platform === 'qqmusic' || platform === 'applemusic' || platform === 'youtube' || platform === 'bilibili'
      ? platform
      : 'unknown',
  );
  // Publish even without a cover: title/creators changes (video platforms)
  // must reach the surface for library matching and the picker header.
  publishMediaMeta(cover);
}

function refreshCoverMetaForced(): void {
  if (!runtimeActive) return;
  const cover = readCurrentCoverUrl(
    platform === 'netease' || platform === 'qqmusic' || platform === 'applemusic' || platform === 'youtube' || platform === 'bilibili'
      ? platform
      : 'unknown',
  );
  publishMediaMeta(cover, true);
}

function startCoverPolling(): void {
  if (coverPollTimer !== null) return;
  // Slow poll — cover rarely changes mid-track; media change triggers immediate refresh.
  coverPollTimer = window.setInterval(() => {
    refreshCoverMeta();
  }, 4_000);
}

const lyricLibrary = new ExtensionLyricLibrary(chromeLyricStorage());

const lyricRefresh = new LyricRefreshController({
  platform: () => platform,
  mediaId: () => mediaId,
  portOpen: () => runtimeActive && port !== null,
  parseMediaId,
  loadAppleMusicLyricText,
  loadPlatformLyricText,
  applyMediaIdentity: (next) => applyMediaIdentity(next),
  publishLyric: (media, revision, lyric) => {
    publishLyricPayload(portableToPayload(media, revision, lyric));
  },
  publishLyricClear: (media) => publishLyricClear(media),
  publishSnapshotOrHold: () => publishSnapshotOrHold(),
  lookupLibraryLyric: (forMediaId) => resolveLibraryLyric({
    library: lyricLibrary,
  }, forMediaId),
  onLyricResolved: ({ platform: sourcePlatform, externalId, lyric, track }) => {
    // Auto-collect every successfully fetched platform lyric. Titles prefer the API
    // track (QQ), then page-derived info; failures never disturb playback.
    const pageInfo = readMediaTitleInfo(platform, document);
    const title = track?.title ?? pageInfo.title ?? '';
    if (!title) return;
    void lyricLibrary.upsert({
      source: { provider: sourcePlatform, externalId },
      title,
      creators: track?.artists?.length
        ? track.artists
        : pageInfo.creators,
      ...(track?.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
      ...(lastPublishedCoverUrl ? { coverUrl: lastPublishedCoverUrl } : {}),
      format: lyric.format,
      text: lyric.text,
      ...(lyric.translationText ? { translationText: lyric.translationText } : {}),
      ...(lyric.pronunciationText ? { pronunciationText: lyric.pronunciationText } : {}),
    }).catch(() => {
      // Library persistence is best-effort; never break lyric publishing.
    });
  },
});

async function refreshAndPublishLyrics(force = false): Promise<void> {
  await lyricRefresh.refresh(force);
}

function anchorPublishBudgetMs(state: SparsePlaybackState): number {
  if (document.visibilityState === 'hidden') return ANCHOR_PUBLISH_HIDDEN_MS;
  if (state === 'playing') return ANCHOR_PUBLISH_PLAYING_MS;
  return ANCHOR_PUBLISH_PAUSED_MS;
}

function sparsePublishKey(anchor: SparsePlaybackAnchorV1): string {
  // Quantize position so free-run ticks within the same budget do not spam.
  const posBucket = Math.floor(anchor.positionMs / 250);
  return [
    anchor.mediaId,
    anchor.generation,
    anchor.state,
    posBucket,
    Math.round(anchor.rate * 100),
  ].join('|');
}

function emitSparseAnchorNow(anchor: SparsePlaybackAnchorV1): void {
  if (!runtimeActive) return;
  if (!port) {
    ensureConnected();
    if (!port) return;
  }
  try {
    port.postMessage(createMessageEnvelopeV1({
      channel: 'playback',
      type: 'sparse-anchor',
      messageId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      sessionId: anchor.sessionId,
      generation: anchor.generation,
      sequence: anchor.sequence,
      payload: { kind: 'sparse-anchor', anchor },
    }));
    lastSparsePublishAtMs = now();
    lastSparsePublishKey = sparsePublishKey(anchor);
    if (anchor.positionMs > 0 || anchor.state === 'playing') {
      // Follow the published position, never Math.max — a backward seek must
      // move the hold watermark down, or a brief timeline outage republishes
      // the stale high position and the lyrics jump forward then back.
      lastPublishedPositionMs = anchor.positionMs;
      lastPublishedState = anchor.state;
    }
  } catch {
    port = null;
    scheduleReconnect();
  }
}

function postSparseAnchor(
  anchor: SparsePlaybackAnchorV1,
  options?: { readonly force?: boolean },
): void {
  if (!runtimeActive) return;
  const force = options?.force === true;
  // The seek's own force-publish must pass; stale pre-seek echoes must not.
  if (!force && seekSuppressionActive(anchor.positionMs)) return;
  const budget = anchorPublishBudgetMs(anchor.state);
  const elapsed = now() - lastSparsePublishAtMs;
  const prevParts = lastSparsePublishKey ? lastSparsePublishKey.split('|') : null;
  const stateChanged = Boolean(prevParts && prevParts[2] !== anchor.state);
  const mediaChanged = Boolean(prevParts && prevParts[0] !== anchor.mediaId);

  if (force || stateChanged || mediaChanged || elapsed >= budget || !prevParts) {
    if (pendingSparsePublishTimer !== null) {
      clearTimeout(pendingSparsePublishTimer);
      pendingSparsePublishTimer = null;
    }
    emitSparseAnchorNow(anchor);
    return;
  }

  // Same media + state within budget: schedule a trailing publish, drop intermediate.
  if (pendingSparsePublishTimer !== null) return;
  const waitMs = Math.max(16, budget - elapsed);
  pendingSparsePublishTimer = setTimeout(() => {
    pendingSparsePublishTimer = null;
    // Re-publish latest snapshot instead of a stale queued anchor.
    publishSnapshotOrHold();
  }, waitMs);
}

/**
 * QQ's page clock pins position at durationMs while isPlay stays true, so a
 * naive anchor keeps the surface extrapolating past the track end forever.
 * Clamp position into [0, duration] and flip 'playing' to 'ended' once the
 * clamped position reaches the duration bound.
 */
function terminalAwareAnchorFields(
  positionMs: number,
  durationMs: number | null | undefined,
  state: SparsePlaybackState,
): {
  readonly positionMs: number;
  readonly state: SparsePlaybackState;
  readonly durationMs: number | null;
} {
  const duration = typeof durationMs === 'number'
    && Number.isFinite(durationMs)
    && durationMs > 0
    ? durationMs
    : null;
  let clamped = Math.max(0, positionMs);
  let nextState = state;
  if (duration !== null && clamped >= duration) {
    clamped = duration;
    if (state === 'playing' || state === 'buffering') nextState = 'ended';
  }
  return { positionMs: clamped, state: nextState, durationMs: duration };
}

function publishSnapshot(): void {
  if (!runtimeActive || !port) return;
  const snapshot = timeline.getSnapshot(now());
  if (snapshot?.available) {
    lastAnchorSequence += 1;
    const terminal = terminalAwareAnchorFields(
      snapshot.positionMs,
      snapshot.durationMs,
      mapState(snapshot.playbackState),
    );
    postSparseAnchor({
      protocolVersion: 1,
      sessionId: snapshot.sessionId || sessionId,
      generation,
      mediaId,
      positionMs: terminal.positionMs,
      rate: snapshot.rate,
      state: terminal.state,
      // Wall clock so the lyric surface can compensate transport lag.
      // performance.now() is not comparable across content ↔ surface processes.
      producedAtMs: Date.now(),
      sequence: lastAnchorSequence,
      durationMs: terminal.durationMs,
    });
  } else {
    // Do not emit a synthetic paused@0 — that locks the surface at zero.
    // Prefer page-clock direct sample when the timeline has not started yet.
    publishFromPageClockFallback();
  }
  void refreshAndPublishLyrics(false);
}

/**
 * When StablePlaybackTimeline is not available yet, publish directly from the
 * MAIN page-clock sample so NetEase is not stuck at provisional 0.
 */
function publishFromPageClockFallback(): void {
  if (!port || mediaId === 'media:unbound') return;
  const sample = pageClock.getLatestSample?.() ?? null;
  if (
    sample
    && sample.positionMs !== null
    && Number.isFinite(sample.positionMs)
    && sample.playbackState !== 'unavailable'
  ) {
    lastAnchorSequence += 1;
    const terminal = terminalAwareAnchorFields(
      sample.positionMs,
      sample.durationMs,
      mapState(sample.playbackState),
    );
    postSparseAnchor({
      protocolVersion: 1,
      sessionId,
      generation,
      mediaId,
      positionMs: terminal.positionMs,
      rate: Number.isFinite(sample.rate) ? sample.rate : 1,
      state: terminal.state,
      producedAtMs: Date.now(),
      sequence: lastAnchorSequence,
      durationMs: terminal.durationMs,
    });
    return;
  }
  // Hold last known progress (never force zero after a real sample).
  if (lastPublishedPositionMs > 0 || lyricRefresh.revision > 0) {
    lastAnchorSequence += 1;
    const heldDuration = timeline.getSnapshot(now())?.durationMs
      ?? pageClock.getLatestSample?.()?.durationMs
      ?? null;
    const terminal = terminalAwareAnchorFields(
      lastPublishedPositionMs,
      heldDuration,
      lastPublishedState,
    );
    postSparseAnchor({
      protocolVersion: 1,
      sessionId,
      generation,
      mediaId,
      positionMs: terminal.positionMs,
      rate: 1,
      state: terminal.state,
      producedAtMs: Date.now(),
      sequence: lastAnchorSequence,
      durationMs: terminal.durationMs,
    });
  }
}

function publishSnapshotOrHold(): void {
  const snapshot = timeline.getSnapshot(now());
  if (snapshot?.available) {
    publishSnapshot();
    return;
  }
  publishFromPageClockFallback();
}

function handleWorkerMessage(message: unknown): void {
  const envelope = parseMessageEnvelopeV1(message);
  if (!envelope.ok) return;
  if (envelope.value.channel !== 'playback') return;
  const payload = parsePlaybackPayload(envelope.value.payload);
  if (!payload || payload.kind !== 'seek-intent') return;
  void handleSeekIntent(payload.surfaceId, payload.targetMs);
}

async function handleSeekIntent(surfaceId: string, targetMs: number): Promise<void> {
  const clockSample = pageClock.getLatestSample?.() ?? null;
  // Prefer MAIN-world seek: NetEase window.player is not visible from isolated
  // content, so page-clock seek is the reliable path.
  let result = await pageClock.seek(targetMs);
  if (!result.ok) {
    result = seekPlatformTo(targetMs, {
      durationMs: clockSample?.durationMs
        ?? timeline.getSnapshot(now())?.durationMs
        ?? null,
    });
  }
  const outcome = result.ok ? 'accepted' as const : 'rejected' as const;
  if (port) {
    try {
      port.postMessage(createMessageEnvelopeV1({
        channel: 'playback',
        type: 'seek-outcome',
        messageId: crypto.randomUUID(),
        sentAtMs: Date.now(),
        sessionId,
        generation,
        payload: {
          kind: 'seek-outcome',
          surfaceId,
          outcome,
          positionMs: result.positionMs,
        },
      }));
    } catch {
      port = null;
    }
  }
  // After seek, publish the accepted position immediately so the lyric window
  // does not wait for a slow timeline re-anchor (and never stamps 0).
  if (result.ok) {
    // Trust the intent, not the platform echo: NetEase seek() is async and
    // reads currentTime synchronously right after — it returns the OLD
    // position, which force-published a backward anchor (bounce jump #1).
    const seekPos = targetMs;
    seekSuppressTargetMs = targetMs;
    seekSuppressUntilMs = now() + SEEK_SUPPRESS_MAX_MS;
    if (Number.isFinite(seekPos) && seekPos >= 0) {
      lastAnchorSequence += 1;
      const seekDuration = clockSample?.durationMs
        ?? timeline.getSnapshot(now())?.durationMs
        ?? null;
      const terminal = terminalAwareAnchorFields(seekPos, seekDuration, 'playing');
      postSparseAnchor({
        protocolVersion: 1,
        sessionId,
        generation,
        mediaId,
        positionMs: terminal.positionMs,
        rate: 1,
        state: terminal.state,
        producedAtMs: Date.now(),
        sequence: lastAnchorSequence,
        durationMs: terminal.durationMs,
      }, { force: true });
    }
    // Settle poller instead of blind timers: publish the first post-seek
    // truth as soon as the platform clock lands near the target (or the
    // window expires and normal publishing resumes with whatever is real).
    const settleDeadline = now() + SEEK_SUPPRESS_MAX_MS;
    const settleTick = (): void => {
      if (!runtimeActive) return;
      const sample = pageClock.getLatestSample?.() ?? null;
      const settled = sample?.positionMs != null
        && Number.isFinite(sample.positionMs)
        && Math.abs(sample.positionMs - targetMs) <= SEEK_SETTLE_TOLERANCE_MS;
      if (settled || now() >= settleDeadline) {
        if (!settled) seekSuppressTargetMs = null; // expiry bail-out only
        // Do NOT disarm on settle: the timeline may still be mid-confirmation
        // and would project the pre-seek position. The publish gate disarms
        // itself the moment an anchor lands near the target.
        publishSnapshotOrHold();
        return;
      }
      window.setTimeout(settleTick, 60);
    };
    window.setTimeout(settleTick, 60);
  }
}

function ingest(signal: RawPlaybackSignal): void {
  if (!runtimeActive) return;
  const receivedAtMs = now();
  const arbitration = arbiter.observe(signal, receivedAtMs);
  if (!arbitration.accepted) return;

  if (signal.mediaIdentity) {
    // contextId joins the media identity only where it is identity-bearing:
    // bilibili multi-part videos carry `p:<n>` and each part must keep its
    // own preferences/timing offsets. YouTube's contextId (watch/shorts) is
    // presentational — same video either way — and must not split identity.
    const identityContext = signal.mediaIdentity.platform === 'bilibili'
      && signal.mediaIdentity.contextId
      ? `:${signal.mediaIdentity.contextId}`
      : '';
    const nextMediaId = `${signal.mediaIdentity.platform}:${signal.mediaIdentity.externalId}${identityContext}`;
    applyMediaIdentity(nextMediaId);
  } else if (platform === 'applemusic') {
    // pageClock may carry catalog/library id before the adapter packages it.
    const hint = pageClock.getLatestSample?.()?.mediaExternalIdHint ?? null;
    if (isAppleMediaExternalId(hint)) {
      applyMediaIdentity(`applemusic:${hint}`);
    }
  }

  // Fast path: when MAIN page-clock reports a real position but the timeline
  // session is not healthy yet, still publish so the lyric window is not stuck
  // at 0 while arbiter/timeline warm up.
  if (
    signal.positionMs !== null
    && Number.isFinite(signal.positionMs)
    && signal.positionMs > 0
    && signal.playbackState !== 'unavailable'
    && signal.eventKind !== 'source-lost'
    && mediaId !== 'media:unbound'
  ) {
    // Keep last known for hold path — track the latest real sample even when
    // it moved backward (seek), so the hold path never resurrects a stale
    // high watermark. Suppressed post-seek echoes must not drag it back.
    if (!seekSuppressionActive(signal.positionMs)) {
      lastPublishedPositionMs = signal.positionMs;
      lastPublishedState = mapState(signal.playbackState);
    }
  }

  const healthy = arbiter.isSignalHealthy(signal);
  if (
    arbitration.sessionCandidateChanged
    && arbitration.signalIsAuthoritative
    && healthy
  ) {
    timeline.startSession(sessionId, signal, receivedAtMs);
    sessionStarted = true;
  } else if (!sessionStarted && healthy) {
    timeline.startSession(sessionId, signal, receivedAtMs);
    sessionStarted = true;
  } else if (arbitration.changed && arbitration.signalIsAuthoritative && healthy) {
    timeline.handoffSource(sessionId, signal, receivedAtMs);
  } else if (arbitration.signalIsAuthoritative && healthy) {
    timeline.ingest(sessionId, signal, receivedAtMs);
  } else if (arbitration.reason === 'authority-expired') {
    timeline.markUnavailable(sessionId, receivedAtMs);
  } else {
    return;
  }
  publishSnapshot();
}

const documentPort = {
  location: window.location,
  querySelectorAll: (selectors: string) =>
    document.querySelectorAll(selectors) as unknown as Iterable<HTMLVideoElement>,
  querySelector: (selectors: string) => document.querySelector(selectors),
};

const pageClock = createPageClockClient({ now, pollIntervalMs: 250 });
const platformAdapter = createRawSignalAdapter({
  document: documentPort,
  clock: { now },
  // Adapter only needs to refresh identity / state; page-clock free-run carries
  // continuous progress. Slightly slower than page-clock is fine.
  pollIntervalMs: 400,
  pageClock,
});

function stopAppleWarmupTimer(): void {
  if (appleWarmupTimer === null) return;
  window.clearInterval(appleWarmupTimer);
  appleWarmupTimer = null;
}

function appleWarmupStillNeeded(): boolean {
  return mediaId === 'applemusic:listening'
    || lyricRefresh.lastPublishedMediaId === null
    || lyricRefresh.revision === 0;
}

if (runtimeActive) {
  window.__lyricStageContentRuntime = Object.freeze({
    ownerId,
    sessionId,
    ensureConnected,
    // An owner whose extension context was invalidated (extension reloaded
    // while the tab stayed open) must report dead, or every re-injected
    // runtime becomes a permanent non-owner and the tab needs a full refresh.
    isAlive: () => {
      if (pageUnloading) return false;
      try {
        return typeof chrome.runtime?.id === 'string';
      } catch {
        return false;
      }
    },
  });

  // MAIN-world media clock for QQ/NetEase/Apple Music when isolated content
  // cannot see audio. Start before adapter poll so first samples can use it.
  if (
    platform === 'qqmusic'
    || platform === 'netease'
    || platform === 'applemusic'
  ) {
    void pageClock.start().then(() => {
      if (platform === 'applemusic') seedAppleMusicPresence();
    });
  }

  connect();
  startCoverPolling();

  // In-page floating panel (userscript's primary form). Only on recognized
  // platforms; the surface iframe owns the player and worker port.
  if (platform !== 'unknown') {
    try {
      createFloatingLyricPanel({
        surfaceUrl: chrome.runtime.getURL(
          `surface.html?panel=1&host=${encodeURIComponent(sessionId)}`,
        ),
        storageKeySuffix: window.location.origin,
      });
    } catch {
      // Panel is progressive enhancement; never break playback publishing.
    }
  }
  // Register Apple Music in the popup immediately (before MusicKit/catalog id).
  if (platform === 'applemusic') {
    seedAppleMusicPresence();
    // Warm-up only while identity/lyrics are unresolved — stop once stable.
    appleWarmupTimer = window.setInterval(() => {
      seedAppleMusicPresence();
      if (!appleWarmupStillNeeded()) {
        stopAppleWarmupTimer();
        return;
      }
      void refreshAndPublishLyrics(true);
    }, 2_000);
    // First lyric attempt shortly after inject (MusicKit often ready by then).
    window.setTimeout(() => {
      void refreshAndPublishLyrics(true);
    }, 800);
    window.setTimeout(() => {
      void refreshAndPublishLyrics(true);
    }, 2_500);
  }

  if (platformAdapter) {
    platformAdapter.start((signal) => {
      // Diagnostics only write when an explicit recording session is active.
      diagnosticSampler.record(signal);
      // NetEase/Apple often report identity before position is ready; still
      // ingest so mediaId/lyrics bind, and later healthy samples advance clock.
      if (
        signal.mediaIdentity
        || signal.playbackState !== 'unavailable'
        || (signal.positionMs !== null && signal.positionMs !== undefined)
      ) {
        ingest(signal);
      }
    });
  }

  // Soft re-arm: if page-clock never came up, try again when the tab becomes
  // visible or after a short delay (player / MusicKit often mounts late).
  const needsPageClock = platform === 'netease'
    || platform === 'qqmusic'
    || platform === 'applemusic';
  if (needsPageClock) {
    window.setTimeout(() => {
      if (!pageClock.installed) void pageClock.start();
    }, 1_500);
    window.setTimeout(() => {
      if (!pageClock.installed) void pageClock.start();
    }, 4_000);
  }

  document.addEventListener('visibilitychange', () => {
    recordDiagnosticMarker(
      document.visibilityState === 'hidden' ? 'visibility-hidden' : 'visibility-visible',
      document.visibilityState === 'hidden' ? 'document-hidden' : 'document-visible',
    );
    if (document.visibilityState === 'visible') {
      ensureConnected();
      // Player may have mounted while the tab was backgrounded.
      if (needsPageClock && !pageClock.installed) {
        void pageClock.start();
      }
      // Flush a fresh anchor when returning to the tab.
      publishSnapshotOrHold();
    }
  });
  window.addEventListener('pagehide', () => {
    pageUnloading = true;
    clearReconnectTimer();
    stopAppleWarmupTimer();
    if (coverPollTimer !== null) {
      window.clearInterval(coverPollTimer);
      coverPollTimer = null;
    }
    if (pendingSparsePublishTimer !== null) {
      clearTimeout(pendingSparsePublishTimer);
      pendingSparsePublishTimer = null;
    }
    recordDiagnosticMarker('visibility-hidden', 'pagehide');
    postGoodbye('pagehide');
    pageClock.stop();
    try {
      platformAdapter?.stop();
    } catch {
      // ignore
    }
    try {
      port?.disconnect();
    } catch {
      // ignore
    }
    port = null;
    if (window.__lyricStageContentRuntime?.ownerId === ownerId) {
      delete window.__lyricStageContentRuntime;
    }
  });
  window.addEventListener('pageshow', () => {
    pageUnloading = false;
    recordDiagnosticMarker('visibility-visible', 'pageshow');
    ensureConnected();
    if (needsPageClock) {
      void pageClock.start();
    }
  });

  // Worker can ping content after SW wake / popup open / source switch.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (typeof message !== 'object' || message === null) return false;
    const kind = (message as { kind?: string }).kind;
    if (kind === 'lyric-stage-ensure-connected') {
      const ok = ensureConnected();
      sendResponse({
        ok,
        sessionId,
        generation,
        mediaId,
        platform,
        connected: port !== null,
        ownerId,
      });
      return true;
    }
    if (kind === 'lyric-stage-republish') {
      const ok = ensureConnected();
      // Force lyric re-publish even when mediaId is unchanged so surfaces that
      // dropped our document during a Demo switch can rebind.
      lyricRefresh.resetBinding();
      void refreshAndPublishLyrics(true);
      publishSnapshot();
      sendResponse({ ok, sessionId, mediaId, republished: true });
      return true;
    }
    return false;
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (isDiagnosticControl(data)) {
    handleDiagnosticControl(data);
    return;
  }
  if (isTestFeedRequest(data)) {
    handleTestFeed(data);
    return;
  }
  if (!data || data.kind !== 'extension-content-request') return;
  if (data.command === 'snapshot') {
    const snap = timeline.getSnapshot(now());
    window.postMessage({
      kind: 'extension-content-response',
      requestId: data.requestId,
      response: {
        sessionId,
        generation,
        mediaId,
        platform,
        positionMs: snap?.positionMs ?? 0,
        sequence: lastAnchorSequence,
        playbackState: snap?.playbackState ?? 'unavailable',
        connected: port !== null,
      },
    }, '*');
  }
});
window.postMessage({ kind: 'extension-content-ready' }, '*');

interface DiagnosticControl {
  readonly kind: 'lyric-stage-extension-diagnostics-control';
  readonly requestId: string;
  readonly command: 'start' | 'stop' | 'clear' | 'summary' | 'export';
}

/**
 * Test-only signal feed for the localhost smoke harness. The real platform
 * adapters were the smoke's original data source until the synthetic demo
 * producer was removed; this guarded path lets the harness script real
 * RawPlaybackSignals and a lyric document through the production ingest and
 * publish pipeline. Hard-gated to the 'unknown' platform so it can never
 * activate on a music site.
 */
interface TestFeedRequest {
  readonly kind: 'lyric-stage-extension-test-feed';
  readonly requestId: string;
  readonly signals?: readonly Record<string, unknown>[];
  readonly lyric?: {
    readonly mediaId: string;
    readonly format: 'lrc' | 'plaintext';
    readonly text: string;
  };
}

function isTestFeedRequest(value: unknown): value is TestFeedRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<TestFeedRequest>;
  return record.kind === 'lyric-stage-extension-test-feed'
    && typeof record.requestId === 'string'
    && /^[a-zA-Z0-9:_-]{1,128}$/.test(record.requestId);
}

function handleTestFeed(request: TestFeedRequest): void {
  if (platform !== 'unknown' || !runtimeActive) {
    window.postMessage({
      kind: 'lyric-stage-extension-test-feed-response',
      requestId: request.requestId,
      response: { ok: false, reason: 'not-a-test-host' },
    }, '*');
    return;
  }
  let ingested = 0;
  for (const raw of request.signals ?? []) {
    const signal = raw as unknown as RawPlaybackSignal;
    if (
      typeof signal.producerInstanceId !== 'string'
      || typeof signal.capturedAtMs !== 'number'
      || typeof signal.playbackState !== 'string'
    ) continue;
    // Mirror the adapter path: diagnostics first (no-op unless recording).
    diagnosticSampler.record(signal);
    ingest(signal);
    ingested += 1;
  }
  if (request.lyric && typeof request.lyric.text === 'string') {
    publishLyricPayload({
      mediaId: request.lyric.mediaId,
      format: request.lyric.format,
      text: request.lyric.text,
      sourceName: 'test-feed',
      revision: 1,
    });
  }
  publishSnapshot();
  window.postMessage({
    kind: 'lyric-stage-extension-test-feed-response',
    requestId: request.requestId,
    response: { ok: true, ingested, sequence: lastAnchorSequence },
  }, '*');
}

function isDiagnosticControl(value: unknown): value is DiagnosticControl {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<DiagnosticControl>;
  return Object.keys(value).length === 3
    && record.kind === 'lyric-stage-extension-diagnostics-control'
    && typeof record.requestId === 'string'
    && /^[a-zA-Z0-9:_-]{1,128}$/.test(record.requestId)
    && (
      record.command === 'start'
      || record.command === 'stop'
      || record.command === 'clear'
      || record.command === 'summary'
      || record.command === 'export'
    );
}

function handleDiagnosticControl(control: DiagnosticControl): void {
  if (control.command === 'start') {
    diagnosticRecorder.start(true);
    recordDiagnosticMarker(
      document.visibilityState === 'hidden' ? 'visibility-hidden' : 'visibility-visible',
      document.visibilityState === 'hidden' ? 'document-hidden' : 'document-visible',
    );
    postDiagnosticResponse(control.requestId, diagnosticRecorder.getSummary());
    return;
  }
  if (control.command === 'stop') {
    diagnosticRecorder.stop();
    postDiagnosticResponse(control.requestId, diagnosticRecorder.getSummary());
    return;
  }
  if (control.command === 'clear') {
    diagnosticRecorder.clear();
    postDiagnosticResponse(control.requestId, diagnosticRecorder.getSummary());
    return;
  }
  if (control.command === 'summary') {
    postDiagnosticResponse(control.requestId, diagnosticRecorder.getSummary());
    return;
  }
  postDiagnosticResponse(control.requestId, diagnosticRecorder.createFixture());
}

function postDiagnosticResponse(
  requestId: string,
  response: unknown,
): void {
  window.postMessage({
    kind: 'lyric-stage-extension-diagnostics-response',
    requestId,
    response,
  }, window.location.origin);
}

function recordDiagnosticMarker(
  eventKind: Extract<RawPlaybackEventKind, 'visibility-hidden' | 'visibility-visible'>,
  sourceEvent: string,
): void {
  diagnosticRecorder.record({
    capturedAtMs: now(),
    positionMs: null,
    durationMs: null,
    playbackState: 'unavailable',
    rate: 1,
    seeking: false,
    sourceKind: 'unknown',
    confidence: 1,
    eventKind,
    sourceEvent,
  });
}
