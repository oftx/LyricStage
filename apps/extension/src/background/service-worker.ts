import {
  createMessageEnvelopeV1,
  parseMessageEnvelopeV1,
  parsePlaybackPayload,
  parseSessionPayload,
  platformLabelFromMediaId,
  type LyricDocumentPayloadV1,
  type MessageEnvelopeV1,
  type SourceListEntryV1,
  type SparsePlaybackAnchorV1,
} from '@lyric-stage/extension-protocol';
import { installPageClockMainBridge } from '../page-clock/main.js';
import { SessionRegistry } from './session-registry.js';
import {
  isWakeSourcesRequest,
  MUSIC_TAB_URL_PATTERNS,
  wakeMusicTabContentScripts as wakeWithDeps,
} from './wake.js';
import { rankFailoverSessions as rankSessions } from './selection-policy.js';

const bootId = crypto.randomUUID();
const registry = new SessionRegistry(bootId);
const surfacePorts = new Set<chrome.runtime.Port>();

interface ContentSource {
  readonly port: chrome.runtime.Port;
  sessionId: string | null;
  generation: number;
  mediaId: string | null;
  tabId: number | null;
  lastState: SparsePlaybackAnchorV1['state'] | null;
  lastSeenAtMs: number;
}

const contentSources = new Map<chrome.runtime.Port, ContentSource>();
/** Lyrics bound to a content session; only the selected session is published. */
const lyricBySession = new Map<string, LyricDocumentPayloadV1>();
let publishedLyricDocument: LyricDocumentPayloadV1 | null = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'content-runtime') {
    bindContentPort(port);
    return;
  }
  if (port.name === 'surface') {
    bindSurfacePort(port);
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isInstallPageClockRequest(message) && sender.tab?.id !== undefined) {
    void chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      world: 'MAIN',
      func: installPageClockMainBridge,
      args: [{
        bridgeInstanceId: message.bridgeInstanceId,
        nonce: message.nonce,
      }],
    }).then(() => {
      sendResponse({ ok: true });
    }).catch((error: unknown) => {
      sendResponse({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  if (isOpenLyricWindowRequest(message)) {
    void openLyricWindow()
      .then((result) => sendResponse(result))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  // Bare wake requests carry no envelope — they must be recognized BEFORE
  // envelope parsing, or the popup's wake lands on invalid-envelope and shows
  // "No matching music tabs found" (P0-2).
  if (isWakeSourcesRequest(message)) {
    void wakeMusicTabContentScripts()
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  // Forward search and fetch requests to the active content tab
  const kind = (message as { kind?: string } | null)?.kind;
  if (kind === 'lyric-stage-search-request' || kind === 'lyric-stage-fetch-lyric-request') {
    const targetSessionId = registry.selectedSessionId;
    let targetPort: chrome.runtime.Port | null = null;
    if (targetSessionId) {
      for (const source of contentSources.values()) {
        if (source.sessionId === targetSessionId) {
          targetPort = source.port;
          break;
        }
      }
    }
    const tabId = targetPort?.sender?.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, reason: 'no-active-tab' });
      return false;
    }
    chrome.tabs.sendMessage(tabId, message, (response: unknown) => {
      sendResponse(response);
    });
    return true;
  }

  const envelope = parseMessageEnvelopeV1(message);
  if (!envelope.ok) {
    sendResponse({ ok: false, code: 'invalid-envelope' });
    return false;
  }
  if (envelope.value.channel === 'session' && envelope.value.type === 'ping') {
    sendResponse({
      ok: true,
      bootId: registry.bootId,
      hasSession: registry.latest !== null,
      selectedSessionId: registry.selectedSessionId,
      hasLyrics: publishedLyricDocument !== null,
      knownSourceCount: contentSources.size,
    });
    return false;
  }
  sendResponse({ ok: false, code: 'unsupported' });
  return false;
});

function bindContentPort(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id ?? null;
  // One live port per tab. Re-injection / reconnect can open a second port
  // while the old one is still half-alive — keep the newest and drop the rest.
  if (typeof tabId === 'number') {
    for (const [existingPort, existing] of contentSources) {
      if (existing.tabId === tabId && existingPort !== port) {
        contentSources.delete(existingPort);
        try {
          existingPort.disconnect();
        } catch {
          // ignore
        }
      }
    }
  }
  const source: ContentSource = {
    port,
    sessionId: null,
    generation: 0,
    mediaId: null,
    tabId,
    lastState: null,
    lastSeenAtMs: Date.now(),
  };
  contentSources.set(port, source);
  port.onDisconnect.addListener(() => {
    handleContentDisconnect(port);
  });
  port.onMessage.addListener((message: unknown) => {
    const envelope = parseMessageEnvelopeV1(message);
    if (!envelope.ok) return;
    handleContentEnvelope(source, envelope.value);
  });
}

function handleContentDisconnect(port: chrome.runtime.Port): void {
  const source = contentSources.get(port);
  contentSources.delete(port);
  if (!source?.sessionId) {
    broadcastSourceList();
    return;
  }
  const wasSelected = registry.releaseSession(source.sessionId);
  lyricBySession.delete(source.sessionId);
  if (wasSelected) promoteAfterSelectedLoss();
  else broadcastSourceList();
}

function handleContentEnvelope(
  source: ContentSource,
  envelope: MessageEnvelopeV1,
): void {
  source.lastSeenAtMs = Date.now();

  if (envelope.channel === 'session') {
    const payload = parseSessionPayload(envelope.payload);
    if (!payload) return;
    if (payload.kind === 'source-hello') {
      // Ignore placeholder hellos until a real media id is known.
      if (
        !payload.mediaId
        || payload.mediaId === 'media:unbound'
        || payload.mediaId === 'media:unknown'
        || payload.mediaId.endsWith(':unbound')
      ) {
        return;
      }
      source.sessionId = payload.sessionId;
      source.generation = payload.generation;
      source.mediaId = payload.mediaId;
      // First hello with no selection claims ownership without waiting for an
      // anchor — implicitly, so a tab that is actually playing can still take
      // over (connection order must not decide ownership).
      if (registry.selectedSessionId === null) {
        registry.selectSession(payload.sessionId, { explicit: false });
        broadcastSelectedSource(source);
      }
      broadcastSourceList();
      return;
    }
    if (payload.kind === 'source-goodbye') {
      if (source.sessionId && source.sessionId !== payload.sessionId) {
        // Ignore stale goodbye from a recycled content epoch.
        return;
      }
      const sessionId = payload.sessionId;
      const wasSelected = registry.releaseSession(sessionId);
      lyricBySession.delete(sessionId);
      contentSources.delete(source.port);
      try {
        source.port.disconnect();
      } catch {
        // already closed
      }
      if (wasSelected) promoteAfterSelectedLoss();
      else broadcastSourceList();
      return;
    }
    if (payload.kind === 'select-source') {
      // Content should not select; reserved for popup/surface.
      return;
    }
    return;
  }

  if (envelope.channel === 'playback') {
    const payload = parsePlaybackPayload(envelope.payload);
    if (!payload) return;

    if (payload.kind === 'sparse-anchor') {
      if (source.sessionId && payload.anchor.sessionId !== source.sessionId) {
        // Content retargeted session id without hello — adopt.
        source.sessionId = payload.anchor.sessionId;
      } else if (!source.sessionId) {
        source.sessionId = payload.anchor.sessionId;
      }
      source.generation = payload.anchor.generation;
      source.mediaId = payload.anchor.mediaId;
      source.lastState = payload.anchor.state;

      const selectedBefore = registry.selectedSessionId;
      const accepted = registry.acceptAnchor(payload.anchor);
      // Popup lists every tab; throttle so non-selected 250ms samples don't flood.
      broadcastSourceListThrottled();

      if (!accepted) return;

      if (registry.selectedSessionId !== selectedBefore) {
        // Active-over-idle takeover: announce the new selected source and
        // push the new session's lyric document — surfaces otherwise keep
        // rendering the previous session's lyrics against the new clock.
        const takeoverSource = findSourceBySession(payload.anchor.sessionId);
        if (takeoverSource) broadcastSelectedSource(takeoverSource);
        syncPublishedLyricsFromSelection();
        broadcastToSurfaces(createMessageEnvelopeV1({
          channel: 'playback',
          type: 'session-snapshot',
          messageId: crypto.randomUUID(),
          sentAtMs: Date.now(),
          sessionId: payload.anchor.sessionId,
          generation: payload.anchor.generation,
          payload: {
            kind: 'session-snapshot',
            anchor: payload.anchor,
            lyricDocument: publishedLyricDocument,
          },
        }));
      }
      syncPublishedLyricsFromSelection();
      broadcastToSurfaces(createMessageEnvelopeV1({
        channel: 'playback',
        type: 'sparse-anchor',
        messageId: crypto.randomUUID(),
        sentAtMs: Date.now(),
        sessionId: payload.anchor.sessionId,
        generation: payload.anchor.generation,
        sequence: payload.anchor.sequence,
        payload: { kind: 'sparse-anchor', anchor: payload.anchor },
      }));
      return;
    }

    if (payload.kind === 'media-meta') {
      const sessionId = source.sessionId
        ?? (typeof envelope.sessionId === 'string' ? envelope.sessionId : null);
      if (!sessionId || sessionId !== registry.selectedSessionId) return;
      broadcastToSurfaces(createMessageEnvelopeV1({
        channel: 'playback',
        type: 'media-meta',
        messageId: crypto.randomUUID(),
        sentAtMs: Date.now(),
        sessionId,
        payload: { kind: 'media-meta', meta: payload.meta },
      }));
      return;
    }
    if (payload.kind === 'lyric-document') {
      const sessionId = source.sessionId
        ?? (typeof envelope.sessionId === 'string' ? envelope.sessionId : null);
      if (!sessionId) return;
      lyricBySession.set(sessionId, payload.document);
      // Only the sticky selected session may update the lyric window.
      if (sessionId !== registry.selectedSessionId) return;
      publishedLyricDocument = payload.document;
      broadcastToSurfaces(createMessageEnvelopeV1({
        channel: 'playback',
        type: 'lyric-document',
        messageId: crypto.randomUUID(),
        sentAtMs: Date.now(),
        sessionId,
        payload: { kind: 'lyric-document', document: payload.document },
      }));
      return;
    }

    if (payload.kind === 'lyric-clear') {
      const sessionId = source.sessionId
        ?? (typeof envelope.sessionId === 'string' ? envelope.sessionId : null);
      if (!sessionId) return;
      // Authoritative only for the media the session is NOW on — a stale
      // in-flight failure for the previous track must not blank the current.
      if (source.mediaId && payload.mediaId !== source.mediaId) return;
      // And it only invalidates cached documents for OTHER media: a document
      // already bound for this media (platform push racing a library miss)
      // beats a concurrent lookup failure.
      const cached = lyricBySession.get(sessionId);
      if (cached && cached.mediaId === payload.mediaId) return;
      lyricBySession.delete(sessionId);
      if (sessionId !== registry.selectedSessionId) return;
      publishedLyricDocument = null;
      broadcastToSurfaces(createMessageEnvelopeV1({
        channel: 'playback',
        type: 'lyric-clear',
        messageId: crypto.randomUUID(),
        sentAtMs: Date.now(),
        sessionId,
        payload: { kind: 'lyric-clear', mediaId: payload.mediaId },
      }));
      return;
    }

    if (payload.kind === 'seek-outcome') {
      // Only forward outcomes from the selected source so dual-tab seeks do not
      // flicker status from the wrong site.
      if (
        source.sessionId
        && registry.selectedSessionId
        && source.sessionId !== registry.selectedSessionId
      ) {
        return;
      }
      broadcastToSurfaces(createMessageEnvelopeV1({
        channel: 'playback',
        type: 'seek-outcome',
        messageId: crypto.randomUUID(),
        sentAtMs: Date.now(),
        payload,
      }));
    }
  }
}

function promoteAfterSelectedLoss(): void {
  const preferred = rankFailoverSessions();
  const promoted = registry.promoteSession(preferred);
  if (!promoted) {
    publishedLyricDocument = null;
    broadcastToSurfaces(createMessageEnvelopeV1({
      channel: 'playback',
      type: 'session-snapshot',
      messageId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      payload: { kind: 'session-snapshot', anchor: null, lyricDocument: null },
    }));
    broadcastSourceList();
    return;
  }
  syncPublishedLyricsFromSelection();
  const selectedSource = findSourceBySession(promoted.sessionId);
  if (selectedSource) broadcastSelectedSource(selectedSource);
  broadcastToSurfaces(createMessageEnvelopeV1({
    channel: 'playback',
    type: 'session-snapshot',
    messageId: crypto.randomUUID(),
    sentAtMs: Date.now(),
    sessionId: promoted.sessionId,
    generation: promoted.generation,
    payload: {
      kind: 'session-snapshot',
      anchor: promoted,
      lyricDocument: publishedLyricDocument,
    },
  }));
  broadcastSourceList();
}

function rankFailoverSessions(): string[] {
  return rankSessions(
    [...contentSources.values()]
      .filter((source): source is ContentSource & { sessionId: string } => (
        typeof source.sessionId === 'string' && source.sessionId.length > 0
      ))
      .map((source) => ({
        sessionId: source.sessionId,
        lastState: source.lastState,
        lastSeenAtMs: source.lastSeenAtMs,
      })),
  );
}

function syncPublishedLyricsFromSelection(): void {
  const selected = registry.selectedSessionId;
  publishedLyricDocument = selected
    ? lyricBySession.get(selected) ?? null
    : null;
}

function findSourceBySession(sessionId: string): ContentSource | null {
  for (const source of contentSources.values()) {
    if (source.sessionId === sessionId) return source;
  }
  return null;
}

function selectedContentPort(): chrome.runtime.Port | null {
  const selected = registry.selectedSessionId;
  if (!selected) return null;
  return findSourceBySession(selected)?.port ?? null;
}

function broadcastSelectedSource(source: ContentSource): void {
  if (!source.sessionId) return;
  broadcastToSurfaces(createMessageEnvelopeV1({
    channel: 'session',
    type: 'selected-source',
    messageId: crypto.randomUUID(),
    sentAtMs: Date.now(),
    sessionId: source.sessionId,
    generation: source.generation || 1,
    payload: {
      kind: 'selected-source',
      tabId: source.tabId ?? -1,
      sessionId: source.sessionId,
      generation: source.generation || 1,
    },
  }));
}

function buildSourceListEntries(): readonly SourceListEntryV1[] {
  const selected = registry.selectedSessionId;
  // Prefer one row per browser tab (newest / selected wins).
  const byKey = new Map<string, SourceListEntryV1 & { readonly lastSeenAtMs: number }>();
  for (const source of contentSources.values()) {
    if (!source.sessionId) continue;
    // Hide synthetic demo noise unless it is the only local smoke source.
    const mediaId = source.mediaId
      ?? registry.latestFor(source.sessionId)?.mediaId
      ?? 'media:unknown';
    if (
      mediaId === 'media:unbound'
      || mediaId === 'media:unknown'
      || mediaId.endsWith(':unbound')
    ) {
      continue;
    }
    if (
      mediaId.startsWith('synthetic:')
      && contentSources.size > 1
    ) {
      continue;
    }
    const anchor = registry.latestFor(source.sessionId);
    const key = typeof source.tabId === 'number'
      ? `tab:${source.tabId}`
      : `session:${source.sessionId}`;
    const entry = Object.freeze({
      sessionId: source.sessionId,
      generation: source.generation || anchor?.generation || 1,
      mediaId,
      tabId: source.tabId,
      state: source.lastState ?? anchor?.state ?? 'unknown',
      positionMs: anchor?.positionMs ?? null,
      selected: source.sessionId === selected,
      platformLabel: platformLabelFromMediaId(mediaId),
      lastSeenAtMs: source.lastSeenAtMs,
    });
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, entry);
      continue;
    }
    // Prefer selected, then fresher activity.
    if (entry.selected && !previous.selected) {
      byKey.set(key, entry);
      continue;
    }
    if (entry.selected === previous.selected
      && entry.lastSeenAtMs >= previous.lastSeenAtMs
    ) {
      byKey.set(key, entry);
    }
  }
  const rows = [...byKey.values()].map((row) => Object.freeze({
    sessionId: row.sessionId,
    generation: row.generation,
    mediaId: row.mediaId,
    tabId: row.tabId,
    state: row.state,
    positionMs: row.positionMs,
    selected: row.selected,
    platformLabel: row.platformLabel,
  }));
  // Selected first, then playing, then by media id.
  rows.sort((left, right) => {
    if (left.selected !== right.selected) return left.selected ? -1 : 1;
    const leftPlaying = left.state === 'playing' || left.state === 'buffering';
    const rightPlaying = right.state === 'playing' || right.state === 'buffering';
    if (leftPlaying !== rightPlaying) return leftPlaying ? -1 : 1;
    return left.mediaId.localeCompare(right.mediaId);
  });
  return Object.freeze(rows);
}

function createSourceListEnvelope(): MessageEnvelopeV1 {
  return createMessageEnvelopeV1({
    channel: 'session',
    type: 'source-list',
    messageId: crypto.randomUUID(),
    sentAtMs: Date.now(),
    payload: {
      kind: 'source-list',
      selectedSessionId: registry.selectedSessionId,
      sources: buildSourceListEntries(),
    },
  });
}

function broadcastSourceList(): void {
  lastSourceListBroadcastAtMs = Date.now();
  broadcastToSurfaces(createSourceListEnvelope());
}

let lastSourceListBroadcastAtMs = 0;
let sourceListThrottleTimer: ReturnType<typeof setTimeout> | null = null;

/** Popup list can lag slightly; avoid flooding on every 250ms content sample. */
function broadcastSourceListThrottled(minIntervalMs = 400): void {
  const elapsed = Date.now() - lastSourceListBroadcastAtMs;
  if (elapsed >= minIntervalMs) {
    broadcastSourceList();
    return;
  }
  if (sourceListThrottleTimer !== null) return;
  sourceListThrottleTimer = setTimeout(() => {
    sourceListThrottleTimer = null;
    broadcastSourceList();
  }, Math.max(0, minIntervalMs - elapsed));
}

function bindSurfacePort(port: chrome.runtime.Port): void {
  surfacePorts.add(port);
  port.onDisconnect.addListener(() => {
    surfacePorts.delete(port);
  });
  port.postMessage(createMessageEnvelopeV1({
    channel: 'playback',
    type: 'session-snapshot',
    messageId: crypto.randomUUID(),
    sentAtMs: Date.now(),
    payload: {
      kind: 'session-snapshot',
      anchor: registry.latest,
      lyricDocument: publishedLyricDocument,
    },
  }));
  port.postMessage(createSourceListEnvelope());
  // Popup/surface open often follows a worker restart. Nudge music tabs to
  // re-open content ports so the source list is not permanently empty.
  void wakeMusicTabContentScripts().then(() => {
    if (!surfacePorts.has(port)) return;
    try {
      port.postMessage(createSourceListEnvelope());
    } catch {
      surfacePorts.delete(port);
    }
  });
  port.onMessage.addListener((message: unknown) => {
    const envelope = parseMessageEnvelopeV1(message);
    if (!envelope.ok) return;
    if (envelope.value.type === 'request-snapshot') {
      port.postMessage(createMessageEnvelopeV1({
        channel: 'playback',
        type: 'session-snapshot',
        messageId: crypto.randomUUID(),
        sentAtMs: Date.now(),
        payload: {
          kind: 'session-snapshot',
          anchor: registry.latest,
          lyricDocument: publishedLyricDocument,
        },
      }));
      port.postMessage(createSourceListEnvelope());
      void wakeMusicTabContentScripts().then(() => {
        if (!surfacePorts.has(port)) return;
        try {
          port.postMessage(createSourceListEnvelope());
        } catch {
          surfacePorts.delete(port);
        }
      });
      return;
    }
    if (envelope.value.channel === 'session') {
      const payload = parseSessionPayload(envelope.value.payload);
      if (payload?.kind === 'select-source') {
        handleSelectSource({
          ...(typeof payload.tabId === 'number' ? { tabId: payload.tabId } : {}),
          ...(typeof payload.sessionId === 'string'
            ? { sessionId: payload.sessionId }
            : {}),
        });
        return;
      }
      if (payload?.kind === 'request-source-list') {
        port.postMessage(createSourceListEnvelope());
        void wakeMusicTabContentScripts().then(() => {
          if (!surfacePorts.has(port)) return;
          try {
            port.postMessage(createSourceListEnvelope());
          } catch {
            surfacePorts.delete(port);
          }
        });
      }
      return;
    }
    if (envelope.value.channel === 'playback') {
      const payload = parsePlaybackPayload(envelope.value.payload);
      if (payload?.kind === 'seek-intent') {
        routeSeekIntentToContent(envelope.value);
      }
    }
  });
}

/** Shared in-flight wake — popup open fires up to four wake triggers at once. */
let wakeInFlight: Promise<{
  readonly tabs: number;
  readonly connected: number;
  readonly reinjected: number;
}> | null = null;

/**
 * After SW sleep/extension reload, content ports die and music tabs keep their
 * old JS world (no auto re-inject). Ping existing content scripts; if none
 * answer, re-inject content.js once so ports re-register. Concurrent callers
 * share one scan — the per-call live-port snapshot cannot dedup calls that
 * start inside the 80ms inject settle window, so single-flight here.
 */
async function wakeMusicTabContentScripts(): Promise<{
  readonly tabs: number;
  readonly connected: number;
  readonly reinjected: number;
}> {
  if (typeof chrome.tabs?.query !== 'function') {
    return { tabs: 0, connected: 0, reinjected: 0 };
  }
  if (wakeInFlight) return wakeInFlight;
  wakeInFlight = runWakeMusicTabContentScripts().finally(() => {
    wakeInFlight = null;
  });
  return wakeInFlight;
}

function runWakeMusicTabContentScripts(): Promise<{
  readonly tabs: number;
  readonly connected: number;
  readonly reinjected: number;
}> {
  return wakeWithDeps({
    queryTabs: async () => {
      const tabs = await chrome.tabs.query({ url: [...MUSIC_TAB_URL_PATTERNS] });
      return tabs.map((tab) => (tab.id === undefined ? {} : { id: tab.id }));
    },
    sendTabMessage: (tabId, message) => (
      chrome.tabs.sendMessage(tabId, message) as Promise<{ ok?: boolean } | undefined>
    ),
    injectContentScript: async (tabId) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
    },
    liveTabIds: () => {
      const liveTabIds = new Set<number>();
      for (const source of contentSources.values()) {
        if (typeof source.tabId === 'number') liveTabIds.add(source.tabId);
      }
      return liveTabIds;
    },
    settle: (ms) => new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  });
}

function handleSelectSource(input: {
  readonly tabId?: number;
  readonly sessionId?: string;
}): void {
  let match: ContentSource | null = null;
  if (input.sessionId) {
    match = findSourceBySession(input.sessionId);
  }
  if (!match && typeof input.tabId === 'number') {
    for (const source of contentSources.values()) {
      if (source.tabId === input.tabId && source.sessionId) {
        match = source;
        break;
      }
    }
  }
  if (!match?.sessionId) return;
  registry.selectSession(match.sessionId);
  syncPublishedLyricsFromSelection();
  broadcastSelectedSource(match);
  const anchor = registry.latestFor(match.sessionId) ?? registry.latest;
  // Always include the selected session's lyric doc (may be null) so the
  // surface rebinds media even when revisions overlap across sources.
  broadcastToSurfaces(createMessageEnvelopeV1({
    channel: 'playback',
    type: 'session-snapshot',
    messageId: crypto.randomUUID(),
    sentAtMs: Date.now(),
    sessionId: match.sessionId,
    generation: match.generation || 1,
    payload: {
      kind: 'session-snapshot',
      anchor,
      lyricDocument: publishedLyricDocument,
    },
  }));
  // Ask the selected content tab to re-publish lyrics + a fresh anchor in case
  // the cache was empty or stale for this session.
  requestContentRepublish(match);
  broadcastSourceList();
}

function requestContentRepublish(source: ContentSource): void {
  // Poke the tab so content re-publishes lyrics + a fresh sparse anchor after
  // an explicit source switch (session snapshot may have a stale/null lyric).
  if (typeof source.tabId === 'number' && typeof chrome.tabs?.sendMessage === 'function') {
    void chrome.tabs.sendMessage(source.tabId, {
      kind: 'lyric-stage-republish',
    }).catch(() => {
      // Port/tab may be dead; wake path will reconnect.
    });
  }
}

function routeSeekIntentToContent(envelope: MessageEnvelopeV1): void {
  const target = selectedContentPort();
  if (!target) {
    broadcastToSurfaces(createMessageEnvelopeV1({
      channel: 'playback',
      type: 'seek-outcome',
      messageId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      payload: {
        kind: 'seek-outcome',
        surfaceId: (parsePlaybackPayload(envelope.payload) as { surfaceId?: string } | null)?.surfaceId
          ?? 'unknown',
        outcome: 'rejected',
        positionMs: null,
      },
    }));
    return;
  }
  try {
    target.postMessage(envelope);
  } catch {
    contentSources.delete(target);
  }
}

function broadcastToSurfaces(message: MessageEnvelopeV1): void {
  for (const port of surfacePorts) {
    try {
      port.postMessage(message);
    } catch {
      surfacePorts.delete(port);
    }
  }
}

interface InstallPageClockRequest {
  readonly type: 'install-page-clock-bridge';
  readonly bridgeInstanceId: string;
  readonly nonce: string;
}

function isInstallPageClockRequest(value: unknown): value is InstallPageClockRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<InstallPageClockRequest>;
  return candidate.type === 'install-page-clock-bridge'
    && typeof candidate.bridgeInstanceId === 'string'
    && /^bridge:[a-f0-9-]{36}$/.test(candidate.bridgeInstanceId)
    && typeof candidate.nonce === 'string'
    && /^[a-f0-9]{64}$/.test(candidate.nonce);
}

interface OpenLyricWindowRequest {
  readonly kind: 'lyric-stage-open-lyric-window';
}

function isOpenLyricWindowRequest(value: unknown): value is OpenLyricWindowRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { kind?: unknown }).kind === 'lyric-stage-open-lyric-window';
}

let lyricWindowId: number | null = null;

async function openLyricWindow(): Promise<{ ok: true; windowId: number } | { ok: false; reason: string }> {
  if (lyricWindowId !== null) {
    try {
      const existing = await chrome.windows.get(lyricWindowId);
      if (existing.id !== undefined) {
        await chrome.windows.update(existing.id, { focused: true });
        return { ok: true, windowId: existing.id };
      }
    } catch {
      lyricWindowId = null;
    }
  }
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL('surface.html'),
    type: 'popup',
    width: 440,
    height: 1080,
    focused: true,
  });
  const windowId = created?.id;
  if (windowId === undefined) {
    return { ok: false, reason: 'window-create-failed' };
  }
  lyricWindowId = windowId;
  return { ok: true, windowId };
}

chrome.windows?.onRemoved?.addListener((windowId) => {
  if (windowId === lyricWindowId) lyricWindowId = null;
});

(globalThis as { __extensionBootId?: string }).__extensionBootId = bootId;
