import type { PlaybackFrameMode } from "../playback/create-playback-frame.js";

export type KaraokeLiftPhase =
  | "not-participating"
  | "idle"
  | "lifting"
  | "held";
export type KaraokeLiftMotionProfile = "default" | "han-kana";

export interface KaraokeLiftState {
  readonly bindingId: string;
  readonly phase: KaraokeLiftPhase;
  readonly positionPx: number;
  readonly velocityPxPerSecond: number;
  readonly targetPx: number;
  readonly activated: boolean;
}

export interface KaraokeLiftSampleInput {
  readonly bindingId: string;
  readonly beginMs: number;
  readonly endMs: number;
  readonly playbackPositionMs: number;
  readonly lineActive: boolean;
  readonly participates: boolean;
  readonly frameMode: PlaybackFrameMode;
  readonly deltaMs: number;
  readonly motionProfile?: KaraokeLiftMotionProfile;
  readonly reducedMotion?: boolean;
}

const TARGET_PX = -2;
const DEFAULT_STIFFNESS = 25;
const DAMPING_RATIO = 0.93;
const HAN_KANA_MIN_DURATION_MS = 180;
const HAN_KANA_MAX_DURATION_MS = 900;
const HAN_KANA_SHORT_STIFFNESS = 18;
const HAN_KANA_LONG_STIFFNESS = 10;
const HAN_KANA_LIFT_DELAY_MS = 60;
const MAX_STEP_SECONDS = 0.05;
const SETTLE_DISTANCE_PX = 0.03;
const SETTLE_VELOCITY_PX_PER_SECOND = 0.03;

function createState(
  bindingId: string,
  phase: KaraokeLiftPhase,
  positionPx: number,
  velocityPxPerSecond: number,
  targetPx: number,
  activated: boolean,
): KaraokeLiftState {
  return Object.freeze({
    bindingId,
    phase,
    positionPx,
    velocityPxPerSecond,
    targetPx,
    activated,
  });
}

export function createIdleKaraokeLiftState(
  bindingId: string,
): KaraokeLiftState {
  return createState(bindingId, "idle", 0, 0, 0, false);
}

function hasValidTiming(input: KaraokeLiftSampleInput): boolean {
  return (
    Number.isFinite(input.beginMs) &&
    Number.isFinite(input.endMs) &&
    Number.isFinite(input.playbackPositionMs)
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(progress: number): number {
  const value = clamp(progress, 0, 1);
  return value * value * (3 - 2 * value);
}

function resolveStiffness(input: KaraokeLiftSampleInput): number {
  if (input.motionProfile !== "han-kana") return DEFAULT_STIFFNESS;
  const durationMs = input.endMs - input.beginMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return DEFAULT_STIFFNESS;
  }
  const durationProgress =
    (clamp(
      durationMs,
      HAN_KANA_MIN_DURATION_MS,
      HAN_KANA_MAX_DURATION_MS,
    ) -
      HAN_KANA_MIN_DURATION_MS) /
    (HAN_KANA_MAX_DURATION_MS - HAN_KANA_MIN_DURATION_MS);
  const easedDuration = smoothstep(durationProgress);
  return (
    HAN_KANA_SHORT_STIFFNESS +
    (HAN_KANA_LONG_STIFFNESS - HAN_KANA_SHORT_STIFFNESS) * easedDuration
  );
}

function resolveLiftBeginMs(input: KaraokeLiftSampleInput): number {
  return (
    input.beginMs +
    (input.motionProfile === "han-kana" ? HAN_KANA_LIFT_DELAY_MS : 0)
  );
}

function settleForPosition(
  input: KaraokeLiftSampleInput,
): KaraokeLiftState {
  if (!input.participates) {
    return createState(input.bindingId, "not-participating", 0, 0, 0, false);
  }
  if (
    !hasValidTiming(input) ||
    input.playbackPositionMs <= resolveLiftBeginMs(input)
  ) {
    return createIdleKaraokeLiftState(input.bindingId);
  }

  if (!input.lineActive) return createIdleKaraokeLiftState(input.bindingId);
  const phase = input.playbackPositionMs >= input.endMs ? "held" : "lifting";
  return createState(input.bindingId, phase, TARGET_PX, 0, TARGET_PX, true);
}

export function sampleKaraokeLift(
  previous: KaraokeLiftState | null,
  input: KaraokeLiftSampleInput,
): KaraokeLiftState {
  const prior =
    previous?.bindingId === input.bindingId
      ? previous
      : createIdleKaraokeLiftState(input.bindingId);

  if (input.frameMode === "reset" || input.frameMode === "recycle") {
    return input.participates
      ? createIdleKaraokeLiftState(input.bindingId)
      : createState(input.bindingId, "not-participating", 0, 0, 0, false);
  }

  if (
    input.frameMode !== "playback" ||
    input.reducedMotion ||
    !Number.isFinite(input.deltaMs) ||
    input.deltaMs < 0
  ) {
    return settleForPosition(input);
  }
  if (!input.participates) {
    return createState(input.bindingId, "not-participating", 0, 0, 0, false);
  }
  if (
    !hasValidTiming(input) ||
    input.playbackPositionMs <= resolveLiftBeginMs(input)
  ) {
    return createIdleKaraokeLiftState(input.bindingId);
  }

  const activated =
    prior.activated ||
    input.lineActive;
  if (!activated) return createIdleKaraokeLiftState(input.bindingId);

  const deltaSeconds = Math.min(input.deltaMs / 1_000, MAX_STEP_SECONDS);
  const stiffness = resolveStiffness(input);
  const damping = 2 * DAMPING_RATIO * Math.sqrt(stiffness);
  const acceleration =
    -stiffness * (prior.positionPx - TARGET_PX) -
    damping * prior.velocityPxPerSecond;
  let velocityPxPerSecond =
    prior.velocityPxPerSecond + acceleration * deltaSeconds;
  let positionPx = prior.positionPx + velocityPxPerSecond * deltaSeconds;
  if (
    Math.abs(positionPx - TARGET_PX) < SETTLE_DISTANCE_PX &&
    Math.abs(velocityPxPerSecond) < SETTLE_VELOCITY_PX_PER_SECOND
  ) {
    positionPx = TARGET_PX;
    velocityPxPerSecond = 0;
  }

  const held =
    input.playbackPositionMs >= input.endMs || positionPx === TARGET_PX;
  return createState(
    input.bindingId,
    held ? "held" : "lifting",
    positionPx,
    velocityPxPerSecond,
    TARGET_PX,
    true,
  );
}
