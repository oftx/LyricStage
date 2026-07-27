/**
 * Wake logic for music-tab content scripts, extracted from the service worker
 * so the ping → re-inject → re-ping ordering is unit-testable. Dependencies
 * are injected; behavior matches the original worker implementation.
 */

export const MUSIC_TAB_URL_PATTERNS = [
  '*://music.163.com/*',
  '*://*.music.163.com/*',
  '*://y.qq.com/*',
  '*://*.y.qq.com/*',
  '*://*.youtube.com/*',
  '*://youtu.be/*',
  '*://music.youtube.com/*',
  '*://www.bilibili.com/*',
  '*://m.bilibili.com/*',
  '*://music.apple.com/*',
  '*://*.music.apple.com/*',
  'http://127.0.0.1/*',
  'http://localhost/*',
] as const;

export interface WakeSourcesRequest {
  readonly kind: 'lyric-stage-wake-sources';
}

export function isWakeSourcesRequest(value: unknown): value is WakeSourcesRequest {
  return typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'lyric-stage-wake-sources';
}

export interface WakeResult {
  readonly tabs: number;
  readonly connected: number;
  readonly reinjected: number;
}

export interface WakeDependencies {
  /** chrome.tabs.query over the music URL patterns; may reject. */
  readonly queryTabs: () => Promise<ReadonlyArray<{ readonly id?: number }>>;
  /** chrome.tabs.sendMessage; rejects when no receiver exists. */
  readonly sendTabMessage: (
    tabId: number,
    message: unknown,
  ) => Promise<{ ok?: boolean } | undefined>;
  /** chrome.scripting.executeScript for content.js; rejects on restricted tabs. */
  readonly injectContentScript: (tabId: number) => Promise<void>;
  /** Tab ids that currently hold a live content port. */
  readonly liveTabIds: () => ReadonlySet<number>;
  /** Post-inject settle delay; injected for deterministic tests. */
  readonly settle: (ms: number) => Promise<void>;
}

const ENSURE_CONNECTED = { kind: 'lyric-stage-ensure-connected' } as const;
const POST_INJECT_SETTLE_MS = 80;

/**
 * After SW sleep/extension reload, content ports die and music tabs keep their
 * old JS world (no auto re-inject). Ping existing content scripts; if none
 * answer, re-inject content.js once so ports re-register.
 */
export async function wakeMusicTabContentScripts(
  deps: WakeDependencies,
): Promise<WakeResult> {
  let tabs: ReadonlyArray<{ readonly id?: number }> = [];
  try {
    tabs = await deps.queryTabs();
  } catch {
    return { tabs: 0, connected: 0, reinjected: 0 };
  }

  // Skip tabs that already have a live content port — avoids stacking injects.
  const liveTabIds = new Set(deps.liveTabIds());

  let connected = 0;
  let reinjected = 0;
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined) return;
    const tabId = tab.id;
    if (liveTabIds.has(tabId)) {
      connected += 1;
      // Soft ping only — no re-inject while the port is healthy.
      try {
        await deps.sendTabMessage(tabId, ENSURE_CONNECTED);
      } catch {
        // Port thought live but message failed; fall through to reconnect path.
        liveTabIds.delete(tabId);
      }
      if (liveTabIds.has(tabId)) return;
    }
    let answered = false;
    try {
      const response = await deps.sendTabMessage(tabId, ENSURE_CONNECTED);
      if (response?.ok) {
        answered = true;
        connected += 1;
      }
    } catch {
      answered = false;
    }
    if (answered) return;
    // Content script missing (extension reloaded while tab stayed open).
    try {
      await deps.injectContentScript(tabId);
      reinjected += 1;
      // Give the freshly injected runtime a tick to open its port.
      await deps.settle(POST_INJECT_SETTLE_MS);
      try {
        const response = await deps.sendTabMessage(tabId, ENSURE_CONNECTED);
        if (response?.ok) connected += 1;
      } catch {
        // Tab may still be loading; content will connect on its own.
      }
    } catch {
      // Restricted or discarded tab — skip.
    }
  }));

  return { tabs: tabs.length, connected, reinjected };
}
