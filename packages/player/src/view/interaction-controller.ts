export interface InteractionControllerOptions {
  readonly viewport: HTMLElement;
  readonly idleMs?: number;
  readonly onManualScroll: () => void;
  readonly onManualScrollIdle: () => void;
  readonly onLineClick: (lineId: string) => void;
  readonly now?: () => number;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface InteractionControllerState {
  readonly manualScrollActive: boolean;
  readonly programmaticScrollPending: boolean;
  readonly smoothScrollRunning: boolean;
  readonly pressedLineId: string | null;
  readonly destroyed: boolean;
}

export interface SmoothScrollAnimationOptions {
  readonly resolveTargetTop: () => number;
  readonly durationMs: number;
  readonly ease?: (progress: number) => number;
  readonly trackTargetChanges?: boolean;
  readonly onSettled?: () => void;
}

export interface InteractionController {
  setViewport(viewport: HTMLElement): void;
  setProgrammaticScrollTop(scrollTop: number): number;
  animateProgrammaticScroll(options: SmoothScrollAnimationOptions): void;
  cancelSmoothScroll(reason?: string): void;
  getState(): InteractionControllerState;
  destroy(): void;
}

const DEFAULT_IDLE_MS = 280;
const manualScrollKeys = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

function eventElement(event: Event): Element | null {
  const target = event.target;
  if (!target || typeof target !== "object") return null;
  const ownerDocument = (target as Node).ownerDocument;
  const ElementConstructor = ownerDocument?.defaultView?.Element;
  if (ElementConstructor) {
    return target instanceof ElementConstructor ? target : null;
  }
  return typeof (target as Element).closest === "function"
    ? (target as Element)
    : null;
}

function eventRow(event: Event): HTMLElement | null {
  return eventElement(event)?.closest<HTMLElement>(
    ".am-lp-row[data-line-id]",
  ) ?? null;
}

function defaultNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

class InteractionControllerImpl implements InteractionController {
  #viewport: HTMLElement;
  readonly #idleMs: number;
  readonly #onManualScroll: () => void;
  readonly #onManualScrollIdle: () => void;
  readonly #onLineClick: (lineId: string) => void;
  readonly #now: () => number;
  readonly #requestFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelFrame: (handle: number) => void;
  #window: Window | null;
  #idleTimer = 0;
  #programmaticResetTimer = 0;
  #programmaticExpectedTop: number | null = null;
  #manualScrollActive = false;
  #pressedRow: HTMLElement | null = null;
  #destroyed = false;
  #smoothScrollGeneration = 0;
  #smoothScrollFrame = 0;
  #smoothScrollRunning = false;
  #ignoreScrollEvents = false;

  readonly #handleScroll = (): void => {
    if (this.#destroyed || this.#ignoreScrollEvents) return;
    if (this.#smoothScrollRunning) return;
    const expectedTop = this.#programmaticExpectedTop;
    if (
      expectedTop !== null &&
      Math.abs(this.#viewport.scrollTop - expectedTop) < 1
    ) {
      this.#clearProgrammaticScroll();
      return;
    }
    this.#clearProgrammaticScroll();
    this.#beginManualScroll();
  };

  readonly #handleManualScrollInput = (): void => this.#beginManualScroll();

  readonly #handleKeyDown = (event: KeyboardEvent): void => {
    const row = eventRow(event);
    if (
      row?.dataset.seekable === "true" &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      if (event.repeat || event.isComposing) return;
      const lineId = row.dataset.lineId;
      if (lineId) this.#onLineClick(lineId);
      return;
    }
    if (manualScrollKeys.has(event.key)) this.#beginManualScroll();
  };

  readonly #handlePointerDown = (event: Event): void => {
    if (this.#smoothScrollRunning) this.#beginManualScroll();
    const row = eventRow(event);
    if (!row) return;
    this.#clearPressedRow();
    this.#pressedRow = row;
    row.dataset.pressing = "true";
  };

  readonly #handlePointerEnd = (): void => this.#clearPressedRow();

  readonly #handleClick = (event: Event): void => {
    const row = eventRow(event);
    this.#clearPressedRow();
    if (row?.dataset.seekable !== "true") return;
    const lineId = row.dataset.lineId;
    if (lineId) this.#onLineClick(lineId);
  };

  constructor(options: InteractionControllerOptions) {
    this.#viewport = options.viewport;
    this.#idleMs =
      options.idleMs !== undefined && Number.isFinite(options.idleMs)
        ? Math.max(0, options.idleMs)
        : DEFAULT_IDLE_MS;
    this.#onManualScroll = options.onManualScroll;
    this.#onManualScrollIdle = options.onManualScrollIdle;
    this.#onLineClick = options.onLineClick;
    this.#now = options.now ?? defaultNow;
    const view = options.viewport.ownerDocument.defaultView;
    this.#requestFrame =
      options.requestFrame ??
      ((callback) =>
        (view?.requestAnimationFrame ?? globalThis.requestAnimationFrame)(
          callback,
        ));
    this.#cancelFrame =
      options.cancelFrame ??
      ((handle) =>
        (view?.cancelAnimationFrame ?? globalThis.cancelAnimationFrame)(
          handle,
        ));
    this.#window = view;
    this.#attachViewport();
  }

  setViewport(viewport: HTMLElement): void {
    this.#assertAlive();
    if (viewport === this.#viewport) return;
    this.#finishManualScroll();
    this.cancelSmoothScroll("viewport-replaced");
    this.#detachViewport();
    this.#clearProgrammaticScroll();
    this.#clearPressedRow();
    this.#viewport = viewport;
    this.#window = viewport.ownerDocument.defaultView;
    this.#attachViewport();
  }

  setProgrammaticScrollTop(scrollTop: number): number {
    this.#assertAlive();
    this.#finishManualScroll();
    this.cancelSmoothScroll("instant-programmatic-scroll");
    const maxScrollTop = Math.max(
      0,
      this.#viewport.scrollHeight - this.#viewport.clientHeight,
    );
    const target = Number.isFinite(scrollTop)
      ? Math.min(maxScrollTop, Math.max(0, scrollTop))
      : this.#viewport.scrollTop;
    const previous = this.#viewport.scrollTop;
    if (Math.abs(previous - target) < 0.5) return 0;
    this.#clearProgrammaticScroll();
    this.#programmaticExpectedTop = target;
    this.#ignoreScrollEvents = true;
    this.#viewport.scrollTop = target;
    this.#ignoreScrollEvents = false;
    if (this.#window) {
      this.#programmaticResetTimer = this.#window.setTimeout(
        () => this.#clearProgrammaticScroll(),
        120,
      );
    }
    return this.#viewport.scrollTop - previous;
  }

  animateProgrammaticScroll(options: SmoothScrollAnimationOptions): void {
    this.#assertAlive();
    this.#finishManualScroll();
    this.cancelSmoothScroll("restart");
    const durationMs = Math.max(0, options.durationMs);
    const ease = options.ease ?? ((progress: number) => progress);
    const startTop = this.#viewport.scrollTop;
    const initialTarget = this.#clampScrollTop(options.resolveTargetTop());
    if (
      durationMs <= 0 ||
      (!options.trackTargetChanges && Math.abs(initialTarget - startTop) < 0.5)
    ) {
      this.setProgrammaticScrollTop(initialTarget);
      options.onSettled?.();
      return;
    }

    const generation = (this.#smoothScrollGeneration += 1);
    // Start the clock when the animation is scheduled, matching the legacy
    // requestAnimationFrame helper instead of adding one frame of latency.
    const startedAt = this.#now();
    this.#smoothScrollRunning = true;
    this.#clearProgrammaticScroll();

    const tick = (timestamp: number): void => {
      if (this.#destroyed || generation !== this.#smoothScrollGeneration) {
        return;
      }
      const now = Number.isFinite(timestamp) ? timestamp : this.#now();
      const progress = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
      const liveTarget = this.#clampScrollTop(options.resolveTargetTop());
      const nextTop = startTop + (liveTarget - startTop) * ease(progress);
      this.#ignoreScrollEvents = true;
      this.#viewport.scrollTop = nextTop;
      this.#ignoreScrollEvents = false;
      this.#programmaticExpectedTop = liveTarget;
      if (progress < 1) {
        this.#smoothScrollFrame = this.#requestFrame(tick);
        return;
      }
      this.#smoothScrollFrame = 0;
      this.#smoothScrollRunning = false;
      this.#programmaticExpectedTop = liveTarget;
      if (this.#window) {
        this.#programmaticResetTimer = this.#window.setTimeout(
          () => this.#clearProgrammaticScroll(),
          120,
        );
      }
      options.onSettled?.();
    };

    this.#smoothScrollFrame = this.#requestFrame(tick);
  }

  cancelSmoothScroll(_reason = "cancel"): void {
    if (!this.#smoothScrollRunning && this.#smoothScrollFrame === 0) return;
    this.#smoothScrollGeneration += 1;
    if (this.#smoothScrollFrame) {
      this.#cancelFrame(this.#smoothScrollFrame);
      this.#smoothScrollFrame = 0;
    }
    this.#smoothScrollRunning = false;
    this.#clearProgrammaticScroll();
  }

  getState(): InteractionControllerState {
    return Object.freeze({
      manualScrollActive: this.#manualScrollActive,
      programmaticScrollPending: this.#programmaticExpectedTop !== null,
      smoothScrollRunning: this.#smoothScrollRunning,
      pressedLineId: this.#pressedRow?.dataset.lineId ?? null,
      destroyed: this.#destroyed,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#clearIdleTimer();
    this.cancelSmoothScroll("destroy");
    this.#clearProgrammaticScroll();
    this.#clearPressedRow();
    this.#detachViewport();
  }

  #clampScrollTop(scrollTop: number): number {
    const maxScrollTop = Math.max(
      0,
      this.#viewport.scrollHeight - this.#viewport.clientHeight,
    );
    if (!Number.isFinite(scrollTop)) return this.#viewport.scrollTop;
    return Math.min(maxScrollTop, Math.max(0, scrollTop));
  }

  #scheduleIdle(): void {
    this.#clearIdleTimer();
    if (!this.#window) return;
    this.#idleTimer = this.#window.setTimeout(() => {
      this.#idleTimer = 0;
      if (this.#destroyed || !this.#manualScrollActive) return;
      this.#manualScrollActive = false;
      this.#onManualScrollIdle();
    }, this.#idleMs);
  }

  #beginManualScroll(): void {
    if (this.#destroyed) return;
    this.cancelSmoothScroll("manual-input");
    this.#manualScrollActive = true;
    this.#onManualScroll();
    this.#scheduleIdle();
  }

  #finishManualScroll(): void {
    this.#clearIdleTimer();
    if (!this.#manualScrollActive) return;
    this.#manualScrollActive = false;
    this.#onManualScrollIdle();
  }

  #clearIdleTimer(): void {
    if (!this.#idleTimer || !this.#window) return;
    this.#window.clearTimeout(this.#idleTimer);
    this.#idleTimer = 0;
  }

  #clearProgrammaticScroll(): void {
    if (this.#programmaticResetTimer && this.#window) {
      this.#window.clearTimeout(this.#programmaticResetTimer);
    }
    this.#programmaticResetTimer = 0;
    this.#programmaticExpectedTop = null;
  }

  #clearPressedRow(): void {
    if (!this.#pressedRow) return;
    delete this.#pressedRow.dataset.pressing;
    this.#pressedRow = null;
  }

  #attachViewport(): void {
    this.#viewport.addEventListener("scroll", this.#handleScroll, {
      passive: true,
    });
    this.#viewport.addEventListener("wheel", this.#handleManualScrollInput, {
      passive: true,
    });
    this.#viewport.addEventListener(
      "touchmove",
      this.#handleManualScrollInput,
      { passive: true },
    );
    this.#viewport.addEventListener("keydown", this.#handleKeyDown);
    this.#viewport.addEventListener("pointerdown", this.#handlePointerDown);
    this.#viewport.addEventListener("pointerup", this.#handlePointerEnd);
    this.#viewport.addEventListener("pointercancel", this.#handlePointerEnd);
    this.#viewport.addEventListener("pointerleave", this.#handlePointerEnd);
    this.#viewport.addEventListener("click", this.#handleClick);
  }

  #detachViewport(): void {
    this.#viewport.removeEventListener("scroll", this.#handleScroll);
    this.#viewport.removeEventListener("wheel", this.#handleManualScrollInput);
    this.#viewport.removeEventListener(
      "touchmove",
      this.#handleManualScrollInput,
    );
    this.#viewport.removeEventListener("keydown", this.#handleKeyDown);
    this.#viewport.removeEventListener("pointerdown", this.#handlePointerDown);
    this.#viewport.removeEventListener("pointerup", this.#handlePointerEnd);
    this.#viewport.removeEventListener("pointercancel", this.#handlePointerEnd);
    this.#viewport.removeEventListener("pointerleave", this.#handlePointerEnd);
    this.#viewport.removeEventListener("click", this.#handleClick);
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("Interaction controller is destroyed");
  }
}

export function createInteractionController(
  options: InteractionControllerOptions,
): InteractionController {
  return new InteractionControllerImpl(options);
}
