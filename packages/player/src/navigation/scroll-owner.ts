export type ScrollOwner = "auto" | "manual" | "seek";

export interface ScrollOwnerState {
  readonly owner: ScrollOwner;
  readonly autoFollow: boolean;
  readonly manualScrollLocked: boolean;
  readonly manualScrollIdle: boolean;
  readonly manualScrollOutOfSync: boolean;
  readonly pendingSeekLineId: string | null;
  readonly revision: number;
  readonly lastReason: string;
}

export type ScrollOwnerEvent =
  | { readonly type: "reset"; readonly reason?: string }
  | { readonly type: "manual-scroll" }
  | { readonly type: "manual-idle"; readonly focusVisible: boolean }
  | {
      readonly type: "playback-focus";
      readonly focusLineId: string | null;
      readonly focusChanged: boolean;
      readonly focusVisible: boolean;
      readonly playing: boolean;
    }
  | { readonly type: "click-seek"; readonly lineId: string }
  | { readonly type: "seek-settled" }
  | { readonly type: "playback-replaced" }
  | { readonly type: "sync" };

export function createScrollOwnerState(): ScrollOwnerState {
  return Object.freeze({
    owner: "auto",
    autoFollow: true,
    manualScrollLocked: false,
    manualScrollIdle: false,
    manualScrollOutOfSync: false,
    pendingSeekLineId: null,
    revision: 0,
    lastReason: "initial-auto-follow",
  });
}

function updateState(
  state: ScrollOwnerState,
  patch: Partial<ScrollOwnerState>,
): ScrollOwnerState {
  return Object.freeze({
    ...state,
    ...patch,
    revision: Math.min(Number.MAX_SAFE_INTEGER, state.revision + 1),
  });
}

/** Pure owner reducer. Playback pause is intentionally not an event. */
export function advanceScrollOwner(
  state: ScrollOwnerState,
  event: ScrollOwnerEvent,
): ScrollOwnerState {
  switch (event.type) {
    case "reset":
      return Object.freeze({
        ...createScrollOwnerState(),
        revision: Math.min(Number.MAX_SAFE_INTEGER, state.revision + 1),
        lastReason: event.reason ?? "reset",
      });
    case "manual-scroll":
      return updateState(state, {
        owner: "manual",
        autoFollow: false,
        manualScrollLocked: true,
        manualScrollIdle: false,
        pendingSeekLineId: null,
        lastReason: "manual-scroll",
      });
    case "manual-idle":
      if (!state.manualScrollLocked) return state;
      return updateState(state, {
        owner: "manual",
        autoFollow: false,
        manualScrollIdle: true,
        manualScrollOutOfSync: !event.focusVisible,
        lastReason: event.focusVisible
          ? "manual-idle-focus-visible"
          : "manual-idle-out-of-sync",
      });
    case "playback-focus":
      if (
        state.manualScrollLocked &&
        state.manualScrollIdle &&
        event.playing &&
        event.focusChanged &&
        event.focusVisible
      ) {
        return updateState(state, {
          owner: "auto",
          autoFollow: true,
          manualScrollLocked: false,
          manualScrollIdle: false,
          manualScrollOutOfSync: false,
          lastReason: "visible-playback-focus-restored-auto-follow",
        });
      }
      return state;
    case "click-seek":
      return updateState(state, {
        owner: "seek",
        autoFollow: true,
        manualScrollLocked: false,
        manualScrollIdle: false,
        manualScrollOutOfSync: false,
        pendingSeekLineId: event.lineId,
        lastReason: "click-seek",
      });
    case "seek-settled":
      if (state.owner !== "seek" && state.pendingSeekLineId === null) {
        return state;
      }
      return updateState(state, {
        owner: "auto",
        autoFollow: true,
        pendingSeekLineId: null,
        lastReason: "seek-settled",
      });
    case "playback-replaced":
      if (state.owner !== "seek" && state.pendingSeekLineId === null) {
        return state;
      }
      return updateState(state, {
        owner: "auto",
        autoFollow: true,
        manualScrollLocked: false,
        manualScrollIdle: false,
        manualScrollOutOfSync: false,
        pendingSeekLineId: null,
        lastReason: "playback-binding-replaced",
      });
    case "sync":
      return updateState(state, {
        owner: "auto",
        autoFollow: true,
        manualScrollLocked: false,
        manualScrollIdle: false,
        manualScrollOutOfSync: false,
        pendingSeekLineId: null,
        lastReason: "explicit-sync",
      });
    default: {
      const exhaustiveEvent: never = event;
      return exhaustiveEvent;
    }
  }
}
