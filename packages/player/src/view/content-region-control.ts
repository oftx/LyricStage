import {
  DEFAULT_LYRICS_CONTENT_REGION,
  moveIndependentLyricsContentRegionHandle,
  moveLinkedLyricsContentRegionHandle,
  normalizeLyricsContentRegion,
  translateLyricsContentRegion,
  type LyricsContentRegion,
  type LyricsContentRegionHandle,
} from "./content-region.js";

export type LyricsContentRegionControlSource = "pointer" | "keyboard";

export type LyricsContentRegionControlOperation =
  | "linked"
  | "independent"
  | "translate";

export interface LyricsContentRegionControlEvent {
  readonly region: LyricsContentRegion;
  readonly originRegion: LyricsContentRegion;
  readonly source: LyricsContentRegionControlSource;
  readonly operation: LyricsContentRegionControlOperation;
  readonly handle: LyricsContentRegionHandle | null;
}

export interface LyricsContentRegionControlOptions {
  readonly document: Document;
  readonly initialRegion?: LyricsContentRegion;
  readonly minSpanRatio?: number;
  readonly initialVisible?: boolean;
  readonly stepRatio?: number;
  readonly largeStepRatio?: number;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly onStart?: (event: LyricsContentRegionControlEvent) => void;
  readonly onInput?: (event: LyricsContentRegionControlEvent) => void;
  readonly onCommit?: (event: LyricsContentRegionControlEvent) => void;
  readonly onCancel?: (event: LyricsContentRegionControlEvent) => void;
}

export interface LyricsContentRegionControlState {
  readonly region: LyricsContentRegion;
  readonly visible: boolean;
  readonly interaction: "idle" | LyricsContentRegionControlSource;
  readonly operation: LyricsContentRegionControlOperation | null;
  readonly activeHandle: LyricsContentRegionHandle | null;
  readonly destroyed: boolean;
}

export interface LyricsContentRegionControl {
  readonly element: HTMLElement;
  getState(): LyricsContentRegionControlState;
  setRegion(region: LyricsContentRegion): void;
  setVisible(visible: boolean): void;
  commitInteraction(): void;
  cancelInteraction(): void;
  destroy(): void;
}

interface PointerGesture {
  readonly source: "pointer";
  readonly pointerId: number;
  readonly pointerType: string;
  readonly captureElement: HTMLElement;
  readonly originRegion: LyricsContentRegion;
  readonly handle: LyricsContentRegionHandle | null;
  readonly trackLeftPx: number;
  readonly trackWidthPx: number;
  baselineRegion: LyricsContentRegion;
  baselinePointerRatio: number;
  grabOffsetRatio: number;
  lastClientX: number;
  operation: LyricsContentRegionControlOperation;
}

interface KeyboardGesture {
  readonly source: "keyboard";
  readonly originRegion: LyricsContentRegion;
  readonly targetElement: HTMLElement;
  readonly handle: LyricsContentRegionHandle | null;
  operation: LyricsContentRegionControlOperation;
}

type ActiveGesture = PointerGesture | KeyboardGesture;

interface PointerProximitySample {
  readonly clientX: number;
  readonly clientY: number;
}

const DEFAULT_STEP_RATIO = 0.01;
const DEFAULT_LARGE_STEP_RATIO = 0.05;
const CONTROL_PROXIMITY_ENTER_PX = 12;
const CONTROL_PROXIMITY_EXIT_PX = 26;
const HANDLE_PROXIMITY_ENTER_PX = 12;
const HANDLE_PROXIMITY_EXIT_PX = 22;
const RANGE_PROXIMITY_ENTER_PX = 6;
const RANGE_PROXIMITY_EXIT_PX = 12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteUnit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value)
    ? clamp(value, 0, 1)
    : fallback;
}

function regionsEqual(
  left: LyricsContentRegion,
  right: LyricsContentRegion,
): boolean {
  return left.left === right.left && left.right === right.right;
}

function pointNearRect(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  paddingPx: number,
): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    clientX >= rect.left - paddingPx &&
    clientX <= rect.right + paddingPx &&
    clientY >= rect.top - paddingPx &&
    clientY <= rect.bottom + paddingPx
  );
}

function percentage(value: number): string {
  return String(Number((value * 100).toFixed(3)));
}

function regionValueText(region: LyricsContentRegion): string {
  return `${percentage(region.left)}% to ${percentage(region.right)}%`;
}

function eventForGesture(
  gesture: ActiveGesture,
  region: LyricsContentRegion,
): LyricsContentRegionControlEvent {
  return Object.freeze({
    region,
    originRegion: gesture.originRegion,
    source: gesture.source,
    operation: gesture.operation,
    handle: gesture.handle,
  });
}

function defaultNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

class LyricsContentRegionControlImpl implements LyricsContentRegionControl {
  readonly element: HTMLElement;
  readonly #track: HTMLElement;
  readonly #selection: HTMLElement;
  readonly #leftHandle: HTMLButtonElement;
  readonly #rightHandle: HTMLButtonElement;
  readonly #events = new AbortController();
  readonly #minSpanRatio: number;
  readonly #stepRatio: number;
  readonly #largeStepRatio: number;
  readonly #requestFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelFrame: (handle: number) => void;
  readonly #onStart: LyricsContentRegionControlOptions["onStart"];
  readonly #onInput: LyricsContentRegionControlOptions["onInput"];
  readonly #onCommit: LyricsContentRegionControlOptions["onCommit"];
  readonly #onCancel: LyricsContentRegionControlOptions["onCancel"];
  readonly #window: Window | null;
  #region: LyricsContentRegion;
  #visible: boolean;
  #gesture: ActiveGesture | null = null;
  #pendingInput: LyricsContentRegionControlEvent | null = null;
  #inputFrame: number | null = null;
  #pendingProximity: PointerProximitySample | null = null;
  #proximityFrame: number | null = null;
  #controlNear = false;
  #handlesNear = false;
  #rangeNear = false;
  #controlPressed = false;
  #metaPressed = false;
  #destroyed = false;

  readonly #handleWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.#gesture) {
      event.preventDefault();
      this.#cancelGesture(true);
      return;
    }
    if (event.key !== "Control" && event.key !== "Meta") return;
    this.#updateModifiers(event.ctrlKey, event.metaKey);
  };

  readonly #handleWindowKeyUp = (event: KeyboardEvent): void => {
    if (
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      this.#commitKeyboardGesture();
    }
    if (event.key !== "Control" && event.key !== "Meta") return;
    this.#updateModifiers(event.ctrlKey, event.metaKey);
  };

  readonly #handleWindowBlur = (): void => {
    this.#controlPressed = false;
    this.#metaPressed = false;
    this.#clearPointerProximity();
    if (this.#gesture?.source === "pointer") {
      this.#cancelGesture(true);
      return;
    }
    this.#commitKeyboardGesture();
  };

  readonly #handleWindowPointerMove = (event: PointerEvent): void => {
    if (!this.#visible) return;
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    this.#pendingProximity = Object.freeze({
      clientX: event.clientX,
      clientY: event.clientY,
    });
    if (this.#proximityFrame !== null) return;
    this.#proximityFrame = this.#requestFrame(() => {
      this.#proximityFrame = null;
      const sample = this.#pendingProximity;
      this.#pendingProximity = null;
      if (sample) this.#samplePointerProximity(sample);
    });
  };

  readonly #handleWindowPointerOut = (event: PointerEvent): void => {
    if (event.relatedTarget === null) this.#clearPointerProximity();
  };

  readonly #handleContextMenu = (event: Event): void => {
    if (this.#gesture?.source === "pointer") event.preventDefault();
  };

  readonly #handlePointerMove = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (!gesture || gesture.source !== "pointer") return;
    if (event.pointerId !== gesture.pointerId) return;
    gesture.lastClientX = event.clientX;
    const pointerRatio = this.#pointerRatio(gesture, event.clientX);
    if (gesture.handle) {
      const independent = this.#independentRequested(
        event.ctrlKey,
        event.metaKey,
      );
      const operation = independent ? "independent" : "linked";
      if (gesture.operation !== operation) {
        this.#rebasePointerGesture(gesture, pointerRatio, operation);
      }
    }
    this.#applyPointerGesture(gesture, pointerRatio);
    event.preventDefault();
  };

  readonly #handlePointerUp = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (!gesture || gesture.source !== "pointer") return;
    if (event.pointerId !== gesture.pointerId) return;
    gesture.lastClientX = event.clientX;
    const pointerRatio = this.#pointerRatio(gesture, event.clientX);
    if (gesture.handle) {
      const operation = this.#independentRequested(
        event.ctrlKey,
        event.metaKey,
      )
        ? "independent"
        : "linked";
      if (gesture.operation !== operation) {
        this.#rebasePointerGesture(gesture, pointerRatio, operation);
      }
    }
    this.#applyPointerGesture(gesture, pointerRatio);
    this.#commitPointerGesture();
    if (event.pointerType === "mouse" || event.pointerType === "pen") {
      this.#samplePointerProximity({
        clientX: event.clientX,
        clientY: event.clientY,
      });
    } else {
      this.#clearPointerProximity();
    }
    event.preventDefault();
  };

  readonly #handlePointerCancel = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (
      gesture?.source === "pointer" &&
      event.pointerId === gesture.pointerId
    ) {
      this.#cancelGesture(true);
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
        this.#clearPointerProximity();
      }
    }
  };

  readonly #handleLostPointerCapture = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (
      gesture?.source === "pointer" &&
      event.pointerId === gesture.pointerId
    ) {
      // Losing capture without a matching pointerup/pointercancel means the
      // gesture was interrupted by the browser or another owner. Roll back
      // the preview instead of committing a partial boundary update.
      this.#cancelGesture(true);
    }
  };

  constructor(options: LyricsContentRegionControlOptions) {
    const document = options.document;
    this.#window = document.defaultView;
    this.#minSpanRatio = finiteUnit(options.minSpanRatio, 0);
    this.#stepRatio = finiteUnit(options.stepRatio, DEFAULT_STEP_RATIO);
    this.#largeStepRatio = finiteUnit(
      options.largeStepRatio,
      DEFAULT_LARGE_STEP_RATIO,
    );
    this.#region = normalizeLyricsContentRegion(
      options.initialRegion ?? DEFAULT_LYRICS_CONTENT_REGION,
      this.#minSpanRatio,
    );
    this.#visible = options.initialVisible ?? true;
    this.#onStart = options.onStart;
    this.#onInput = options.onInput;
    this.#onCommit = options.onCommit;
    this.#onCancel = options.onCancel;

    const view = this.#window;
    this.#requestFrame =
      options.requestFrame ??
      ((callback) => {
        if (view) return view.requestAnimationFrame(callback);
        return globalThis.setTimeout(
          () => callback(defaultNow()),
          16,
        ) as unknown as number;
      });
    this.#cancelFrame =
      options.cancelFrame ??
      ((handle) => {
        if (view) view.cancelAnimationFrame(handle);
        else globalThis.clearTimeout(handle);
      });

    const element = document.createElement("div");
    element.className = "am-lp-content-region-control";
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", "Lyrics content boundaries");

    const track = document.createElement("div");
    track.className = "am-lp-content-region-track";
    track.setAttribute("aria-hidden", "true");

    const selection = document.createElement("div");
    selection.className = "am-lp-content-region-selection";
    selection.tabIndex = 0;
    selection.setAttribute("role", "slider");
    selection.setAttribute("aria-label", "Move selected lyrics region");
    selection.setAttribute("aria-orientation", "horizontal");

    const leftHandle = document.createElement("button");
    leftHandle.type = "button";
    leftHandle.className =
      "am-lp-content-region-handle am-lp-content-region-handle-left";
    leftHandle.dataset.handle = "left";
    leftHandle.setAttribute("role", "slider");
    leftHandle.setAttribute("aria-label", "Left lyrics boundary");
    leftHandle.setAttribute("aria-orientation", "horizontal");
    leftHandle.setAttribute(
      "aria-description",
      "Moves both boundaries. Hold Control or Command to move only this boundary.",
    );

    const rightHandle = document.createElement("button");
    rightHandle.type = "button";
    rightHandle.className =
      "am-lp-content-region-handle am-lp-content-region-handle-right";
    rightHandle.dataset.handle = "right";
    rightHandle.setAttribute("role", "slider");
    rightHandle.setAttribute("aria-label", "Right lyrics boundary");
    rightHandle.setAttribute("aria-orientation", "horizontal");
    rightHandle.setAttribute(
      "aria-description",
      "Moves both boundaries. Hold Control or Command to move only this boundary.",
    );

    element.append(track, selection, leftHandle, rightHandle);
    this.element = element;
    this.#track = track;
    this.#selection = selection;
    this.#leftHandle = leftHandle;
    this.#rightHandle = rightHandle;

    const signal = this.#events.signal;
    leftHandle.addEventListener(
      "pointerdown",
      (event) => this.#beginPointerGesture(event, leftHandle, "left"),
      { signal },
    );
    rightHandle.addEventListener(
      "pointerdown",
      (event) => this.#beginPointerGesture(event, rightHandle, "right"),
      { signal },
    );
    selection.addEventListener(
      "pointerdown",
      (event) => this.#beginPointerGesture(event, selection, null),
      { signal },
    );
    const interactionTargets: readonly HTMLElement[] = [
      leftHandle,
      rightHandle,
      selection,
    ];
    for (const target of interactionTargets) {
      target.addEventListener("pointermove", this.#handlePointerMove, { signal });
      target.addEventListener("pointerup", this.#handlePointerUp, { signal });
      target.addEventListener("pointercancel", this.#handlePointerCancel, {
        signal,
      });
      target.addEventListener(
        "lostpointercapture",
        this.#handleLostPointerCapture,
        { signal },
      );
      target.addEventListener(
        "keydown",
        (event) => this.#handleControlKeyDown(event, target),
        { signal },
      );
      target.addEventListener("blur", () => this.#commitKeyboardGesture(), {
        signal,
      });
    }
    element.addEventListener("contextmenu", this.#handleContextMenu, { signal });
    view?.addEventListener("keydown", this.#handleWindowKeyDown, { signal });
    view?.addEventListener("keyup", this.#handleWindowKeyUp, { signal });
    view?.addEventListener("blur", this.#handleWindowBlur, { signal });
    view?.addEventListener("pointermove", this.#handleWindowPointerMove, {
      passive: true,
      signal,
    });
    view?.addEventListener("pointerout", this.#handleWindowPointerOut, {
      passive: true,
      signal,
    });

    this.#syncDom();
  }

  getState(): LyricsContentRegionControlState {
    const gesture = this.#gesture;
    return Object.freeze({
      region: this.#region,
      visible: this.#visible,
      interaction: gesture?.source ?? "idle",
      operation: gesture?.operation ?? null,
      activeHandle: gesture?.handle ?? null,
      destroyed: this.#destroyed,
    });
  }

  setRegion(region: LyricsContentRegion): void {
    this.#assertAlive();
    const next = normalizeLyricsContentRegion(region, this.#minSpanRatio);
    if (regionsEqual(next, this.#region)) return;
    this.#clearInputFrame();
    this.#region = next;
    const gesture = this.#gesture;
    if (gesture?.source === "pointer") {
      this.#rebasePointerGesture(
        gesture,
        this.#pointerRatio(gesture, gesture.lastClientX),
        gesture.operation,
      );
    }
    this.#syncDom();
  }

  setVisible(visible: boolean): void {
    this.#assertAlive();
    if (visible === this.#visible) return;
    if (!visible) {
      if (this.#gesture) this.#cancelGesture(true);
      this.#clearPointerProximity();
    }
    this.#visible = visible;
    this.#syncDom();
  }

  commitInteraction(): void {
    this.#assertAlive();
    const gesture = this.#gesture;
    if (!gesture) return;
    if (gesture.source === "pointer") {
      this.#commitPointerGesture();
    } else {
      this.#commitKeyboardGesture();
    }
  }

  cancelInteraction(): void {
    this.#assertAlive();
    if (this.#gesture) this.#cancelGesture(true);
  }

  destroy(): void {
    if (this.#destroyed) return;
    if (this.#gesture) this.#cancelGesture(true);
    this.#destroyed = true;
    this.#clearInputFrame();
    this.#clearPointerProximity();
    this.#events.abort();
    this.element.remove();
    this.#syncDom();
  }

  #beginPointerGesture(
    event: PointerEvent,
    captureElement: HTMLElement,
    handle: LyricsContentRegionHandle | null,
  ): void {
    if (this.#destroyed || !this.#visible) return;
    if (this.#gesture?.source === "pointer") return;
    if (!event.isPrimary || event.button !== 0) return;
    this.#commitKeyboardGesture();
    if (this.#destroyed || !this.#visible || this.#gesture) return;
    const rect = this.#track.getBoundingClientRect();
    const fallbackRect = this.element.getBoundingClientRect();
    const trackLeftPx = rect.width > 0 ? rect.left : fallbackRect.left;
    const trackWidthPx = rect.width > 0 ? rect.width : fallbackRect.width;
    if (!(trackWidthPx > 0)) return;
    this.#controlPressed = event.ctrlKey;
    this.#metaPressed = event.metaKey;
    const pointerRatio = (event.clientX - trackLeftPx) / trackWidthPx;
    const operation: LyricsContentRegionControlOperation = handle
      ? this.#independentRequested(event.ctrlKey, event.metaKey)
        ? "independent"
        : "linked"
      : "translate";
    const gesture: PointerGesture = {
      source: "pointer",
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      captureElement,
      originRegion: this.#region,
      handle,
      trackLeftPx,
      trackWidthPx,
      baselineRegion: this.#region,
      baselinePointerRatio: pointerRatio,
      grabOffsetRatio: handle ? pointerRatio - this.#region[handle] : 0,
      lastClientX: event.clientX,
      operation,
    };
    this.#gesture = gesture;
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
      // Coarse pointers do not produce a useful hover proximity sample. Once
      // a touch starts in the editor hit area, reveal both handles for the
      // duration of the gesture so the active range is legible.
      this.#setPointerProximity(true, true, handle === null);
    }
    try {
      captureElement.setPointerCapture(event.pointerId);
    } catch {
      // The pointer can disappear between pointerdown and capture.
      this.#gesture = null;
      this.#controlPressed = false;
      this.#metaPressed = false;
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
        this.#clearPointerProximity();
      }
      this.#syncDom();
      return;
    }
    captureElement.focus({ preventScroll: true });
    this.#syncDom();
    this.#onStart?.(eventForGesture(gesture, this.#region));
    event.preventDefault();
  }

  #pointerRatio(gesture: PointerGesture, clientX: number): number {
    return (clientX - gesture.trackLeftPx) / gesture.trackWidthPx;
  }

  #applyPointerGesture(
    gesture: PointerGesture,
    pointerRatio: number,
  ): void {
    let next: LyricsContentRegion;
    if (!gesture.handle) {
      next = translateLyricsContentRegion(
        gesture.baselineRegion,
        pointerRatio - gesture.baselinePointerRatio,
        this.#minSpanRatio,
      );
    } else {
      const position = pointerRatio - gesture.grabOffsetRatio;
      next =
        gesture.operation === "independent"
          ? moveIndependentLyricsContentRegionHandle(
              gesture.baselineRegion,
              gesture.handle,
              position,
              this.#minSpanRatio,
            )
          : moveLinkedLyricsContentRegionHandle(
              gesture.baselineRegion,
              gesture.handle,
              position,
              this.#minSpanRatio,
            );
    }
    this.#applyGestureRegion(gesture, next);
  }

  #rebasePointerGesture(
    gesture: PointerGesture,
    pointerRatio: number,
    operation: LyricsContentRegionControlOperation,
  ): void {
    gesture.baselineRegion = this.#region;
    gesture.baselinePointerRatio = pointerRatio;
    gesture.grabOffsetRatio = gesture.handle
      ? pointerRatio - this.#region[gesture.handle]
      : 0;
    gesture.operation = operation;
    this.#syncDom();
  }

  #commitPointerGesture(releaseCapture = true): void {
    const gesture = this.#gesture;
    if (!gesture || gesture.source !== "pointer") return;
    this.#flushInput();
    if (this.#gesture !== gesture) return;
    this.#gesture = null;
    if (
      releaseCapture &&
      gesture.captureElement.hasPointerCapture(gesture.pointerId)
    ) {
      gesture.captureElement.releasePointerCapture(gesture.pointerId);
    }
    this.#syncDom();
    this.#onCommit?.(eventForGesture(gesture, this.#region));
  }

  #handleControlKeyDown(event: KeyboardEvent, target: HTMLElement): void {
    if (event.key === "Escape") {
      if (this.#gesture?.source === "keyboard") {
        event.preventDefault();
        this.#cancelGesture(true);
      }
      return;
    }
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) return;
    if (this.#gesture?.source === "pointer") return;
    event.preventDefault();
    const handle =
      target === this.#leftHandle
        ? "left"
        : target === this.#rightHandle
          ? "right"
          : null;
    const operation: LyricsContentRegionControlOperation = handle
      ? this.#independentRequested(event.ctrlKey, event.metaKey)
        ? "independent"
        : "linked"
      : "translate";
    let gesture = this.#gesture;
    if (
      !gesture ||
      gesture.source !== "keyboard" ||
      gesture.targetElement !== target
    ) {
      this.#commitKeyboardGesture();
      gesture = {
        source: "keyboard",
        originRegion: this.#region,
        targetElement: target,
        handle,
        operation,
      };
      this.#gesture = gesture;
      this.#syncDom();
      this.#onStart?.(eventForGesture(gesture, this.#region));
      if (this.#destroyed || this.#gesture !== gesture) return;
    } else {
      gesture.operation = operation;
    }
    const step = event.shiftKey ? this.#largeStepRatio : this.#stepRatio;
    const isHome = event.key === "Home";
    const isEnd = event.key === "End";
    let next: LyricsContentRegion;
    if (isHome || isEnd) {
      if (!handle) {
        const delta = isHome ? -this.#region.left : 1 - this.#region.right;
        next = translateLyricsContentRegion(
          this.#region,
          delta,
          this.#minSpanRatio,
        );
      } else {
        const minimumSpan = Math.min(
          1,
          Math.max(0, this.#minSpanRatio),
        );
        const midpoint = (this.#region.left + this.#region.right) / 2;
        const minimumHalfSpan = minimumSpan / 2;
        const maximumHalfSpan = Math.min(midpoint, 1 - midpoint);
        const linkedMinimum =
          handle === "left"
            ? midpoint - maximumHalfSpan
            : midpoint + minimumHalfSpan;
        const linkedMaximum =
          handle === "left"
            ? midpoint - minimumHalfSpan
            : midpoint + maximumHalfSpan;
        const independentMinimum =
          handle === "left"
            ? 0
            : this.#region.left + minimumSpan;
        const independentMaximum =
          handle === "left"
            ? this.#region.right - minimumSpan
            : 1;
        const target = isHome
          ? operation === "independent"
            ? independentMinimum
            : linkedMinimum
          : operation === "independent"
            ? independentMaximum
            : linkedMaximum;
        next =
          operation === "independent"
            ? moveIndependentLyricsContentRegionHandle(
                this.#region,
                handle,
                target,
                this.#minSpanRatio,
              )
            : moveLinkedLyricsContentRegionHandle(
                this.#region,
                handle,
                target,
                this.#minSpanRatio,
              );
      }
    } else {
      const positive = event.key === "ArrowRight" || event.key === "ArrowUp";
      const delta = positive ? step : -step;
      next = handle
        ? operation === "independent"
          ? moveIndependentLyricsContentRegionHandle(
              this.#region,
              handle,
              this.#region[handle] + delta,
              this.#minSpanRatio,
            )
          : moveLinkedLyricsContentRegionHandle(
              this.#region,
              handle,
              this.#region[handle] + delta,
              this.#minSpanRatio,
            )
        : translateLyricsContentRegion(
            this.#region,
            delta,
            this.#minSpanRatio,
          );
    }
    this.#applyGestureRegion(gesture, next);
  }

  #commitKeyboardGesture(): void {
    const gesture = this.#gesture;
    if (!gesture || gesture.source !== "keyboard") return;
    this.#flushInput();
    if (this.#gesture !== gesture) return;
    this.#gesture = null;
    this.#syncDom();
    this.#onCommit?.(eventForGesture(gesture, this.#region));
  }

  #applyGestureRegion(
    gesture: ActiveGesture,
    region: LyricsContentRegion,
  ): void {
    if (regionsEqual(region, this.#region)) return;
    this.#region = region;
    this.#syncDom();
    this.#pendingInput = eventForGesture(gesture, region);
    if (this.#inputFrame !== null) return;
    this.#inputFrame = this.#requestFrame(() => {
      this.#inputFrame = null;
      const pending = this.#pendingInput;
      this.#pendingInput = null;
      if (pending) this.#onInput?.(pending);
    });
  }

  #flushInput(): void {
    if (this.#inputFrame !== null) {
      this.#cancelFrame(this.#inputFrame);
      this.#inputFrame = null;
    }
    const pending = this.#pendingInput;
    this.#pendingInput = null;
    if (pending) this.#onInput?.(pending);
  }

  #clearInputFrame(): void {
    if (this.#inputFrame !== null) this.#cancelFrame(this.#inputFrame);
    this.#inputFrame = null;
    this.#pendingInput = null;
  }

  #cancelGesture(rollback: boolean): void {
    const gesture = this.#gesture;
    if (!gesture) return;
    this.#clearInputFrame();
    if (rollback) this.#region = gesture.originRegion;
    this.#gesture = null;
    if (
      gesture.source === "pointer" &&
      gesture.captureElement.hasPointerCapture(gesture.pointerId)
    ) {
      gesture.captureElement.releasePointerCapture(gesture.pointerId);
    }
    this.#syncDom();
    this.#onCancel?.(eventForGesture(gesture, this.#region));
  }

  #updateModifiers(controlPressed: boolean, metaPressed: boolean): void {
    this.#controlPressed = controlPressed;
    this.#metaPressed = metaPressed;
    const gesture = this.#gesture;
    if (!gesture || gesture.source !== "pointer" || !gesture.handle) return;
    const operation =
      this.#controlPressed || this.#metaPressed ? "independent" : "linked";
    if (gesture.operation === operation) return;
    this.#rebasePointerGesture(
      gesture,
      this.#pointerRatio(gesture, gesture.lastClientX),
      operation,
    );
  }

  #independentRequested(controlPressed = false, metaPressed = false): boolean {
    return (
      this.#controlPressed ||
      this.#metaPressed ||
      controlPressed ||
      metaPressed
    );
  }

  #samplePointerProximity(sample: PointerProximitySample): void {
    if (this.#destroyed || !this.#visible) {
      this.#setPointerProximity(false, false, false);
      return;
    }
    const controlPadding = this.#controlNear
      ? CONTROL_PROXIMITY_EXIT_PX
      : CONTROL_PROXIMITY_ENTER_PX;
    const controlNear = pointNearRect(
      sample.clientX,
      sample.clientY,
      this.element.getBoundingClientRect(),
      controlPadding,
    );
    const handlePadding = this.#handlesNear
      ? HANDLE_PROXIMITY_EXIT_PX
      : HANDLE_PROXIMITY_ENTER_PX;
    const handlesNear =
      controlNear &&
      (pointNearRect(
        sample.clientX,
        sample.clientY,
        this.#leftHandle.getBoundingClientRect(),
        handlePadding,
      ) ||
        pointNearRect(
          sample.clientX,
          sample.clientY,
          this.#rightHandle.getBoundingClientRect(),
          handlePadding,
        ));
    const rangePadding = this.#rangeNear
      ? RANGE_PROXIMITY_EXIT_PX
      : RANGE_PROXIMITY_ENTER_PX;
    const rangeNear =
      controlNear &&
      pointNearRect(
        sample.clientX,
        sample.clientY,
        this.#selection.getBoundingClientRect(),
        rangePadding,
      );
    this.#setPointerProximity(controlNear, handlesNear, rangeNear);
  }

  #setPointerProximity(
    controlNear: boolean,
    handlesNear: boolean,
    rangeNear: boolean,
  ): void {
    const nextHandlesNear = controlNear && handlesNear;
    const nextRangeNear = controlNear && rangeNear;
    if (
      controlNear === this.#controlNear &&
      nextHandlesNear === this.#handlesNear &&
      nextRangeNear === this.#rangeNear
    ) {
      return;
    }
    this.#controlNear = controlNear;
    this.#handlesNear = nextHandlesNear;
    this.#rangeNear = nextRangeNear;
    this.#syncPointerProximityDom();
  }

  #clearPointerProximity(): void {
    if (this.#proximityFrame !== null) {
      this.#cancelFrame(this.#proximityFrame);
      this.#proximityFrame = null;
    }
    this.#pendingProximity = null;
    this.#setPointerProximity(false, false, false);
  }

  #syncPointerProximityDom(): void {
    this.element.dataset.controlNear = String(this.#controlNear);
    this.element.dataset.handlesNear = String(this.#handlesNear);
    this.element.dataset.rangeNear = String(this.#rangeNear);
  }

  #syncDom(): void {
    const region = this.#region;
    const leftPercent = percentage(region.left);
    const rightPercent = percentage(region.right);
    const widthPercent = percentage(region.right - region.left);
    this.element.hidden = !this.#visible;
    this.element.dataset.visible = String(this.#visible);
    this.element.dataset.interaction = this.#gesture?.source ?? "idle";
    this.element.dataset.operation = this.#gesture?.operation ?? "idle";
    this.element.dataset.activeHandle = this.#gesture?.handle ?? "none";
    this.element.dataset.pointerType =
      this.#gesture?.source === "pointer"
        ? this.#gesture.pointerType || "unknown"
        : "none";
    this.#syncPointerProximityDom();
    this.element.dataset.leftRatio = String(region.left);
    this.element.dataset.rightRatio = String(region.right);
    this.element.style.setProperty(
      "--am-lp-content-region-left",
      `${leftPercent}%`,
    );
    this.element.style.setProperty(
      "--am-lp-content-region-right",
      `${rightPercent}%`,
    );
    this.element.style.setProperty(
      "--am-lp-content-region-width",
      `${widthPercent}%`,
    );

    const midpoint = (region.left + region.right) / 2;
    const maximumHalfSpan = Math.min(midpoint, 1 - midpoint);
    const minimumHalfSpan = Math.min(
      this.#minSpanRatio / 2,
      maximumHalfSpan,
    );
    const gestureOperation = this.#gesture?.operation;
    const handlesLinked = gestureOperation !== "independent";
    const leftMinimum = handlesLinked ? midpoint - maximumHalfSpan : 0;
    const leftMaximum = handlesLinked
      ? midpoint - minimumHalfSpan
      : Math.max(0, region.right - this.#minSpanRatio);
    const rightMinimum = handlesLinked
      ? midpoint + minimumHalfSpan
      : Math.min(1, region.left + this.#minSpanRatio);
    const rightMaximum = handlesLinked ? midpoint + maximumHalfSpan : 1;
    this.#leftHandle.setAttribute(
      "aria-valuemin",
      percentage(leftMinimum),
    );
    this.#leftHandle.setAttribute(
      "aria-valuemax",
      percentage(leftMaximum),
    );
    this.#leftHandle.setAttribute("aria-valuenow", leftPercent);
    this.#leftHandle.setAttribute(
      "aria-valuetext",
      `Left boundary ${leftPercent}%`,
    );
    this.#rightHandle.setAttribute(
      "aria-valuemin",
      percentage(rightMinimum),
    );
    this.#rightHandle.setAttribute(
      "aria-valuemax",
      percentage(rightMaximum),
    );
    this.#rightHandle.setAttribute("aria-valuenow", rightPercent);
    this.#rightHandle.setAttribute(
      "aria-valuetext",
      `Right boundary ${rightPercent}%`,
    );

    const span = region.right - region.left;
    this.#selection.setAttribute("aria-valuemin", percentage(span / 2));
    this.#selection.setAttribute("aria-valuemax", percentage(1 - span / 2));
    this.#selection.setAttribute("aria-valuenow", percentage(midpoint));
    this.#selection.setAttribute("aria-valuetext", regionValueText(region));

  }

  #assertAlive(): void {
    if (this.#destroyed) {
      throw new Error("Lyrics content region control has been destroyed");
    }
  }
}

export function createLyricsContentRegionControl(
  options: LyricsContentRegionControlOptions,
): LyricsContentRegionControl {
  return new LyricsContentRegionControlImpl(options);
}
