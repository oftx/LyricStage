/**
 * Best-effort platform seek from isolated content.
 * Prefer visible HTMLMediaElement; then NetEase window.player; then QQ progress bar.
 */

export type PlatformSeekResult = {
  readonly ok: boolean;
  readonly positionMs: number | null;
  readonly method: string;
  readonly reason?: string;
};

export type PlatformSeekContext = {
  readonly durationMs?: number | null;
};

function isSeekableMedia(el: HTMLMediaElement): boolean {
  return Number.isFinite(el.duration) && el.duration > 0 && el.readyState >= 1;
}

function pickMedia(): HTMLMediaElement | null {
  const nodes = [
    ...document.querySelectorAll<HTMLMediaElement>(
      'video.html5-main-video, #movie_player video, .html5-video-player video, audio, video',
    ),
  ];
  let best: HTMLMediaElement | null = null;
  let score = -1;
  for (const media of nodes) {
    if (!media.isConnected) continue;
    let s = 0;
    if (isSeekableMedia(media)) s += 10;
    if (!media.paused) s += 5;
    if (media.currentTime > 0) s += 2;
    if (media.tagName === 'VIDEO') s += 1;
    if (s > score) {
      best = media;
      score = s;
    }
  }
  return best;
}

function seekHtmlMedia(targetMs: number): PlatformSeekResult | null {
  const media = pickMedia();
  if (!media) return null;
  const seconds = Math.max(0, targetMs / 1000);
  try {
    const capped = Number.isFinite(media.duration) && media.duration > 0
      ? Math.min(seconds, Math.max(0, media.duration - 0.05))
      : seconds;
    media.currentTime = capped;
    return {
      ok: true,
      positionMs: Math.max(0, media.currentTime * 1000),
      method: 'html-media',
    };
  } catch (error) {
    return {
      ok: false,
      positionMs: null,
      method: 'html-media',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function seekNetease(targetMs: number): PlatformSeekResult | null {
  const player = (window as unknown as {
    player?: {
      seek?: (sec: number) => void;
      currentTime?: number;
    };
  }).player;
  if (!player || typeof player.seek !== 'function') return null;
  try {
    player.seek(Math.max(0, targetMs / 1000));
    const t = typeof player.currentTime === 'number' ? player.currentTime : targetMs / 1000;
    return { ok: true, positionMs: Math.max(0, t * 1000), method: 'netease-player' };
  } catch (error) {
    return {
      ok: false,
      positionMs: null,
      method: 'netease-player',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function seekProgressBar(targetMs: number, durationMs: number): PlatformSeekResult | null {
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return null;
  const selectors = [
    '.m-playbar .barbg',
    '.player_progress',
    '.player_progress__inner',
    '.mod_player .player_progress',
  ];
  let bar: Element | null = null;
  for (const sel of selectors) {
    bar = document.querySelector(sel);
    if (bar) break;
  }
  if (!(bar instanceof HTMLElement)) return null;
  const rect = bar.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 1) return null;
  const ratio = Math.min(1, Math.max(0, targetMs / durationMs));
  const x = rect.left + rect.width * ratio;
  const y = rect.top + rect.height / 2;
  try {
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    bar.dispatchEvent(new MouseEvent('mousedown', opts));
    bar.dispatchEvent(new MouseEvent('mouseup', opts));
    bar.dispatchEvent(new MouseEvent('click', opts));
    return {
      ok: true,
      positionMs: targetMs,
      method: 'progress-bar',
    };
  } catch (error) {
    return {
      ok: false,
      positionMs: null,
      method: 'progress-bar',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function seekPlatformTo(
  targetMs: number,
  context: PlatformSeekContext = {},
): PlatformSeekResult {
  if (!Number.isFinite(targetMs) || targetMs < 0) {
    return { ok: false, positionMs: null, method: 'none', reason: 'invalid-target' };
  }
  const media = seekHtmlMedia(targetMs);
  if (media?.ok) return media;
  const netease = seekNetease(targetMs);
  if (netease?.ok) return netease;
  const durationMs = context.durationMs
    ?? (media && null)
    ?? null;
  // Prefer live media duration when available.
  const mediaEl = pickMedia();
  const liveDuration = mediaEl && Number.isFinite(mediaEl.duration) && mediaEl.duration > 0
    ? mediaEl.duration * 1000
    : durationMs;
  const bar = liveDuration ? seekProgressBar(targetMs, liveDuration) : null;
  if (bar?.ok) return bar;
  if (media) return media;
  if (netease) return netease;
  if (bar) return bar;
  return { ok: false, positionMs: null, method: 'none', reason: 'no-seek-target' };
}
