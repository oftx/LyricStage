import type { PlayerViewLayer } from "../view/player-view.js";

export interface LayerCrossfadeOptions {
  readonly synced: HTMLElement;
  readonly plaintext: HTMLElement;
  readonly durationMs?: number;
  readonly easing?: string;
}

export interface LayerCrossfadeTransitionOptions {
  readonly reducedMotion?: boolean;
}

export interface LayerCrossfadeState {
  readonly activeLayer: PlayerViewLayer;
  readonly targetLayer: PlayerViewLayer;
  readonly running: boolean;
  readonly animationCount: number;
}

export interface LayerCrossfade {
  transitionTo(
    layer: PlayerViewLayer,
    options?: LayerCrossfadeTransitionOptions,
  ): void;
  settle(layer: PlayerViewLayer): void;
  cancel(): void;
  getState(): LayerCrossfadeState;
  destroy(): void;
}

const DEFAULT_DURATION_MS = 480;
const DEFAULT_EASING = "cubic-bezier(0, 0, 0.3, 1)";

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

class LayerCrossfadeImpl implements LayerCrossfade {
  readonly #layers: Readonly<Record<PlayerViewLayer, HTMLElement>>;
  readonly #durationMs: number;
  readonly #easing: string;
  #activeLayer: PlayerViewLayer = "synced";
  #targetLayer: PlayerViewLayer = "synced";
  #animations: Animation[] = [];
  #runId = 0;
  #destroyed = false;

  constructor(options: LayerCrossfadeOptions) {
    this.#layers = Object.freeze({
      synced: options.synced,
      plaintext: options.plaintext,
    });
    this.#durationMs =
      options.durationMs !== undefined &&
      Number.isFinite(options.durationMs) &&
      options.durationMs >= 0
        ? options.durationMs
        : DEFAULT_DURATION_MS;
    this.#easing = options.easing ?? DEFAULT_EASING;
    this.settle("synced");
  }

  transitionTo(
    layer: PlayerViewLayer,
    options: LayerCrossfadeTransitionOptions = {},
  ): void {
    this.#assertMutable();
    if (options.reducedMotion || this.#durationMs === 0) {
      this.settle(layer);
      return;
    }
    if (layer === this.#targetLayer && this.#animations.length > 0) return;
    if (layer === this.#activeLayer && this.#animations.length === 0) {
      this.settle(layer);
      return;
    }

    const outgoingLayer: PlayerViewLayer =
      layer === "synced" ? "plaintext" : "synced";
    const target = this.#layers[layer];
    const outgoing = this.#layers[outgoingLayer];
    const targetOpacity = this.#readOpacity(target);
    const outgoingOpacity = this.#readOpacity(outgoing);
    const cancellationErrors = this.#cancelAnimations();
    if (cancellationErrors.length > 0) {
      this.#settleWithoutCancel(layer, true);
      throwCollectedErrors(
        cancellationErrors,
        "Layer crossfade cancellation failed",
      );
    }
    const runId = this.#runId;
    this.#targetLayer = layer;

    target.hidden = false;
    outgoing.hidden = false;
    target.inert = false;
    outgoing.inert = true;
    target.setAttribute("aria-hidden", "false");
    outgoing.setAttribute("aria-hidden", "true");
    target.dataset.layerActive = "true";
    outgoing.dataset.layerActive = "false";

    if (typeof target.animate !== "function") {
      this.#settleWithoutCancel(layer);
      return;
    }

    const timing: KeyframeAnimationOptions = {
      duration: this.#durationMs,
      easing: this.#easing,
      fill: "forwards",
    };
    const createdAnimations: Animation[] = [];
    try {
      createdAnimations.push(
        target.animate([{ opacity: targetOpacity }, { opacity: 1 }], timing),
      );
      createdAnimations.push(
        outgoing.animate(
          [{ opacity: outgoingOpacity }, { opacity: 0 }],
          timing,
        ),
      );
      const finished = createdAnimations.map((animation) => animation.finished);
      this.#animations = createdAnimations;
      void Promise.allSettled(finished).then(() => {
        if (
          this.#destroyed ||
          runId !== this.#runId ||
          this.#targetLayer !== layer
        ) {
          return;
        }
        this.#settleWithoutCancel(layer);
        const failedAnimations: Animation[] = [];
        for (const animation of createdAnimations) {
          try {
            animation.cancel();
          } catch {
            failedAnimations.push(animation);
          }
        }
        this.#animations = failedAnimations;
      });
    } catch (error) {
      this.#runId += 1;
      this.#animations = [];
      const errors: unknown[] = [error];
      const failedAnimations: Animation[] = [];
      for (const animation of createdAnimations) {
        try {
          animation.cancel();
        } catch (cleanupError) {
          errors.push(cleanupError);
          failedAnimations.push(animation);
        }
      }
      this.#animations = failedAnimations;
      this.#settleWithoutCancel(layer, failedAnimations.length > 0);
      if (errors.length > 1) {
        throw new AggregateError(errors, "Layer crossfade creation failed");
      }
      throw error;
    }
  }

  settle(layer: PlayerViewLayer): void {
    this.#assertMutable();
    const errors = this.#cancelAnimations();
    this.#settleWithoutCancel(layer, errors.length > 0);
    throwCollectedErrors(errors, "Layer crossfade settle failed");
  }

  cancel(): void {
    if (this.#destroyed) return;
    const errors = this.#cancelAnimations();
    this.#settleWithoutCancel(this.#targetLayer, errors.length > 0);
    throwCollectedErrors(errors, "Layer crossfade cancellation failed");
  }

  getState(): LayerCrossfadeState {
    return Object.freeze({
      activeLayer: this.#activeLayer,
      targetLayer: this.#targetLayer,
      running: this.#animations.length > 0,
      animationCount: this.#animations.length,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    const errors = this.#cancelAnimations();
    this.#destroyed = true;
    this.#animations = [];
    throwCollectedErrors(errors, "Layer crossfade cleanup failed");
  }

  #assertMutable(): void {
    if (this.#destroyed) throw new Error("Layer crossfade has been destroyed");
  }

  #cancelAnimations(): readonly unknown[] {
    this.#runId += 1;
    const animations = this.#animations.splice(0);
    const errors: unknown[] = [];
    const failedAnimations: Animation[] = [];
    for (const animation of animations) {
      try {
        animation.cancel();
      } catch (error) {
        errors.push(error);
        failedAnimations.push(animation);
      }
    }
    this.#animations = failedAnimations;
    return errors;
  }

  #readOpacity(element: HTMLElement): number {
    const view = element.ownerDocument.defaultView;
    const value = view?.getComputedStyle(element).opacity ?? element.style.opacity;
    const opacity = Number(value);
    return Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0;
  }

  #settleWithoutCancel(
    layer: PlayerViewLayer,
    preserveAnimations = false,
  ): void {
    const inactiveLayer: PlayerViewLayer =
      layer === "synced" ? "plaintext" : "synced";
    const active = this.#layers[layer];
    const inactive = this.#layers[inactiveLayer];
    if (!preserveAnimations) this.#animations = [];
    this.#activeLayer = layer;
    this.#targetLayer = layer;
    active.style.opacity = "1";
    inactive.style.opacity = "0";
    active.dataset.layerActive = "true";
    inactive.dataset.layerActive = "false";
    active.hidden = false;
    active.inert = false;
    active.setAttribute("aria-hidden", "false");
    inactive.inert = true;
    inactive.setAttribute("aria-hidden", "true");
    inactive.hidden = true;
  }
}

export function createLayerCrossfade(
  options: LayerCrossfadeOptions,
): LayerCrossfade {
  return new LayerCrossfadeImpl(options);
}
