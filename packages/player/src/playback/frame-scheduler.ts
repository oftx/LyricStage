import type { PlaybackClock, PlaybackSnapshot, Unsubscribe } from "./types.js";

export type FrameSampleCause =
  | "clock-invalidation"
  | "clock-replaced"
  | "enabled"
  | "animation-frame"
  | "manual";

export interface FrameSchedulerOptions {
  readonly onSample: (
    snapshot: PlaybackSnapshot,
    cause: FrameSampleCause,
  ) => void;
  readonly onError?: (error: unknown) => void;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface FrameSchedulerState {
  readonly enabled: boolean;
  readonly destroyed: boolean;
  readonly hasClock: boolean;
  readonly framePending: boolean;
}

export interface FrameScheduler {
  setClock(clock: PlaybackClock | null): void;
  setEnabled(enabled: boolean): void;
  sample(): void;
  getState(): FrameSchedulerState;
  destroy(): void;
}

function defaultRequestFrame(callback: FrameRequestCallback): number {
  return globalThis.requestAnimationFrame(callback);
}

function defaultCancelFrame(handle: number): void {
  globalThis.cancelAnimationFrame(handle);
}

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

class FrameSchedulerImpl implements FrameScheduler {
  readonly #onSample: FrameSchedulerOptions["onSample"];
  readonly #onError: FrameSchedulerOptions["onError"];
  readonly #requestFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelFrame: (handle: number) => void;
  #clock: PlaybackClock | null = null;
  #unsubscribeClock: Unsubscribe | null = null;
  #frameHandle: number | null = null;
  #clockGeneration = 0;
  #frameGeneration = 0;
  #enabled = false;
  #destroyed = false;

  constructor(options: FrameSchedulerOptions) {
    this.#onSample = options.onSample;
    this.#onError = options.onError;
    this.#requestFrame = options.requestFrame ?? defaultRequestFrame;
    this.#cancelFrame = options.cancelFrame ?? defaultCancelFrame;
  }

  setClock(clock: PlaybackClock | null): void {
    this.#assertMutable();
    if (clock === this.#clock) {
      if (clock && this.#enabled) this.#sample("clock-replaced");
      return;
    }

    const errors: unknown[] = [];
    this.#clockGeneration += 1;
    this.#frameGeneration += 1;
    this.#cancelPendingFrame(errors);

    const unsubscribeClock = this.#unsubscribeClock;
    this.#unsubscribeClock = null;
    this.#clock = null;
    try {
      unsubscribeClock?.();
    } catch (error) {
      errors.push(error);
    }

    if (clock) {
      const generation = this.#clockGeneration;
      this.#clock = clock;
      try {
        const unsubscribe = clock.subscribe(() => {
          if (
            this.#destroyed ||
            generation !== this.#clockGeneration ||
            this.#clock !== clock
          ) {
            return;
          }
          this.#sample("clock-invalidation");
        });
        if (generation === this.#clockGeneration && this.#clock === clock) {
          this.#unsubscribeClock = unsubscribe;
        } else {
          unsubscribe();
        }
      } catch (error) {
        errors.push(error);
        if (generation === this.#clockGeneration && this.#clock === clock) {
          this.#clockGeneration += 1;
          this.#frameGeneration += 1;
          this.#cancelPendingFrame(errors);
          this.#unsubscribeClock = null;
          this.#clock = null;
        }
      }
    }

    if (this.#enabled && this.#clock) this.#sample("clock-replaced");
    throwCollectedErrors(errors, "Playback clock replacement failed");
  }

  setEnabled(enabled: boolean): void {
    this.#assertMutable();
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (!enabled) {
      const errors: unknown[] = [];
      this.#frameGeneration += 1;
      this.#cancelPendingFrame(errors);
      throwCollectedErrors(errors, "Animation frame cancellation failed");
      return;
    }

    this.#frameGeneration += 1;
    if (this.#clock) this.#sample("enabled");
  }

  sample(): void {
    this.#assertMutable();
    this.#sample("manual");
  }

  getState(): FrameSchedulerState {
    return Object.freeze({
      enabled: this.#enabled,
      destroyed: this.#destroyed,
      hasClock: this.#clock !== null,
      framePending: this.#frameHandle !== null,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#enabled = false;
    this.#clockGeneration += 1;
    this.#frameGeneration += 1;

    const errors: unknown[] = [];
    this.#cancelPendingFrame(errors);
    const unsubscribeClock = this.#unsubscribeClock;
    this.#unsubscribeClock = null;
    this.#clock = null;
    try {
      unsubscribeClock?.();
    } catch (error) {
      errors.push(error);
    }
    throwCollectedErrors(errors, "Frame scheduler cleanup failed");
  }

  #assertMutable(): void {
    if (this.#destroyed) throw new Error("Frame scheduler has been destroyed");
  }

  #sample(cause: FrameSampleCause): void {
    if (!this.#enabled) return;
    const clock = this.#clock;
    if (!clock) return;

    try {
      const snapshot = clock.getSnapshot();
      this.#onSample(snapshot, cause);
      if (snapshot.playing && !snapshot.seeking) {
        this.#ensureFrame();
      } else {
        const errors: unknown[] = [];
        this.#cancelPendingFrame(errors);
        for (const error of errors) this.#reportError(error);
      }
    } catch (error) {
      this.#reportError(error);
    }
  }

  #ensureFrame(): void {
    if (
      this.#frameHandle !== null ||
      !this.#enabled ||
      this.#destroyed ||
      !this.#clock
    ) {
      return;
    }

    const generation = this.#frameGeneration;
    let handle = 0;
    handle = this.#requestFrame(() => {
      if (
        this.#destroyed ||
        generation !== this.#frameGeneration ||
        handle !== this.#frameHandle
      ) {
        return;
      }
      this.#frameHandle = null;
      this.#sample("animation-frame");
    });
    this.#frameHandle = handle;
  }

  #cancelPendingFrame(errors: unknown[]): void {
    const handle = this.#frameHandle;
    this.#frameHandle = null;
    if (handle === null) return;
    try {
      this.#cancelFrame(handle);
    } catch (error) {
      errors.push(error);
    }
  }

  #reportError(error: unknown): void {
    if (this.#onError) {
      try {
        this.#onError(error);
        return;
      } catch (reportingError) {
        globalThis.setTimeout(() => {
          throw reportingError;
        });
        return;
      }
    }
    globalThis.setTimeout(() => {
      throw error;
    });
  }
}

export function createFrameScheduler(
  options: FrameSchedulerOptions,
): FrameScheduler {
  return new FrameSchedulerImpl(options);
}
