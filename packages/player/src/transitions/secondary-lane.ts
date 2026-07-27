import type {
  SecondaryLaneLayoutState,
  SecondaryLaneTarget,
} from "../layout/secondary-lane.js";
import type { PlaybackFrameMode } from "../playback/create-playback-frame.js";

export type SecondaryLaneVisualState =
  | "none"
  | "expanded"
  | "collapsed"
  | "expanding"
  | "collapsing";

export interface SecondaryLaneHost {
  readonly lineId: string;
  readonly documentIndex: number;
  readonly rowElement: HTMLElement;
  readonly laneElement: HTMLElement;
}

export interface SecondaryLaneMetrics {
  readonly heightPx: number;
  readonly marginTopPx: number;
  readonly opacity: number;
  readonly scale: number;
}

export type SecondaryLanePresentation = ReadonlyMap<
  string,
  SecondaryLaneMetrics
>;

export interface PreparedSecondaryLaneChange {
  readonly host: SecondaryLaneHost;
  readonly target: SecondaryLaneTarget;
  readonly visualTarget: "none" | "expanded" | "collapsed";
  readonly from: SecondaryLaneMetrics;
  readonly to: SecondaryLaneMetrics;
  readonly layoutDeltaPx: number;
}

export interface PreparedSecondaryLanePlan {
  readonly id: number;
  readonly changes: readonly PreparedSecondaryLaneChange[];
  layoutDeltaBefore(documentIndex: number): number;
}

export interface SecondaryLaneTransitionOptions {
  readonly playing: boolean;
  readonly frameMode: PlaybackFrameMode;
  readonly reducedMotion: boolean;
  readonly durationMs: number;
  readonly allowSeekAnimation?: boolean;
  readonly easing?: string;
  readonly directTargets?: {
    readonly hosts: readonly SecondaryLaneHost[];
    readonly targets: readonly SecondaryLaneLayoutState[];
    readonly invalidateLineIds?: readonly string[];
  };
  readonly onGeometryInvalidated?: (lineIds: readonly string[]) => void;
  readonly onSettled?: (lineIds: readonly string[]) => void;
}

export interface SecondaryLaneLineState {
  readonly lineId: string;
  readonly target: SecondaryLaneTarget;
  readonly visual: SecondaryLaneVisualState;
  readonly transactionId: number;
  readonly animationCount: number;
  readonly playbackGuard:
    | "playing-playback-animating"
    | "playing-click-seek-animating"
    | "paused-direct-settle"
    | `direct-settle-frame-mode-${PlaybackFrameMode}`
    | "reduced-motion-direct-settle"
    | "zero-duration-direct-settle"
    | "controller-direct-settle";
  readonly revealPolicy:
    | "shared-row-window-web-policy"
    | "direct-settle";
}

export interface SecondaryLaneTransitionState {
  readonly runId: number;
  readonly running: boolean;
  readonly animationCount: number;
  readonly lines: readonly SecondaryLaneLineState[];
}

export interface SecondaryLaneTransition {
  capture(hosts: readonly SecondaryLaneHost[]): SecondaryLanePresentation;
  prepare(
    hosts: readonly SecondaryLaneHost[],
    targets: readonly SecondaryLaneLayoutState[],
    presentation?: SecondaryLanePresentation,
  ): PreparedSecondaryLanePlan;
  transition(
    plan: PreparedSecondaryLanePlan,
    options: SecondaryLaneTransitionOptions,
  ): void;
  cancel(reason?: string): void;
  getAnimationCount(): number;
  getState(): SecondaryLaneTransitionState;
  destroy(): void;
}

const DEFAULT_EASING = "cubic-bezier(0.4, 0.1, 0, 1)";
/** Match --am-lp-curve-alpha (AM activate PathInterpolator). */
const ALPHA_EASING = "cubic-bezier(0.2, 0, 0.35, 1)";
const FALLBACK_EXPANDED_MARGIN_TOP_PX = 0;
const REVEAL_SCALE = 0.9;
const REVEAL_DURATION_MS = 500;
const COLLAPSE_ALPHA_DURATION_MS = 250;
const COLLAPSE_SCALE_DURATION_MS = 500;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cssNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readElementScale(element: HTMLElement): number {
  const view = element.ownerDocument.defaultView;
  return Math.max(
    0.0001,
    cssNumber(view?.getComputedStyle(element).scale ?? "", 1),
  );
}

function readMetrics(lane: HTMLElement): SecondaryLaneMetrics {
  const view = lane.ownerDocument.defaultView;
  const style = view?.getComputedStyle(lane);
  const rect = lane.getBoundingClientRect();
  const scale = clamp(readElementScale(lane), REVEAL_SCALE, 1);
  const computedHeight = cssNumber(style?.height ?? "", Number.NaN);
  return Object.freeze({
    // `getBoundingClientRect()` already includes individual `scale`. Keep the
    // layout and scale axes independent so a rapid reversal cannot apply scale
    // twice to the next height keyframe.
    heightPx: Math.max(
      0,
      Number.isFinite(computedHeight) ? computedHeight : rect.height / scale,
    ),
    marginTopPx: Math.max(0, cssNumber(style?.marginTop ?? "", 0)),
    opacity: clamp(cssNumber(style?.opacity ?? "", 1), 0, 1),
    scale,
  });
}

function expandedLayoutHeight(host: SecondaryLaneHost): number {
  const { laneElement: lane, rowElement: row } = host;
  const view = lane.ownerDocument.defaultView;
  const laneStyle = view?.getComputedStyle(lane);
  const laneRect = lane.getBoundingClientRect();
  const visualScale = readElementScale(row) * readElementScale(lane);
  const paddingBottomPx = Math.max(
    0,
    cssNumber(laneStyle?.paddingBottom ?? "", 0),
  );
  let contentBottomPx = 0;

  // `scrollHeight` includes karaoke glow pseudo-element overflow, while
  // `offsetHeight` rounds fractional font metrics. Direct child border boxes
  // exclude visual overflow; normalizing their transformed rectangles keeps
  // the exact half-pixel line boxes used by the final auto height.
  for (const child of Array.from(lane.children) as HTMLElement[]) {
    const childRect = child.getBoundingClientRect();
    if (childRect.height <= 0) continue;
    const childStyle = view?.getComputedStyle(child);
    const marginBottomPx = Math.max(
      0,
      cssNumber(childStyle?.marginBottom ?? "", 0),
    );
    contentBottomPx = Math.max(
      contentBottomPx,
      (childRect.bottom - laneRect.top) / visualScale + marginBottomPx,
    );
  }

  return Math.max(1, contentBottomPx + paddingBottomPx);
}

function targetMetrics(
  host: SecondaryLaneHost,
  target: SecondaryLaneTarget,
): SecondaryLaneMetrics {
  const lane = host.laneElement;
  if (target !== "expanded") {
    return Object.freeze({
      heightPx: 0,
      marginTopPx: 0,
      opacity: 0,
      scale: REVEAL_SCALE,
    });
  }
  const view = lane.ownerDocument.defaultView;
  const style = view?.getComputedStyle(lane);
  const expandedMarginTopPx = Math.max(
    0,
    cssNumber(
      style?.getPropertyValue("--am-lp-secondary-lane-margin-top") ?? "",
      FALLBACK_EXPANDED_MARGIN_TOP_PX,
    ),
  );
  return Object.freeze({
    heightPx: expandedLayoutHeight(host),
    marginTopPx: expandedMarginTopPx,
    opacity: 1,
    scale: 1,
  });
}

function sameMetrics(
  left: SecondaryLaneMetrics,
  right: SecondaryLaneMetrics,
): boolean {
  return (
    Math.abs(left.heightPx - right.heightPx) < 0.5 &&
    Math.abs(left.marginTopPx - right.marginTopPx) < 0.5 &&
    Math.abs(left.opacity - right.opacity) < 0.01 &&
    Math.abs(left.scale - right.scale) < 0.001
  );
}

function visualTarget(
  target: SecondaryLaneTarget,
): "none" | "expanded" | "collapsed" {
  return target === "none" ? "none" : target;
}

function setFinalStyles(
  lane: HTMLElement,
  target: SecondaryLaneTarget,
  metrics: SecondaryLaneMetrics,
  animating: boolean,
): void {
  lane.dataset.laneTarget = target;
  lane.dataset.laneVisual = animating
    ? target === "expanded"
      ? "expanding"
      : "collapsing"
    : visualTarget(target);
  lane.style.height = `${metrics.heightPx}px`;
  lane.style.marginTop = `${metrics.marginTopPx}px`;
  lane.style.opacity = String(metrics.opacity);
  lane.style.scale = String(metrics.scale);
  lane.style.overflow = "hidden";
  lane.style.visibility = animating || target === "expanded" ? "visible" : "hidden";
  lane.style.pointerEvents = target === "expanded" ? "" : "none";
  lane.inert = target !== "expanded";
  lane.setAttribute("aria-hidden", String(target !== "expanded"));
}

function settleStyles(
  lane: HTMLElement,
  target: SecondaryLaneTarget,
): void {
  lane.dataset.laneTarget = target;
  lane.dataset.laneVisual = visualTarget(target);
  lane.style.removeProperty("height");
  lane.style.removeProperty("margin-top");
  lane.style.removeProperty("opacity");
  lane.style.removeProperty("scale");
  lane.style.removeProperty("overflow");
  lane.style.removeProperty("visibility");
  lane.style.removeProperty("pointer-events");
  lane.inert = target !== "expanded";
  lane.setAttribute("aria-hidden", String(target !== "expanded"));
}

function safeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

class SecondaryLaneTransitionImpl implements SecondaryLaneTransition {
  #runId = 0;
  #animations = new Set<Animation>();
  #lineStates = new Map<string, SecondaryLaneLineState>();
  #activeHosts = new Map<string, SecondaryLaneHost>();
  #destroyed = false;

  capture(hosts: readonly SecondaryLaneHost[]): SecondaryLanePresentation {
    this.#assertAlive();
    const metrics = new Map<string, SecondaryLaneMetrics>();
    for (const host of hosts) metrics.set(host.lineId, readMetrics(host.laneElement));
    return metrics;
  }

  prepare(
    hosts: readonly SecondaryLaneHost[],
    targets: readonly SecondaryLaneLayoutState[],
    presentation: SecondaryLanePresentation = this.capture(hosts),
  ): PreparedSecondaryLanePlan {
    this.#assertAlive();
    const targetByLineId = new Map(targets.map((state) => [state.lineId, state]));
    const changes: PreparedSecondaryLaneChange[] = [];
    for (const host of hosts) {
      const target = targetByLineId.get(host.lineId)?.target ?? "none";
      const from = presentation.get(host.lineId) ?? readMetrics(host.laneElement);
      const to = targetMetrics(host, target);
      const previousTarget = this.#lineStates.get(host.lineId)?.target;
      if (previousTarget === target && sameMetrics(from, to)) continue;
      changes.push(
        Object.freeze({
          host,
          target,
          visualTarget: visualTarget(target),
          from,
          to,
          layoutDeltaPx:
            to.heightPx + to.marginTopPx - from.heightPx - from.marginTopPx,
        }),
      );
    }
    const id = this.#runId + 1;
    const frozenChanges = Object.freeze(changes);
    return Object.freeze({
      id,
      changes: frozenChanges,
      layoutDeltaBefore(documentIndex: number): number {
        return frozenChanges.reduce(
          (total, change) =>
            change.host.documentIndex < documentIndex
              ? total + change.layoutDeltaPx
              : total,
          0,
        );
      },
    });
  }

  transition(
    plan: PreparedSecondaryLanePlan,
    options: SecondaryLaneTransitionOptions,
  ): void {
    this.#assertAlive();
    const previouslyAnimating = [...this.#lineStates.values()].flatMap(
      (state) => {
        const host = this.#activeHosts.get(state.lineId);
        return state.animationCount > 0 && host ? [{ state, host }] : [];
      },
    );
    this.#cancelAnimations();
    this.#runId = Math.max(this.#runId + 1, plan.id);
    const runId = this.#runId;
    const durationMs = safeDuration(options.durationMs);
    const clickSeekAnimation =
      options.frameMode === "seek" && options.allowSeekAnimation === true;
    const animate =
      options.playing &&
      (options.frameMode === "playback" || clickSeekAnimation) &&
      !options.reducedMotion &&
      durationMs > 0;
    const playbackGuard: SecondaryLaneLineState["playbackGuard"] =
      options.reducedMotion
        ? "reduced-motion-direct-settle"
        : durationMs <= 0
          ? "zero-duration-direct-settle"
          : !options.playing
            ? "paused-direct-settle"
            : options.frameMode !== "playback" && !clickSeekAnimation
              ? `direct-settle-frame-mode-${options.frameMode}`
              : clickSeekAnimation
                ? "playing-click-seek-animating"
                : "playing-playback-animating";
    const changedLineIds = Object.freeze(
      plan.changes.map((change) => change.host.lineId),
    );
    const animatedLineIds = new Set(changedLineIds);
    const directTargets = options.directTargets;
    const directTargetByLineId = new Map(
      directTargets?.targets.map((state) => [state.lineId, state.target]) ?? [],
    );
    const directLineIds: string[] = [];
    for (const host of directTargets?.hosts ?? []) {
      if (animatedLineIds.has(host.lineId)) continue;
      const target = directTargetByLineId.get(host.lineId) ?? "none";
      settleStyles(host.laneElement, target);
      host.rowElement.dataset.secondaryLaneTransition =
        "controller-direct-settle";
      this.#activeHosts.set(host.lineId, host);
      this.#lineStates.set(
        host.lineId,
        Object.freeze({
          lineId: host.lineId,
          target,
          visual: visualTarget(target),
          transactionId: runId,
          animationCount: 0,
          playbackGuard: "controller-direct-settle",
          revealPolicy: "direct-settle",
        }),
      );
      directLineIds.push(host.lineId);
    }
    const coveredLineIds = new Set([...changedLineIds, ...directLineIds]);
    const supersededLineIds: string[] = [];
    for (const { state, host } of previouslyAnimating) {
      if (coveredLineIds.has(state.lineId)) continue;
      settleStyles(host.laneElement, state.target);
      host.rowElement.dataset.secondaryLaneTransition = "superseded-settle";
      this.#lineStates.set(
        state.lineId,
        Object.freeze({
          ...state,
          visual: visualTarget(state.target),
          transactionId: runId,
          animationCount: 0,
          playbackGuard: "controller-direct-settle",
          revealPolicy: "direct-settle",
        }),
      );
      supersededLineIds.push(state.lineId);
    }
    const geometryLineIds = Object.freeze([
      ...new Set([
        ...changedLineIds,
        ...(directTargets?.invalidateLineIds ?? []),
        ...supersededLineIds,
      ]),
    ]);
    const settledLineIds = Object.freeze([
      ...changedLineIds,
      ...directLineIds,
      ...supersededLineIds,
    ]);

    if (plan.changes.length === 0) {
      try {
        if (geometryLineIds.length > 0) {
          options.onGeometryInvalidated?.(geometryLineIds);
        }
      } catch (error) {
        this.cancel("geometry-invalidation-failed");
        throw error;
      }
      options.onSettled?.(settledLineIds);
      return;
    }

    if (!animate) {
      for (const change of plan.changes) {
        settleStyles(change.host.laneElement, change.target);
        this.#activeHosts.set(change.host.lineId, change.host);
        this.#lineStates.set(
          change.host.lineId,
          Object.freeze({
            lineId: change.host.lineId,
            target: change.target,
            visual: change.visualTarget,
            transactionId: runId,
            animationCount: 0,
            playbackGuard,
            revealPolicy: "direct-settle",
          }),
        );
      }
      try {
        options.onGeometryInvalidated?.(geometryLineIds);
      } catch (error) {
        this.cancel("geometry-invalidation-failed");
        throw error;
      }
      options.onSettled?.(settledLineIds);
      return;
    }

    const created: Animation[] = [];
    const timelineTime =
      plan.changes[0]?.host.laneElement.ownerDocument.timeline?.currentTime ??
      null;
    try {
      for (const change of plan.changes) {
        const lane = change.host.laneElement;
        this.#activeHosts.set(change.host.lineId, change.host);
        setFinalStyles(lane, change.target, change.to, true);
        const layout = lane.animate(
          [
            {
              height: `${change.from.heightPx}px`,
              marginTop: `${change.from.marginTopPx}px`,
            },
            {
              height: `${change.to.heightPx}px`,
              marginTop: `${change.to.marginTopPx}px`,
            },
          ],
          {
            duration: durationMs,
            easing: options.easing ?? DEFAULT_EASING,
            fill: "both",
          },
        );
        created.push(layout);

        if (change.target === "expanded") {
          const revealDurationMs = Math.min(REVEAL_DURATION_MS, durationMs);
          const reveal = lane.animate(
            [
              { opacity: change.from.opacity, scale: String(change.from.scale) },
              { opacity: change.to.opacity, scale: String(change.to.scale) },
            ],
            {
              duration: revealDurationMs,
              delay: durationMs - revealDurationMs,
              easing: options.easing ?? DEFAULT_EASING,
              fill: "both",
            },
          );
          created.push(reveal);
        } else {
          const alpha = lane.animate(
            [{ opacity: change.from.opacity }, { opacity: change.to.opacity }],
            {
              duration: Math.min(COLLAPSE_ALPHA_DURATION_MS, durationMs),
              easing: ALPHA_EASING,
              fill: "both",
            },
          );
          const scale = lane.animate(
            [{ scale: String(change.from.scale) }, { scale: String(change.to.scale) }],
            {
              duration: Math.min(COLLAPSE_SCALE_DURATION_MS, durationMs),
              easing: options.easing ?? DEFAULT_EASING,
              fill: "both",
            },
          );
          created.push(alpha, scale);
        }
        for (const animation of created) {
          if (this.#animations.has(animation)) continue;
          if (typeof timelineTime === "number" && Number.isFinite(timelineTime)) {
            animation.startTime = timelineTime;
          }
          this.#animations.add(animation);
        }
        const lineAnimationCount = change.target === "expanded" ? 2 : 3;
        this.#lineStates.set(
          change.host.lineId,
          Object.freeze({
            lineId: change.host.lineId,
            target: change.target,
            visual:
              change.target === "expanded" ? "expanding" : "collapsing",
            transactionId: runId,
            animationCount: lineAnimationCount,
            playbackGuard,
            revealPolicy: "shared-row-window-web-policy",
          }),
        );
      }
    } catch (error) {
      for (const animation of created) {
        try {
          animation.cancel();
        } catch {
          // Continue settling every lane to its semantic target.
        }
      }
      this.#animations.clear();
      for (const change of plan.changes) {
        settleStyles(change.host.laneElement, change.target);
      }
      throw error;
    }

    try {
      options.onGeometryInvalidated?.(geometryLineIds);
    } catch (error) {
      this.cancel("geometry-invalidation-failed");
      throw error;
    }
    void Promise.allSettled(created.map((animation) => animation.finished)).then(
      () => {
        if (this.#destroyed || runId !== this.#runId) return;
        for (const animation of created) {
          this.#animations.delete(animation);
          try {
            animation.cancel();
          } catch {
            // Underlying styles already represent the target.
          }
        }
        for (const change of plan.changes) {
          settleStyles(change.host.laneElement, change.target);
          this.#lineStates.set(
            change.host.lineId,
            Object.freeze({
              lineId: change.host.lineId,
              target: change.target,
              visual: change.visualTarget,
              transactionId: runId,
              animationCount: 0,
              playbackGuard,
              revealPolicy: "shared-row-window-web-policy",
            }),
          );
        }
        options.onSettled?.(settledLineIds);
      },
    );
  }

  cancel(reason = "cancelled"): void {
    if (this.#destroyed) return;
    this.#runId += 1;
    this.#cancelAnimations();
    for (const [lineId, host] of this.#activeHosts) {
      const target = this.#lineStates.get(lineId)?.target ?? "none";
      settleStyles(host.laneElement, target);
      this.#lineStates.set(
        lineId,
        Object.freeze({
          lineId,
          target,
          visual: visualTarget(target),
          transactionId: this.#runId,
          animationCount: 0,
          playbackGuard: "direct-settle-frame-mode-reset",
          revealPolicy: "direct-settle",
        }),
      );
      host.rowElement.dataset.secondaryLaneTransition = reason;
    }
    if (reason === "source-replacement" || reason === "destroyed") {
      this.#activeHosts.clear();
      this.#lineStates.clear();
    }
  }

  getState(): SecondaryLaneTransitionState {
    return Object.freeze({
      runId: this.#runId,
      running: this.#animations.size > 0,
      animationCount: this.#animations.size,
      lines: Object.freeze([...this.#lineStates.values()]),
    });
  }

  getAnimationCount(): number {
    return this.#animations.size;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.cancel("destroyed");
    this.#activeHosts.clear();
    this.#lineStates.clear();
    this.#destroyed = true;
  }

  #cancelAnimations(): void {
    const animations = [...this.#animations];
    this.#animations.clear();
    for (const animation of animations) {
      try {
        animation.cancel();
      } catch {
        // The next state write settles the lane.
      }
    }
  }

  #assertAlive(): void {
    if (this.#destroyed) {
      throw new Error("Secondary lane transition is destroyed");
    }
  }
}

export function createSecondaryLaneTransition(): SecondaryLaneTransition {
  return new SecondaryLaneTransitionImpl();
}
