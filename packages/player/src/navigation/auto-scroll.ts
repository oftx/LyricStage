import type { LyricTimeIndex } from "../domain/time-index.js";
import type { LyricDocument, LyricLine } from "../domain/types.js";

export const LINE_MOVE_MIN_GAP_MS = 200;
export const LINE_MOVE_MAX_GAP_MS = 750;
export const LINE_MOVE_MIN_DURATION_MS = 480;
export const LINE_MOVE_MAX_DURATION_MS = 750;
export const ROW_MOVE_STAGGER_MS = Object.freeze([25, 44, 56, 63]);
// Keep the focused line a little farther below the viewport's top edge. This
// is the shared auto-scroll anchor used by playback and seek positioning; a
// ratio keeps the visual baseline proportional across player sizes without
// changing row geometry or secondary-lane layout.
export const LYRIC_TOP_RATIO = 0.1;
export const LYRIC_TEXT_PADDING_TOP_PX = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteTime(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function previousPlayableLine(
  lines: readonly LyricLine[],
  index: number,
): LyricLine | null {
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const line = lines[candidate];
    if (line && line.type !== "credit") return line;
  }
  return null;
}

export function lineMoveDurationForGap(gapMs: number): number {
  if (!Number.isFinite(gapMs)) return LINE_MOVE_MAX_DURATION_MS;
  const progress =
    (clamp(gapMs, LINE_MOVE_MIN_GAP_MS, LINE_MOVE_MAX_GAP_MS) -
      LINE_MOVE_MIN_GAP_MS) /
    (LINE_MOVE_MAX_GAP_MS - LINE_MOVE_MIN_GAP_MS);
  return Math.round(
    LINE_MOVE_MIN_DURATION_MS +
      (LINE_MOVE_MAX_DURATION_MS - LINE_MOVE_MIN_DURATION_MS) * progress,
  );
}

export interface ResolveLineMoveDurationOptions {
  /**
   * When `false`, always use the fixed line-timed duration (750ms).
   * When `true`, gap-scale like word karaoke even if the document is mixed.
   * When omitted, auto: gap-scale only if the document contains karaoke lines.
   *
   * UI “整行” display mode must pass `false` so forced line mode matches native
   * line-timed intervals even when the source document is word-timed.
   */
  readonly gapScale?: boolean;
}

export function resolveLineMoveDuration(
  document: LyricDocument,
  focusLineId: string | null,
  options: ResolveLineMoveDurationOptions = {},
): number {
  if (!focusLineId) return LINE_MOVE_MAX_DURATION_MS;
  const focusIndex = document.lines.findIndex((line) => line.id === focusLineId);
  if (focusIndex < 0) return LINE_MOVE_MAX_DURATION_MS;
  const focus = document.lines[focusIndex];
  const previous = previousPlayableLine(document.lines, focusIndex);
  if (!focus || !previous || previous.type === "instrumental") {
    return LINE_MOVE_MAX_DURATION_MS;
  }
  // Match am: only word-timed karaoke gap-scales the FLIP. Pure line-timed /
  // LRC (and UI-forced 整行) always use the fixed max duration so tight
  // successive lines do not look rushed, and karaoke→line mode switches keep
  // the same interval language as native whole-line lyrics.
  const wordTimedAdapter =
    options.gapScale === true
      ? true
      : options.gapScale === false
        ? false
        : document.lines.some((line) => line.type === "karaoke");
  if (!wordTimedAdapter) return LINE_MOVE_MAX_DURATION_MS;
  const beginMs = finiteTime(focus.begin.valueMs);
  const endMs = finiteTime(previous.end.valueMs);
  if (beginMs === null || endMs === null) return LINE_MOVE_MAX_DURATION_MS;
  return lineMoveDurationForGap(beginMs - endMs);
}

export interface KaraokeLinePreAnchor {
  readonly targetLineId: string;
  /** The only active predecessor whose tail may be led into this motion. */
  readonly previousLineId: string;
  readonly authoredBeginMs: number;
  readonly moveDurationMs: number;
  readonly remainingMediaDurationMs: number;
  readonly startingLineIdsInSourceOrder: readonly string[];
}

/**
 * Advances the visual line event so row motion settles at the authored word
 * boundary while the karaoke word clock remains on real playback time.
 */
export function resolveKaraokeLinePreAnchor(
  document: LyricDocument,
  timeIndex: LyricTimeIndex,
  playbackPositionMs: number,
): KaraokeLinePreAnchor | null {
  if (!Number.isFinite(playbackPositionMs)) return null;
  const activeNow = timeIndex.findActiveAt(playbackPositionMs);
  if (activeNow.some(({ line }) => line.type === "instrumental")) {
    return null;
  }

  const nextPlayable = timeIndex.entries.find(
    ({ line, beginMs }) =>
      beginMs > playbackPositionMs && line.type !== "credit",
  );
  if (!nextPlayable) return null;

  const nextBeginMs = nextPlayable.beginMs;
  // Geometry-only lead-in is for word-timed karaoke: the word clock stays on
  // real time while rows ease to the next dock. Line-timed / LRC hand off at
  // the authored boundary with the full gap-scaled FLIP (no early lead) —
  // applying pre-anchor there made the previous line scroll away mid-phrase,
  // and "fixing" that by compressing lead made the motion snappy.
  const target = timeIndex.entries.find(
    ({ line, beginMs }) =>
      beginMs === nextBeginMs && line.type === "karaoke",
  );
  if (!target) return null;

  const previous = previousPlayableLine(
    document.lines,
    target.documentIndex,
  );
  if (!previous || previous.type === "instrumental") return null;
  const realActiveLines = activeNow.filter(
    ({ line }) => line.type !== "instrumental" && line.type !== "credit",
  );
  // Layout may lead the immediately preceding line's final tail so the
  // target row reaches its dock at the authored boundary. Do not project
  // through a concurrent/other active cohort: that would prematurely change
  // duet or secondary ownership instead of only moving the row geometry.
  if (realActiveLines.some(({ line }) => line.id !== previous.id)) {
    return null;
  }
  const previousEndMs = finiteTime(previous.end.valueMs);
  if (
    previousEndMs === null ||
    target.beginMs - previousEndMs < LINE_MOVE_MIN_GAP_MS
  ) {
    return null;
  }

  const moveDurationMs = resolveLineMoveDuration(document, target.line.id, {
    gapScale: true,
  });
  const plannedStartMs = target.beginMs - moveDurationMs;
  if (
    playbackPositionMs < plannedStartMs ||
    playbackPositionMs >= target.beginMs
  ) {
    return null;
  }

  const startingLineIdsInSourceOrder = Object.freeze(
    timeIndex
      .entries.filter(({ beginMs }) => beginMs === target.beginMs)
      .filter(
        ({ line }) =>
          line.type !== "instrumental" && line.type !== "credit",
      )
      .map(({ line }) => line.id),
  );
  if (!startingLineIdsInSourceOrder.includes(target.line.id)) return null;

  return Object.freeze({
    targetLineId: target.line.id,
    previousLineId: previous.id,
    authoredBeginMs: target.beginMs,
    moveDurationMs,
    remainingMediaDurationMs: Math.max(
      0,
      target.beginMs - playbackPositionMs,
    ),
    startingLineIdsInSourceOrder,
  });
}

export function resolveLyricTopOffset(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  return Math.max(
    0,
    Math.round(viewportHeight * LYRIC_TOP_RATIO) - LYRIC_TEXT_PADDING_TOP_PX,
  );
}

export function resolveRowMoveDelay(
  adapterIndex: number,
  anchorAdapterIndex: number,
  displaced: boolean,
): number {
  if (!displaced || adapterIndex <= anchorAdapterIndex) return 0;
  const distance = Math.min(
    ROW_MOVE_STAGGER_MS.length,
    adapterIndex - anchorAdapterIndex,
  );
  return ROW_MOVE_STAGGER_MS[distance - 1] ?? 0;
}

export function isElementFullyVisible(
  element: Element,
  viewport: Element,
  tolerancePx = 0.5,
): boolean {
  const elementRect = element.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  return (
    elementRect.height > 0 &&
    elementRect.top >= viewportRect.top - tolerancePx &&
    elementRect.bottom <= viewportRect.bottom + tolerancePx
  );
}

export function findFirstFullyVisibleRow(
  viewport: Element,
  rows: readonly HTMLElement[],
): HTMLElement | null {
  for (const row of rows) {
    if (isElementFullyVisible(row, viewport)) return row;
  }
  return null;
}

export interface ScrollAnchorSnapshot {
  readonly lineId: string;
  readonly viewportOffsetPx: number;
}

export function captureScrollAnchor(
  viewport: Element,
  row: HTMLElement | null,
): ScrollAnchorSnapshot | null {
  const lineId = row?.dataset.lineId;
  if (!row || !lineId) return null;
  const viewportRect = viewport.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  return Object.freeze({
    lineId,
    viewportOffsetPx: rowRect.top - viewportRect.top,
  });
}

export function restoreScrollAnchor(
  viewport: HTMLElement,
  row: HTMLElement | null,
  anchor: ScrollAnchorSnapshot | null,
): number {
  if (!row || !anchor || row.dataset.lineId !== anchor.lineId) return 0;
  const viewportRect = viewport.getBoundingClientRect();
  const currentOffset = row.getBoundingClientRect().top - viewportRect.top;
  const delta = currentOffset - anchor.viewportOffsetPx;
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return 0;
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const nextScrollTop = clamp(viewport.scrollTop + delta, 0, maxScrollTop);
  const applied = nextScrollTop - viewport.scrollTop;
  viewport.scrollTop = nextScrollTop;
  return applied;
}
