import type { PageClockPort, PageClockSample } from '@lyric-stage/platform-adapters';

const CHANNEL = 'lyric-stage-page-clock-v1';
const PROTOCOL_VERSION = 1;
/** Active playback poll — enough for free-run correction without 5–10 Hz waste. */
const POLL_INTERVAL_PLAYING_MS = 250;
const POLL_INTERVAL_PAUSED_MS = 1_000;
const POLL_INTERVAL_HIDDEN_MS = 2_000;
const REQUEST_TIMEOUT_MS = 900;

export type PageClockSeekResult = {
  readonly ok: boolean;
  readonly positionMs: number | null;
  readonly method: string;
  readonly reason?: string;
};

export interface PageClockClient extends PageClockPort {
  start(): Promise<boolean>;
  stop(): void;
  seek(targetMs: number): Promise<PageClockSeekResult>;
  readonly installed: boolean;
}

/**
 * Talks to the MAIN-world page-clock bridge installed as a content script
 * (page-clock-main.js). No service-worker executeScript required for the
 * happy path — only postMessage on the same window.
 */
export function createPageClockClient(options?: {
  readonly now?: () => number;
  /** Override active (playing/visible) poll interval. */
  readonly pollIntervalMs?: number;
}): PageClockClient {
  const now = options?.now ?? (() => performance.now());
  const playingPollMs = options?.pollIntervalMs ?? POLL_INTERVAL_PLAYING_MS;
  const bridgeInstanceId = `bridge:${crypto.randomUUID()}`;
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  let sequence = 0;
  let installed = false;
  let stopped = false;
  let latest: PageClockSample | null = null;
  let pollTimer: number | null = null;
  let currentPollMs = playingPollMs;
  let pending = false;
  let consecutiveFailures = 0;
  const pendingResolvers = new Map<string, {
    resolve: (value: boolean) => void;
    timer: number;
  }>();
  const seekResolvers = new Map<string, {
    resolve: (value: PageClockSeekResult) => void;
    timer: number;
  }>();

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function handleMessage(event: MessageEvent<unknown>): void {
    if (
      event.source !== window
      || (event.origin && event.origin !== window.location.origin)
      || !isRecord(event.data)
    ) {
      return;
    }
    const message = event.data;
    if (
      message.channel !== CHANNEL
      || message.protocolVersion !== PROTOCOL_VERSION
      || message.direction !== 'main-to-isolated'
      || message.bridgeInstanceId !== bridgeInstanceId
      || message.nonce !== nonce
      || typeof message.requestId !== 'string'
    ) {
      return;
    }

    const waiter = pendingResolvers.get(message.requestId);
    if (waiter) {
      window.clearTimeout(waiter.timer);
      pendingResolvers.delete(message.requestId);
      waiter.resolve(true);
    }
    pending = false;

    if (!isRecord(message.result)) return;

    if (message.result.type === 'seek-result') {
      const seekWaiter = seekResolvers.get(message.requestId);
      if (!seekWaiter) return;
      window.clearTimeout(seekWaiter.timer);
      seekResolvers.delete(message.requestId);
      const ok = message.result.ok === true;
      const positionMs = typeof message.result.positionMs === 'number'
        ? message.result.positionMs
        : null;
      const method = typeof message.result.method === 'string'
        ? message.result.method
        : 'none';
      const reason = typeof message.result.reason === 'string'
        ? message.result.reason
        : undefined;
      seekWaiter.resolve({
        ok,
        positionMs,
        method,
        ...(reason ? { reason } : {}),
      });
      return;
    }

    if (message.result.type !== 'clock-sample') return;
    const result = message.result;
    if (result.available !== true) return;
    if (
      (result.sourceKind !== 'media-element' && result.sourceKind !== 'platform-api')
      || typeof result.positionMs !== 'number'
      || !Number.isFinite(result.positionMs)
      || (typeof result.durationMs !== 'number' && result.durationMs !== null)
      || typeof result.rate !== 'number'
      || typeof result.seeking !== 'boolean'
      || typeof result.confidence !== 'number'
      || (
        result.mediaExternalIdHint !== null
        && typeof result.mediaExternalIdHint !== 'string'
      )
      || typeof result.playbackState !== 'string'
    ) {
      return;
    }
    const playbackState = result.playbackState;
    if (
      playbackState !== 'playing'
      && playbackState !== 'paused'
      && playbackState !== 'ended'
      && playbackState !== 'buffering'
      && playbackState !== 'unavailable'
    ) {
      return;
    }

    consecutiveFailures = 0;
    installed = true;
    latest = {
      positionMs: Math.max(0, result.positionMs),
      durationMs: typeof result.durationMs === 'number' ? result.durationMs : null,
      playbackState,
      rate: result.rate,
      seeking: result.seeking,
      sourceKind: result.sourceKind,
      confidence: result.confidence,
      mediaExternalIdHint: typeof result.mediaExternalIdHint === 'string'
        ? result.mediaExternalIdHint
        : null,
      capturedAtMs: now(),
    };
  }

  function post(command: Record<string, unknown>): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    sequence += 1;
    const requestId = `req:${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pendingResolvers.delete(requestId);
        pending = false;
        consecutiveFailures += 1;
        resolve(false);
      }, REQUEST_TIMEOUT_MS);
      pendingResolvers.set(requestId, { resolve, timer });
      pending = true;
      try {
        window.postMessage({
          channel: CHANNEL,
          protocolVersion: PROTOCOL_VERSION,
          direction: 'isolated-to-main',
          bridgeInstanceId,
          nonce,
          sequence,
          requestId,
          command,
        }, window.location.origin);
      } catch {
        window.clearTimeout(timer);
        pendingResolvers.delete(requestId);
        pending = false;
        consecutiveFailures += 1;
        resolve(false);
      }
    });
  }

  function resolvePollIntervalMs(): number {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return POLL_INTERVAL_HIDDEN_MS;
    }
    const state = latest?.playbackState;
    if (state === 'playing' || state === 'buffering') {
      return playingPollMs;
    }
    return POLL_INTERVAL_PAUSED_MS;
  }

  function clearPollTimer(): void {
    if (pollTimer === null) return;
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function armPollTimer(intervalMs: number): void {
    clearPollTimer();
    currentPollMs = intervalMs;
    pollTimer = window.setInterval(() => {
      if (pending || stopped) return;
      const nextMs = resolvePollIntervalMs();
      if (nextMs !== currentPollMs) {
        armPollTimer(nextMs);
        return;
      }
      void post({ type: 'read-clock' });
    }, intervalMs);
  }

  function startPolling(): void {
    if (pollTimer !== null) return;
    armPollTimer(resolvePollIntervalMs());
  }

  function onVisibilityChange(): void {
    if (stopped || pollTimer === null) return;
    const nextMs = resolvePollIntervalMs();
    if (nextMs !== currentPollMs) armPollTimer(nextMs);
  }

  async function start(): Promise<boolean> {
    stopped = false;
    window.addEventListener('message', handleMessage);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const ok = await post({ type: 'read-clock' });
    installed = ok || consecutiveFailures < 3;
    startPolling();
    if (!ok) {
      for (const delay of [50, 150, 400, 1000]) {
        await new Promise((r) => {
          window.setTimeout(r, delay);
        });
        if (stopped) return false;
        const retry = await post({ type: 'read-clock' });
        if (retry) {
          installed = true;
          return true;
        }
      }
    }
    return installed;
  }

  async function seek(targetMs: number): Promise<PageClockSeekResult> {
    if (stopped) {
      return {
        ok: false,
        positionMs: null,
        method: 'none',
        reason: 'stopped',
      };
    }
    if (!installed) {
      await start();
    }
    sequence += 1;
    const requestId = `req:${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        seekResolvers.delete(requestId);
        resolve({
          ok: false,
          positionMs: null,
          method: 'none',
          reason: 'seek-timeout',
        });
      }, REQUEST_TIMEOUT_MS);
      seekResolvers.set(requestId, { resolve, timer });
      try {
        window.postMessage({
          channel: CHANNEL,
          protocolVersion: PROTOCOL_VERSION,
          direction: 'isolated-to-main',
          bridgeInstanceId,
          nonce,
          sequence,
          requestId,
          command: { type: 'seek', targetMs },
        }, window.location.origin);
      } catch {
        window.clearTimeout(timer);
        seekResolvers.delete(requestId);
        resolve({
          ok: false,
          positionMs: null,
          method: 'none',
          reason: 'post-failed',
        });
      }
    });
  }

  return {
    get installed() {
      return installed;
    },
    getLatestSample() {
      return latest;
    },
    start,
    seek,
    stop() {
      stopped = true;
      clearPollTimer();
      window.removeEventListener('message', handleMessage);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      for (const waiter of pendingResolvers.values()) {
        window.clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
      pendingResolvers.clear();
      for (const waiter of seekResolvers.values()) {
        window.clearTimeout(waiter.timer);
        waiter.resolve({
          ok: false,
          positionMs: null,
          method: 'none',
          reason: 'stopped',
        });
      }
      seekResolvers.clear();
      installed = false;
      latest = null;
    },
  };
}
