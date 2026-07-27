import { resolveRowMoveDelay } from "../navigation/auto-scroll.js";

export interface RowMoveHost {
  readonly lineId: string;
  readonly element: HTMLElement;
  readonly adapterIndex: number;
  readonly sourceIndex: number | null;
}

export interface RowMoveCaptureEntry {
  readonly lineId: string;
  readonly element: HTMLElement;
  readonly top: number;
  readonly height: number;
  readonly scale: number;
  readonly adapterIndex: number;
  readonly sourceIndex: number | null;
}

export interface RowMoveTransaction {
  readonly id: number;
  readonly reason: string;
  readonly animate: boolean;
  readonly durationMs: number;
  readonly easing: string;
  readonly anchorAdapterIndex: number;
  readonly before: ReadonlyMap<string, RowMoveCaptureEntry>;
}

export interface RowMoveSample {
  readonly lineId: string;
  readonly adapterIndex: number;
  readonly sourceIndex: number | null;
  readonly deltaY: number;
  readonly fromScale: number;
  readonly toScale: number;
  readonly moved: boolean;
  readonly scaleChanged: boolean;
  readonly animated: boolean;
  readonly delayMs: number;
  readonly durationMs: number;
}

export interface RowMoveState {
  readonly runId: number;
  readonly running: boolean;
  readonly reason: string;
  readonly animationCount: number;
  readonly samples: readonly RowMoveSample[];
}

export interface BeginRowMoveOptions {
  readonly reason: string;
  readonly animate: boolean;
  readonly durationMs: number;
  readonly anchorAdapterIndex: number;
  readonly easing?: string;
}

export interface CompleteRowMoveOptions {
  readonly suppressLineIds?: ReadonlySet<string>;
  readonly forceZeroDelay?: boolean;
  readonly forceZeroDelayLineIds?: ReadonlySet<string>;
  readonly onSettled?: () => void;
}

export interface RowMoveCoordinator {
  begin(
    hosts: readonly RowMoveHost[],
    options: BeginRowMoveOptions,
  ): RowMoveTransaction;
  complete(
    transaction: RowMoveTransaction,
    hosts: readonly RowMoveHost[],
    options?: CompleteRowMoveOptions,
  ): readonly RowMoveSample[];
  cancel(reason?: string): void;
  getState(): RowMoveState;
  destroy(): void;
}

const DEFAULT_EASING = "cubic-bezier(0.4, 0.1, 0, 1)";
const MIN_MOVE_PX = 1;
const MIN_SCALE_DELTA = 0.0005;

function safeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function readScale(element: HTMLElement): number {
  const view = element.ownerDocument.defaultView;
  const value = view?.getComputedStyle(element).scale ?? "1";
  if (!value || value === "none") return 1;
  const scale = Number.parseFloat(value);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function captureEntry(host: RowMoveHost): RowMoveCaptureEntry {
  const rect = host.element.getBoundingClientRect();
  return Object.freeze({
    lineId: host.lineId,
    element: host.element,
    top: rect.top,
    height: rect.height,
    scale: readScale(host.element),
    adapterIndex: host.adapterIndex,
    sourceIndex: host.sourceIndex,
  });
}

function freezeSample(sample: RowMoveSample): RowMoveSample {
  return Object.freeze(sample);
}

class RowMoveCoordinatorImpl implements RowMoveCoordinator {
  #runId = 0;
  #animations = new Map<string, Animation>();
  #ownedElements = new Set<HTMLElement>();
  #samples: readonly RowMoveSample[] = Object.freeze([]);
  #reason = "idle";
  #destroyed = false;

  begin(
    hosts: readonly RowMoveHost[],
    options: BeginRowMoveOptions,
  ): RowMoveTransaction {
    this.#assertAlive();
    const before = new Map<string, RowMoveCaptureEntry>();
    for (const host of hosts) {
      if (!before.has(host.lineId)) before.set(host.lineId, captureEntry(host));
    }

    this.#cancelAnimations(false);
    this.#clearOwnership();
    this.#runId += 1;
    this.#samples = Object.freeze([]);
    this.#reason = options.reason;
    if (options.animate && safeDuration(options.durationMs) > 0) {
      for (const host of hosts) {
        host.element.dataset.motionOwner = "row-move";
        this.#ownedElements.add(host.element);
      }
    }
    return Object.freeze({
      id: this.#runId,
      reason: options.reason,
      animate: options.animate,
      durationMs: safeDuration(options.durationMs),
      easing: options.easing ?? DEFAULT_EASING,
      anchorAdapterIndex: options.anchorAdapterIndex,
      before,
    });
  }

  complete(
    transaction: RowMoveTransaction,
    hosts: readonly RowMoveHost[],
    options: CompleteRowMoveOptions = {},
  ): readonly RowMoveSample[] {
    this.#assertAlive();
    if (transaction.id !== this.#runId) return Object.freeze([]);
    const suppressLineIds = options.suppressLineIds ?? new Set<string>();
    const samples: RowMoveSample[] = [];
    const animationEntries: Array<{
      readonly lineId: string;
      readonly element: HTMLElement;
      readonly animation: Animation;
    }> = [];
    const timelineTime =
      hosts[0]?.element.ownerDocument.timeline?.currentTime ?? null;

    try {
      for (const host of hosts) {
        const before = transaction.before.get(host.lineId);
        if (!before || before.element !== host.element) continue;
        const afterRect = host.element.getBoundingClientRect();
        const deltaY = before.top - afterRect.top;
        const targetScale = readScale(host.element);
        const moved =
          !suppressLineIds.has(host.lineId) &&
          Math.abs(deltaY) >= MIN_MOVE_PX;
        const scaleChanged =
          Math.abs(before.scale - targetScale) >= MIN_SCALE_DELTA;
        const animated =
          transaction.animate &&
          transaction.durationMs > 0 &&
          (moved || scaleChanged) &&
          typeof host.element.animate === "function";
        const forceZeroDelay =
          options.forceZeroDelay ||
          options.forceZeroDelayLineIds?.has(host.lineId) === true;
        const delayMs = forceZeroDelay
          ? 0
          : resolveRowMoveDelay(
              host.adapterIndex,
              transaction.anchorAdapterIndex,
              moved || scaleChanged,
            );
        const sample = freezeSample({
          lineId: host.lineId,
          adapterIndex: host.adapterIndex,
          sourceIndex: host.sourceIndex,
          deltaY: Number((moved ? deltaY : 0).toFixed(3)),
          fromScale: Number(before.scale.toFixed(5)),
          toScale: Number(targetScale.toFixed(5)),
          moved,
          scaleChanged,
          animated,
          delayMs: animated ? delayMs : 0,
          durationMs: animated ? transaction.durationMs : 0,
        });
        samples.push(sample);
        host.element.dataset.rowMoveDeltaY = String(sample.deltaY);
        host.element.dataset.rowMoveDelayMs = String(sample.delayMs);
        host.element.dataset.rowMoveDurationMs = String(sample.durationMs);
        host.element.dataset.rowMoveScaleFrom = String(sample.fromScale);
        host.element.dataset.rowMoveScaleTo = String(sample.toScale);
        if (!animated) continue;

        const animation = host.element.animate(
          [
            {
              transform: `translateY(${sample.deltaY}px)`,
              scale: String(sample.fromScale),
            },
            { transform: "translateY(0px)", scale: String(sample.toScale) },
          ],
          {
            duration: transaction.durationMs,
            delay: sample.delayMs,
            easing: transaction.easing,
            // Match the item-move handoff: hold the captured presentation
            // during stagger, then release each row as soon as it finishes.
            // A forwards fill would keep an old scale above newer row state
            // until the slowest animation in the batch settles.
            fill: "backwards",
          },
        );
        if (typeof timelineTime === "number" && Number.isFinite(timelineTime)) {
          animation.startTime = timelineTime;
        }
        this.#animations.set(host.lineId, animation);
        animationEntries.push({
          lineId: host.lineId,
          element: host.element,
          animation,
        });
      }
    } catch (error) {
      this.#cancelAnimations(false);
      this.#clearOwnership();
      this.#samples = Object.freeze(samples);
      this.#reason = `${transaction.reason}-creation-failed`;
      throw error;
    }

    this.#samples = Object.freeze(samples);
    if (animationEntries.length === 0) {
      this.#clearOwnership();
      options.onSettled?.();
      return this.#samples;
    }

    const runId = this.#runId;
    void Promise.allSettled(
      animationEntries.map(({ animation }) => animation.finished),
    ).then(() => {
      if (this.#destroyed || runId !== this.#runId) return;
      for (const { lineId, animation } of animationEntries) {
        if (this.#animations.get(lineId) !== animation) continue;
        this.#animations.delete(lineId);
        try {
          animation.cancel();
        } catch {
          // The semantic target is already the underlying style.
        }
      }
      this.#clearOwnership();
      this.#reason = `${transaction.reason}-settled`;
      options.onSettled?.();
    });
    return this.#samples;
  }

  cancel(reason = "cancelled"): void {
    if (this.#destroyed) return;
    this.#runId += 1;
    this.#cancelAnimations(false);
    this.#clearOwnership();
    this.#samples = Object.freeze([]);
    this.#reason = reason;
  }

  getState(): RowMoveState {
    return Object.freeze({
      runId: this.#runId,
      running: this.#animations.size > 0,
      reason: this.#reason,
      animationCount: this.#animations.size,
      samples: this.#samples,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.cancel("destroyed");
    this.#destroyed = true;
  }

  #cancelAnimations(incrementRunId: boolean): void {
    if (incrementRunId) this.#runId += 1;
    const animations = [...this.#animations.values()];
    this.#animations.clear();
    for (const animation of animations) {
      try {
        animation.cancel();
      } catch {
        // Cleanup remains best-effort; the underlying scale target is semantic.
      }
    }
  }

  #clearOwnership(): void {
    for (const element of this.#ownedElements) {
      if (element.dataset.motionOwner === "row-move") {
        delete element.dataset.motionOwner;
      }
    }
    this.#ownedElements.clear();
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("Row move coordinator is destroyed");
  }
}

export function createRowMoveCoordinator(): RowMoveCoordinator {
  return new RowMoveCoordinatorImpl();
}
