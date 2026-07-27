export type SecondaryTextUpdateSource =
  | "ui"
  | "api"
  | "debug"
  | "rollback";

export interface SecondaryTextVisibilityState {
  readonly translationVisible: boolean;
  readonly pronunciationVisible: boolean;
}

export interface SecondaryTextTransitionState
  extends SecondaryTextVisibilityState {
  readonly revision: number;
  readonly cooldownUntilMs: number;
  readonly lastAcceptedAtMs: number | null;
  readonly lastRejectedAtMs: number | null;
  readonly lastSource: SecondaryTextUpdateSource | null;
}

export interface SecondaryTextTransitionRequest
  extends SecondaryTextVisibilityState {
  readonly source: SecondaryTextUpdateSource;
  readonly nowMs: number;
}

export interface SecondaryTextTransitionResult {
  readonly accepted: boolean;
  readonly changed: boolean;
  readonly translationChanged: boolean;
  readonly pronunciationChanged: boolean;
  readonly cooldownActive: boolean;
  readonly layoutDurationMs: number;
  readonly state: SecondaryTextTransitionState;
  readonly reason:
    | "accepted-change"
    | "unchanged"
    | "translation-ui-cooldown";
}

export const TRANSLATION_TOGGLE_COOLDOWN_MS = 450;
export const SECONDARY_TEXT_LAYOUT_DURATION_MS = 420;

function safeNow(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function createSecondaryTextTransitionState(
  visibility: SecondaryTextVisibilityState = {
    translationVisible: true,
    pronunciationVisible: true,
  },
): SecondaryTextTransitionState {
  return Object.freeze({
    ...visibility,
    revision: 0,
    cooldownUntilMs: 0,
    lastAcceptedAtMs: null,
    lastRejectedAtMs: null,
    lastSource: null,
  });
}

export function isTranslationToggleCooldownActive(
  state: SecondaryTextTransitionState,
  nowMs: number,
): boolean {
  return safeNow(nowMs) < state.cooldownUntilMs;
}

export function requestSecondaryTextTransition(
  state: SecondaryTextTransitionState,
  request: SecondaryTextTransitionRequest,
): SecondaryTextTransitionResult {
  const nowMs = safeNow(request.nowMs);
  const translationChanged =
    request.translationVisible !== state.translationVisible;
  const pronunciationChanged =
    request.pronunciationVisible !== state.pronunciationVisible;
  const changed = translationChanged || pronunciationChanged;
  const cooldownActive = isTranslationToggleCooldownActive(state, nowMs);

  if (
    request.source === "ui" &&
    translationChanged &&
    cooldownActive
  ) {
    const next = Object.freeze({
      ...state,
      lastRejectedAtMs: nowMs,
      lastSource: request.source,
    });
    return Object.freeze({
      accepted: false,
      changed: false,
      translationChanged,
      pronunciationChanged,
      cooldownActive: true,
      layoutDurationMs: 0,
      state: next,
      reason: "translation-ui-cooldown",
    });
  }

  if (!changed) {
    return Object.freeze({
      accepted: true,
      changed: false,
      translationChanged: false,
      pronunciationChanged: false,
      cooldownActive,
      layoutDurationMs: 0,
      state,
      reason: "unchanged",
    });
  }

  const next = Object.freeze({
    translationVisible: request.translationVisible,
    pronunciationVisible: request.pronunciationVisible,
    revision: Math.min(Number.MAX_SAFE_INTEGER, state.revision + 1),
    cooldownUntilMs:
      request.source === "ui" && translationChanged
        ? nowMs + TRANSLATION_TOGGLE_COOLDOWN_MS
        : state.cooldownUntilMs,
    lastAcceptedAtMs: nowMs,
    lastRejectedAtMs: state.lastRejectedAtMs,
    lastSource: request.source,
  });
  return Object.freeze({
    accepted: true,
    changed: true,
    translationChanged,
    pronunciationChanged,
    cooldownActive: isTranslationToggleCooldownActive(next, nowMs),
    layoutDurationMs: SECONDARY_TEXT_LAYOUT_DURATION_MS,
    state: next,
    reason: "accepted-change",
  });
}

export function resetSecondaryTextTransition(
  state: SecondaryTextTransitionState,
): SecondaryTextTransitionState {
  return Object.freeze({
    ...state,
    revision: Math.min(Number.MAX_SAFE_INTEGER, state.revision + 1),
    cooldownUntilMs: 0,
    lastRejectedAtMs: null,
    lastSource: "rollback",
  });
}
