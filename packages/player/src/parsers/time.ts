import type {
  KnownLyricTimestampSource,
  LyricTimestamp,
} from "../domain/types.js";

export interface TimeExpressionOptions {
  readonly frameRate?: number;
  readonly subFrameRate?: number;
  readonly tickRate?: number;
}

const UNKNOWN_TIMESTAMP: LyricTimestamp = Object.freeze({
  valueMs: null,
  source: "unknown",
});

export function unknownTimestamp(): LyricTimestamp {
  return UNKNOWN_TIMESTAMP;
}

export function knownTimestamp(
  valueMs: number,
  source: KnownLyricTimestampSource = "source",
): LyricTimestamp {
  if (!Number.isFinite(valueMs)) return UNKNOWN_TIMESTAMP;
  return { valueMs, source };
}

export function isFiniteNonNegativeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function decimalSecondsToMs(value: string): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null;
  const milliseconds = Number(value) * 1_000;
  return Number.isFinite(milliseconds) ? Math.round(milliseconds) : null;
}

/** Parses an LRC timestamp body such as `03:12.45` or `03:12:450`. */
export function parseLrcTimestampMs(value: string): number | null {
  const match = /^(\d+):(\d{1,2})(?:[.:](\d+))?$/.exec(value.trim());
  if (!match) return null;

  const minutesText = match[1];
  const secondsText = match[2];
  if (minutesText === undefined || secondsText === undefined) return null;
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (!Number.isSafeInteger(minutes) || seconds >= 60) return null;

  const fractionText = match[3];
  const fractionalMs = fractionText
    ? decimalSecondsToMs(`0.${fractionText}`)
    : 0;
  if (fractionalMs === null) return null;

  const milliseconds = (minutes * 60 + seconds) * 1_000 + fractionalMs;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

/** Parses the `hh:mm:ss(.fraction)` clock form shared by TTML time expressions. */
export function parseClockTimeMs(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(
    value.trim(),
  );
  if (!match) return null;

  const hoursText = match[1] ?? "0";
  const minutesText = match[2];
  const secondsText = match[3];
  if (
    hoursText === undefined ||
    minutesText === undefined ||
    secondsText === undefined
  ) {
    return null;
  }
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (
    !Number.isSafeInteger(hours) ||
    !Number.isSafeInteger(minutes) ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return null;
  }

  const secondsMs = decimalSecondsToMs(secondsText);
  if (secondsMs === null) return null;
  const milliseconds = (hours * 3_600 + minutes * 60) * 1_000 + secondsMs;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function parseFrameClockMs(
  value: string,
  options: TimeExpressionOptions,
): number | null {
  const match = /^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.(\d+))?$/.exec(
    value.trim(),
  );
  if (!match) return null;

  const frameRate = options.frameRate;
  const subFrameRate = options.subFrameRate ?? 1;
  if (
    !isFiniteNonNegativeMs(frameRate) ||
    frameRate === 0 ||
    !isFiniteNonNegativeMs(subFrameRate) ||
    subFrameRate === 0
  ) {
    return null;
  }

  const hoursText = match[1];
  const minutesText = match[2];
  const secondsText = match[3];
  const framesText = match[4];
  if (
    hoursText === undefined ||
    minutesText === undefined ||
    secondsText === undefined ||
    framesText === undefined
  ) {
    return null;
  }
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  const frames = Number(framesText);
  const subFramesText = match[5];
  const subFrames = subFramesText ? Number(subFramesText) : 0;
  if (
    ![hours, minutes, seconds, frames, subFrames].every(Number.isSafeInteger) ||
    minutes >= 60 ||
    seconds >= 60 ||
    frames >= frameRate ||
    subFrames >= subFrameRate
  ) {
    return null;
  }

  const wholeSeconds = hours * 3_600 + minutes * 60 + seconds;
  const frameSeconds = (frames + subFrames / subFrameRate) / frameRate;
  const milliseconds = (wholeSeconds + frameSeconds) * 1_000;
  return Number.isFinite(milliseconds) ? Math.round(milliseconds) : null;
}

/** Parses TTML clock and offset time expressions without reading renderer state. */
export function parseTimeExpressionMs(
  value: string,
  options: TimeExpressionOptions = {},
): number | null {
  const input = value.trim();
  const clockTime = parseClockTimeMs(input);
  if (clockTime !== null) return clockTime;

  const frameClockTime = parseFrameClockMs(input, options);
  if (frameClockTime !== null) return frameClockTime;

  // Apple lyric TTML also uses bare decimal seconds.
  const bareSeconds = decimalSecondsToMs(input);
  if (bareSeconds !== null) return bareSeconds;

  const offset = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(h|m|s|ms|f|t)$/.exec(
    input,
  );
  if (!offset) return null;

  const countText = offset[1];
  const metric = offset[2];
  if (countText === undefined || metric === undefined) return null;
  const count = Number(countText);
  if (!Number.isFinite(count)) return null;

  let milliseconds: number;
  switch (metric) {
    case "h":
      milliseconds = count * 3_600_000;
      break;
    case "m":
      milliseconds = count * 60_000;
      break;
    case "s":
      milliseconds = count * 1_000;
      break;
    case "ms":
      milliseconds = count;
      break;
    case "f": {
      const frameRate = options.frameRate;
      if (!isFiniteNonNegativeMs(frameRate) || frameRate === 0) return null;
      milliseconds = (count / frameRate) * 1_000;
      break;
    }
    case "t": {
      const tickRate = options.tickRate;
      if (!isFiniteNonNegativeMs(tickRate) || tickRate === 0) return null;
      milliseconds = (count / tickRate) * 1_000;
      break;
    }
    default:
      return null;
  }

  return Number.isFinite(milliseconds) ? Math.round(milliseconds) : null;
}
