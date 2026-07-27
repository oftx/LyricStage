import type { LyricDocument } from "../domain/types.js";
import type {
  LyricLayoutPlan,
  LyricLineLayoutPlan,
} from "../layout/layout-plan.js";
import type { PlaybackFrame } from "../playback/create-playback-frame.js";
import { applyRowLayout } from "../view/row-view.js";
import {
  INSTRUMENTAL_REST_OUTER_INSET_PX,
  sampleInstrumentalAnimation,
  type InstrumentalAnimationState,
} from "./animation.js";
import {
  advanceInstrumentalSession,
  createIdleInstrumentalSession,
  type InstrumentalSessionState,
} from "./session.js";
import {
  createInstrumentalTimingContext,
  type InstrumentalTiming,
  type InstrumentalTimingContext,
} from "./timing.js";

export interface InstrumentalRenderOptions {
  readonly playing: boolean;
  readonly reducedMotion?: boolean;
}

export interface InstrumentalRendererOptions {
  readonly container: HTMLElement;
  readonly resolveTextRow: (lineId: string) => HTMLElement | null;
  readonly now?: () => number;
}

export interface InstrumentalRendererState {
  readonly session: InstrumentalSessionState;
  readonly animation: InstrumentalAnimationState | null;
  readonly mountedLineId: string | null;
}

export interface InstrumentalRenderer {
  setDocument(
    document: LyricDocument | null,
    layoutPlan: LyricLayoutPlan | null,
  ): void;
  renderFrame(frame: PlaybackFrame, options: InstrumentalRenderOptions): void;
  resetPlaybackState(): void;
  getState(): InstrumentalRendererState;
  destroy(): void;
}

interface InstrumentalRow {
  readonly lineId: string;
  readonly element: HTMLElement;
  readonly scaleHost: HTMLElement;
  readonly dots: readonly [HTMLElement, HTMLElement, HTMLElement];
}

const hiddenAnimationState: InstrumentalAnimationState = Object.freeze({
  lineId: null,
  phase: "hidden",
  visible: false,
  animationRunning: false,
  rootScale: 1,
  rootAlpha: 0,
  dotOpacity: Object.freeze([0, 0, 0]) as readonly [number, number, number],
  dotTintProgress: Object.freeze([0, 0, 0]) as readonly [
    number,
    number,
    number,
  ],
  breathingCycleMs: null,
  breathingProgress: 0,
  exitProgress: 0,
});

function cssNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(5) : "0.00000";
}

function getLayout(
  layoutPlan: LyricLayoutPlan,
  lineId: string,
): LyricLineLayoutPlan {
  const layout = layoutPlan.getByLineId(lineId);
  if (!layout) {
    throw new Error(`Missing layout for instrumental line "${lineId}"`);
  }
  return layout;
}

function createDot(ownerDocument: Document, index: number): HTMLElement {
  const dot = ownerDocument.createElement("span");
  dot.className = "am-lp-instrumental-dot";
  dot.dataset.dotIndex = String(index);
  return dot;
}

function createRow(
  ownerDocument: Document,
  timing: InstrumentalTiming,
  layout: LyricLineLayoutPlan,
): InstrumentalRow {
  const element = ownerDocument.createElement("div");
  element.className = "am-lp-row am-lp-instrumental-row";
  element.dataset.lineId = timing.lineId;
  element.dataset.visualState = "instrumental";
  element.setAttribute("part", "row instrumental-row");
  element.setAttribute("role", "presentation");

  const scaleHost = ownerDocument.createElement("div");
  scaleHost.className = "am-lp-instrumental-scale-host";
  const chain = ownerDocument.createElement("div");
  chain.className = "am-lp-instrumental-dot-chain";
  const dots = Object.freeze([
    createDot(ownerDocument, 0),
    createDot(ownerDocument, 1),
    createDot(ownerDocument, 2),
  ]) as readonly [HTMLElement, HTMLElement, HTMLElement];
  // Scale the tight three-dot host around its geometric center; chain margins
  // only align the packed outer edge with lyric content.
  chain.append(...dots);
  scaleHost.append(chain);
  element.append(scaleHost);
  applyRowLayout(element, layout);
  return { lineId: timing.lineId, element, scaleHost, dots };
}

class InstrumentalRendererImpl implements InstrumentalRenderer {
  readonly #container: HTMLElement;
  readonly #resolveTextRow: (lineId: string) => HTMLElement | null;
  readonly #now: () => number;
  #context: InstrumentalTimingContext | null = null;
  #layoutPlan: LyricLayoutPlan | null = null;
  #session = createIdleInstrumentalSession();
  #animation: InstrumentalAnimationState | null = null;
  #row: InstrumentalRow | null = null;
  #destroyed = false;

  constructor(options: InstrumentalRendererOptions) {
    this.#container = options.container;
    this.#resolveTextRow = options.resolveTextRow;
    const viewPerformance = options.container.ownerDocument.defaultView?.performance;
    this.#now =
      options.now ??
      (() =>
        viewPerformance?.now() ??
        globalThis.performance?.now() ??
        Date.now());
  }

  setDocument(
    document: LyricDocument | null,
    layoutPlan: LyricLayoutPlan | null,
  ): void {
    this.#assertAlive();
    this.#removeRow();
    this.#animation = null;
    if (!document) {
      this.#context = null;
      this.#layoutPlan = null;
      this.#session = createIdleInstrumentalSession();
      return;
    }
    if (!layoutPlan || layoutPlan.documentId !== document.id) {
      throw new Error("Instrumental renderer requires a matching layout plan");
    }
    this.#context = createInstrumentalTimingContext(document);
    this.#layoutPlan = layoutPlan;
    this.#session = createIdleInstrumentalSession(document.id);
  }

  renderFrame(frame: PlaybackFrame, options: InstrumentalRenderOptions): void {
    this.#assertAlive();
    const context = this.#context;
    const layoutPlan = this.#layoutPlan;
    if (!context || !layoutPlan || frame.documentId !== context.documentId) return;

    this.#session = advanceInstrumentalSession(context, this.#session, {
      frame,
      playing: options.playing,
      triggerClockMs: this.#now(),
    });
    const timing = this.#session.lineId
      ? context.getByLineId(this.#session.lineId)
      : null;
    this.#animation = sampleInstrumentalAnimation(this.#session, timing, {
      ...(options.reducedMotion === undefined
        ? {}
        : { reducedMotion: options.reducedMotion }),
    });

    if (
      !timing ||
      this.#session.presence === "absent" ||
      !this.#animation.visible
    ) {
      this.#removeRow();
      return;
    }
    const row = this.#ensureRow(timing, getLayout(layoutPlan, timing.lineId));
    this.#applyAnimation(row, this.#animation);
  }

  resetPlaybackState(): void {
    this.#assertAlive();
    this.#session = createIdleInstrumentalSession(this.#context?.documentId ?? null);
    this.#animation = hiddenAnimationState;
    this.#removeRow();
  }

  getState(): InstrumentalRendererState {
    return Object.freeze({
      session: this.#session,
      animation: this.#animation,
      mountedLineId: this.#row?.lineId ?? null,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#removeRow();
    this.#context = null;
    this.#layoutPlan = null;
    this.#session = createIdleInstrumentalSession();
    this.#animation = null;
  }

  #ensureRow(
    timing: InstrumentalTiming,
    layout: LyricLineLayoutPlan,
  ): InstrumentalRow {
    if (this.#row?.lineId === timing.lineId) return this.#row;
    this.#removeRow();
    const row = createRow(this.#container.ownerDocument, timing, layout);
    const nextTextRow = this.#resolveTextRow(timing.nextLineId);
    if (nextTextRow?.parentElement === this.#container) {
      this.#container.insertBefore(row.element, nextTextRow);
    } else {
      this.#container.append(row.element);
    }
    this.#row = row;
    return row;
  }

  #applyAnimation(
    row: InstrumentalRow,
    animation: InstrumentalAnimationState,
  ): void {
    row.element.dataset.phase = animation.phase;
    row.element.dataset.animationRunning = String(animation.animationRunning);
    row.element.dataset.rowPresence = this.#session.presence;
    // Peak-scale outer edge flush: inset the rest layout by centerToEdge*(peak-1)
    // so pure geometric-center scale never pushes past the lyric content edge.
    // This is a static rest inset, not a mid-animation bounce against the edge.
    const endEdge = row.element.dataset.agentSide === "end";
    row.scaleHost.style.marginInlineStart = endEdge
      ? "0px"
      : `${INSTRUMENTAL_REST_OUTER_INSET_PX}px`;
    row.scaleHost.style.marginInlineEnd = endEdge
      ? `${INSTRUMENTAL_REST_OUTER_INSET_PX}px`
      : "0px";
    row.scaleHost.dataset.restOuterInsetPx = String(
      Number(INSTRUMENTAL_REST_OUTER_INSET_PX.toFixed(3)),
    );
    row.element.style.setProperty(
      "--am-lp-instrumental-alpha",
      cssNumber(animation.rootAlpha),
    );
    row.element.style.setProperty(
      "--am-lp-instrumental-scale",
      cssNumber(animation.rootScale),
    );
    row.dots.forEach((dot, index) => {
      dot.style.setProperty(
        "--am-lp-instrumental-dot-alpha",
        cssNumber(animation.dotOpacity[index] ?? 0),
      );
      dot.style.setProperty(
        "--am-lp-instrumental-dot-tint",
        cssNumber(animation.dotTintProgress[index] ?? 0),
      );
    });
  }

  #removeRow(): void {
    this.#row?.element.remove();
    this.#row = null;
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("Instrumental renderer is destroyed");
  }
}

export function createInstrumentalRenderer(
  options: InstrumentalRendererOptions,
): InstrumentalRenderer {
  return new InstrumentalRendererImpl(options);
}
