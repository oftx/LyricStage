import {
  createMessageEnvelopeV1,
  isSparsePlaybackAnchorV1,
  parseMessageEnvelopeV1,
  parsePlaybackPayload,
  parseSessionPayload,
  type SourceListEntryV1,
  type SparsePlaybackAnchorV1,
} from '@lyric-stage/extension-protocol';

const el = {
  session: document.getElementById('session')!,
  media: document.getElementById('media')!,
  state: document.getElementById('state')!,
  stateDot: document.getElementById('state-dot')!,
  position: document.getElementById('position')!,
  statusCard: document.getElementById('status-card')!,
  sourceList: document.getElementById('source-list')!,
  openLyrics: document.getElementById('open-lyrics') as HTMLButtonElement,
  refresh: document.getElementById('refresh') as HTMLButtonElement,
  optPanelHandle: document.getElementById('opt-panel-handle') as HTMLInputElement,
  optDebug: document.getElementById('opt-debug') as HTMLInputElement,
};

/** Shared with surfaces (debug) and content scripts (handle visibility). */
const DEBUG_CHROME_KEY = 'lyric-stage:debug-chrome';
const PANEL_HANDLE_KEY = 'lyric-stage:panel-handle';

function wireOptions(): void {
  void chrome.storage.local.get([DEBUG_CHROME_KEY, PANEL_HANDLE_KEY]).then((stored) => {
    el.optDebug.checked = stored[DEBUG_CHROME_KEY] === true;
    // Handle defaults ON; only an explicit false hides it.
    el.optPanelHandle.checked = stored[PANEL_HANDLE_KEY] !== false;
    el.statusCard.hidden = !el.optDebug.checked;
  });
  el.optDebug.addEventListener('change', () => {
    el.statusCard.hidden = !el.optDebug.checked;
    void (el.optDebug.checked
      ? chrome.storage.local.set({ [DEBUG_CHROME_KEY]: true })
      : chrome.storage.local.remove(DEBUG_CHROME_KEY));
  });
  el.optPanelHandle.addEventListener('change', () => {
    void (el.optPanelHandle.checked
      ? chrome.storage.local.remove(PANEL_HANDLE_KEY)
      : chrome.storage.local.set({ [PANEL_HANDLE_KEY]: false }));
  });
}

let latest: SparsePlaybackAnchorV1 | null = null;
let sources: readonly SourceListEntryV1[] = [];
let selectedSessionId: string | null = null;
let port: chrome.runtime.Port | null = null;
/** Optimistic selection while worker confirms; survives list ticks. */
let selectingSessionId: string | null = null;
let selectingStartedAtMs = 0;
let wakeInFlight = false;
let lastWakeSummary: string | null = null;

/** Stable DOM nodes per session — never destroy mid-click on position ticks. */
const sourceNodes = new Map<string, HTMLButtonElement>();

const SELECTING_TIMEOUT_MS = 4_000;

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function shortMediaId(mediaId: string): string {
  if (mediaId.length <= 36) return mediaId;
  return `${mediaId.slice(0, 18)}…${mediaId.slice(-12)}`;
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 18) return sessionId;
  return `${sessionId.slice(0, 18)}…`;
}

function effectiveSelectedSessionId(): string | null {
  // Prefer in-flight user choice so ticks cannot snap the highlight back.
  if (selectingSessionId) return selectingSessionId;
  return selectedSessionId;
}

function clearSelectingIfSettled(nextSelected: string | null): void {
  if (!selectingSessionId) return;
  if (selectingSessionId === nextSelected) {
    selectingSessionId = null;
    selectingStartedAtMs = 0;
    return;
  }
  if (
    selectingStartedAtMs > 0
    && Date.now() - selectingStartedAtMs > SELECTING_TIMEOUT_MS
  ) {
    selectingSessionId = null;
    selectingStartedAtMs = 0;
  }
}

function renderStatus(): void {
  const focusSession = effectiveSelectedSessionId();
  if (!latest || (focusSession && latest.sessionId !== focusSession)) {
    // During switch, status may briefly lag; show selection id if known.
    const selectedRow = sources.find((row) => row.sessionId === focusSession);
    el.session.textContent = focusSession
      ? shortSessionId(focusSession)
      : 'none';
    el.media.textContent = selectedRow?.mediaId ?? '—';
    el.state.textContent = selectedRow?.state
      ?? (sources.length > 0 ? 'idle' : 'offline');
    el.stateDot.className = `dot ${selectedRow?.state ?? ''}`;
    el.position.textContent = selectedRow?.positionMs != null
      ? formatMs(selectedRow.positionMs)
      : '—';
    return;
  }
  el.session.textContent = shortSessionId(latest.sessionId);
  el.media.textContent = latest.mediaId;
  el.state.textContent = latest.state;
  el.stateDot.className = `dot ${latest.state}`;
  el.position.textContent = formatMs(latest.positionMs);
}

function stateLabel(source: SourceListEntryV1): string {
  if (source.positionMs === null) return source.state;
  return `${source.state} · ${formatMs(source.positionMs)}`;
}

function ensureSourceButton(sessionId: string): HTMLButtonElement {
  const existing = sourceNodes.get(sessionId);
  if (existing) return existing;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-item';
  button.role = 'option';
  button.dataset.sessionId = sessionId;

  const top = document.createElement('div');
  top.className = 'source-top';
  const platform = document.createElement('span');
  platform.className = 'source-platform';
  platform.dataset.role = 'platform';
  const badge = document.createElement('span');
  badge.className = 'source-badge';
  badge.dataset.role = 'badge';
  badge.hidden = true;
  top.append(platform, badge);

  const media = document.createElement('span');
  media.className = 'source-media';
  media.dataset.role = 'media';

  const foot = document.createElement('div');
  foot.className = 'source-foot';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.dataset.role = 'dot';
  const stateText = document.createElement('span');
  stateText.className = 'source-state-text';
  stateText.dataset.role = 'state';
  foot.append(dot, stateText);

  button.append(top, media, foot);
  sourceNodes.set(sessionId, button);
  return button;
}

function patchSourceButton(
  button: HTMLButtonElement,
  source: SourceListEntryV1,
): void {
  const focusId = effectiveSelectedSessionId();
  const isSelected = source.sessionId === focusId
    || (source.selected && !selectingSessionId);
  const busy = selectingSessionId === source.sessionId
    && selectedSessionId !== source.sessionId;

  button.dataset.sessionId = source.sessionId;
  if (typeof source.tabId === 'number') {
    button.dataset.tabId = String(source.tabId);
  } else {
    delete button.dataset.tabId;
  }
  button.dataset.selected = isSelected ? 'true' : 'false';
  button.dataset.busy = busy ? 'true' : 'false';
  button.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  // Never use disabled — it steals the first click when nodes are swapped.
  button.tabIndex = isSelected ? -1 : 0;

  const platform = button.querySelector<HTMLElement>('[data-role="platform"]');
  const badge = button.querySelector<HTMLElement>('[data-role="badge"]');
  const media = button.querySelector<HTMLElement>('[data-role="media"]');
  const dot = button.querySelector<HTMLElement>('[data-role="dot"]');
  const state = button.querySelector<HTMLElement>('[data-role="state"]');

  if (platform) platform.textContent = source.platformLabel;
  if (media) {
    media.textContent = shortMediaId(source.mediaId);
    media.title = source.mediaId;
  }
  if (dot) dot.className = `dot ${source.state}`;
  if (state) state.textContent = stateLabel(source);
  if (badge) {
    if (busy) {
      badge.hidden = false;
      badge.textContent = 'Switching…';
    } else if (isSelected) {
      badge.hidden = false;
      badge.textContent = 'Selected';
    } else {
      badge.hidden = true;
      badge.textContent = '';
    }
  }
}

function renderSources(): void {
  const list = el.sourceList;
  const nextIds = new Set(sources.map((source) => source.sessionId));

  if (sources.length === 0) {
    for (const node of sourceNodes.values()) node.remove();
    sourceNodes.clear();
    list.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'source-empty';
    empty.id = 'source-empty';
    empty.textContent = wakeInFlight
      ? 'Looking for NetEase / QQ / Apple Music / YouTube tabs…'
      : (lastWakeSummary
        ? `No live sources yet. ${lastWakeSummary}`
        : 'No music tabs connected. Open NetEase, QQ, or Apple Music and press Refresh.');
    list.append(empty);
    return;
  }

  // Drop empty placeholder if present.
  list.querySelector('#source-empty')?.remove();

  // Remove stale sessions.
  for (const [sessionId, node] of sourceNodes) {
    if (!nextIds.has(sessionId)) {
      node.remove();
      sourceNodes.delete(sessionId);
    }
  }

  // Patch / append in list order without destroying existing buttons.
  let cursor: ChildNode | null = list.firstChild;
  for (const source of sources) {
    const button = ensureSourceButton(source.sessionId);
    patchSourceButton(button, source);
    if (cursor !== button) {
      list.insertBefore(button, cursor);
    } else {
      cursor = cursor.nextSibling;
    }
    // After insertBefore, next cursor should be the node after this button.
    cursor = button.nextSibling;
  }
}

function render(): void {
  renderStatus();
  renderSources();
}

function postSession(
  type: string,
  payload: Record<string, unknown>,
): void {
  if (!port) return;
  try {
    port.postMessage(createMessageEnvelopeV1({
      channel: 'session',
      type,
      messageId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      payload,
    }));
  } catch {
    port = null;
  }
}

function selectSource(source: SourceListEntryV1): void {
  if (!port) return;
  const already = source.sessionId === effectiveSelectedSessionId()
    && !selectingSessionId
    && source.selected;
  if (already) return;
  if (selectingSessionId === source.sessionId) return;

  selectingSessionId = source.sessionId;
  selectingStartedAtMs = Date.now();
  // Optimistic local state so the click feels instant and survives ticks.
  selectedSessionId = source.sessionId;
  sources = sources.map((row) => Object.freeze({
    ...row,
    selected: row.sessionId === source.sessionId,
  }));
  render();

  postSession('select-source', {
    kind: 'select-source',
    ...(typeof source.tabId === 'number' ? { tabId: source.tabId } : {}),
    sessionId: source.sessionId,
  });
}

function requestSnapshot(): void {
  if (!port) return;
  try {
    port.postMessage(createMessageEnvelopeV1({
      channel: 'playback',
      type: 'request-snapshot',
      messageId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      payload: { kind: 'session-snapshot', anchor: null },
    }));
  } catch {
    port = null;
  }
  postSession('request-source-list', { kind: 'request-source-list' });
  wakeSources();
}

/**
 * Ask the worker to ping / re-inject content scripts on music tabs so the
 * source list fills after SW sleep or extension reload without a full tab refresh.
 */
function wakeSources(): void {
  if (wakeInFlight) return;
  wakeInFlight = true;
  renderSources();
  chrome.runtime.sendMessage({ kind: 'lyric-stage-wake-sources' }, (response) => {
    wakeInFlight = false;
    void chrome.runtime.lastError;
    if (response && typeof response === 'object') {
      const tabs = Number((response as { tabs?: unknown }).tabs ?? 0);
      const connected = Number((response as { connected?: unknown }).connected ?? 0);
      const reinjected = Number((response as { reinjected?: unknown }).reinjected ?? 0);
      lastWakeSummary = tabs > 0
        ? `Found ${tabs} tab(s), ${connected} connected${reinjected ? `, ${reinjected} reinjected` : ''}.`
        : 'No matching music tabs found.';
    } else {
      lastWakeSummary = 'Could not scan tabs (reload the extension and try again).';
    }
    postSession('request-source-list', { kind: 'request-source-list' });
    window.setTimeout(() => {
      postSession('request-source-list', { kind: 'request-source-list' });
      render();
    }, 200);
    render();
  });
}

function connect(): void {
  try {
    port?.disconnect();
  } catch {
    // ignore
  }
  try {
    port = chrome.runtime.connect({ name: 'surface' });
  } catch {
    port = null;
    latest = null;
    sources = [];
    selectedSessionId = null;
    selectingSessionId = null;
    render();
    return;
  }
  port.onDisconnect.addListener(() => {
    port = null;
  });
  port.onMessage.addListener((message: unknown) => {
    const envelope = parseMessageEnvelopeV1(message);
    if (!envelope.ok) return;

    if (envelope.value.channel === 'session') {
      const sessionPayload = parseSessionPayload(envelope.value.payload);
      if (!sessionPayload) return;
      if (sessionPayload.kind === 'source-list') {
        sources = sessionPayload.sources;
        selectedSessionId = sessionPayload.selectedSessionId;
        clearSelectingIfSettled(selectedSessionId);
        // Keep status card aligned with selected row when only the list moved.
        if (
          selectedSessionId
          && latest
          && latest.sessionId !== selectedSessionId
          && !selectingSessionId
        ) {
          latest = null;
        }
        render();
        return;
      }
      if (sessionPayload.kind === 'selected-source') {
        selectedSessionId = sessionPayload.sessionId;
        clearSelectingIfSettled(selectedSessionId);
        render();
      }
      return;
    }

    const payload = parsePlaybackPayload(envelope.value.payload);
    if (!payload) return;
    if (payload.kind === 'sparse-anchor' || payload.kind === 'session-snapshot') {
      const next = payload.anchor && isSparsePlaybackAnchorV1(payload.anchor)
        ? payload.anchor
        : null;
      // Ignore anchors from the previous source while a switch is in flight.
      if (
        selectingSessionId
        && next
        && next.sessionId !== selectingSessionId
      ) {
        return;
      }
      latest = next;
      if (latest && !selectingSessionId) {
        selectedSessionId = latest.sessionId;
      }
      if (latest && selectingSessionId === latest.sessionId) {
        clearSelectingIfSettled(latest.sessionId);
      }
      // Status + in-place source position updates only — no list destroy.
      render();
    }
  });
  requestSnapshot();
}

// Event delegation: survives node reordering; one listener for all rows.
el.sourceList.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('button.source-item');
  if (!button || !el.sourceList.contains(button)) return;
  const sessionId = button.dataset.sessionId;
  if (!sessionId) return;
  if (button.dataset.selected === 'true' && !selectingSessionId) return;
  const source = sources.find((row) => row.sessionId === sessionId);
  if (!source) return;
  event.preventDefault();
  selectSource(source);
});

el.refresh.addEventListener('click', () => {
  if (!port) {
    connect();
    return;
  }
  requestSnapshot();
});

el.openLyrics.addEventListener('click', () => {
  chrome.runtime.sendMessage({
    kind: 'lyric-stage-open-lyric-window',
  }, () => {
    void chrome.runtime.lastError;
  });
});

wireOptions();
connect();
render();

export {};
