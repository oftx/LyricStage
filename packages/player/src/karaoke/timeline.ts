export const KARAOKE_CJK_CONTINUATION_DURATION_MS = 500;

export type KaraokeTimelinePhase = "untimed" | "future" | "active" | "sung";

export interface KaraokeTimelineInput {
  readonly beginMs: number | null | undefined;
  readonly endMs: number | null | undefined;
  readonly positionMs: number;
}

export interface KaraokeTimelineSample {
  readonly phase: KaraokeTimelinePhase;
  readonly beginMs: number | null;
  readonly endMs: number | null;
  readonly durationMs: number | null;
  readonly positionMs: number | null;
  readonly progress: number;
  readonly elapsedSinceBeginMs: number;
  readonly elapsedAfterEndMs: number;
  readonly cjkContinuationElapsedMs: number;
  readonly cjkContinuationProgress: number;
  readonly cjkContinuationActive: boolean;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function untimedSample(input: KaraokeTimelineInput): KaraokeTimelineSample {
  return Object.freeze({
    phase: "untimed",
    beginMs: finite(input.beginMs) ? input.beginMs : null,
    endMs: finite(input.endMs) ? input.endMs : null,
    durationMs: null,
    positionMs: finite(input.positionMs) ? input.positionMs : null,
    progress: 0,
    elapsedSinceBeginMs: 0,
    elapsedAfterEndMs: 0,
    cjkContinuationElapsedMs: 0,
    cjkContinuationProgress: 0,
    cjkContinuationActive: false,
  });
}

/** Samples a half-open timed word interval without producing non-finite output. */
export function sampleKaraokeTimeline(
  input: KaraokeTimelineInput,
): KaraokeTimelineSample {
  const { beginMs, endMs, positionMs } = input;
  if (!finite(beginMs) || !finite(endMs) || !finite(positionMs)) {
    return untimedSample(input);
  }

  const durationMs = endMs - beginMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return untimedSample(input);
  }

  if (positionMs < beginMs) {
    return Object.freeze({
      phase: "future",
      beginMs,
      endMs,
      durationMs,
      positionMs,
      progress: 0,
      elapsedSinceBeginMs: 0,
      elapsedAfterEndMs: 0,
      cjkContinuationElapsedMs: 0,
      cjkContinuationProgress: 0,
      cjkContinuationActive: false,
    });
  }

  if (positionMs < endMs) {
    const elapsedSinceBeginMs = positionMs - beginMs;
    return Object.freeze({
      phase: "active",
      beginMs,
      endMs,
      durationMs,
      positionMs,
      progress: clampUnit(elapsedSinceBeginMs / durationMs),
      elapsedSinceBeginMs,
      elapsedAfterEndMs: 0,
      cjkContinuationElapsedMs: 0,
      cjkContinuationProgress: 0,
      cjkContinuationActive: false,
    });
  }

  const rawElapsedAfterEndMs = positionMs - endMs;
  const elapsedAfterEndMs = Number.isFinite(rawElapsedAfterEndMs)
    ? Math.max(0, rawElapsedAfterEndMs)
    : Number.MAX_VALUE;
  const cjkContinuationElapsedMs = Math.min(
    KARAOKE_CJK_CONTINUATION_DURATION_MS,
    elapsedAfterEndMs,
  );
  const cjkContinuationProgress = clampUnit(
    cjkContinuationElapsedMs / KARAOKE_CJK_CONTINUATION_DURATION_MS,
  );

  return Object.freeze({
    phase: "sung",
    beginMs,
    endMs,
    durationMs,
    positionMs,
    progress: 1,
    elapsedSinceBeginMs: durationMs,
    elapsedAfterEndMs,
    cjkContinuationElapsedMs,
    cjkContinuationProgress,
    cjkContinuationActive:
      elapsedAfterEndMs < KARAOKE_CJK_CONTINUATION_DURATION_MS,
  });
}
