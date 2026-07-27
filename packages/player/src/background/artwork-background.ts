const BACKGROUND_FRAME_INTERVAL_MS = 42;
const BACKGROUND_CONSTRAINED_FRAME_INTERVAL_MS = 83;
const BACKGROUND_CRITICAL_FRAME_INTERVAL_MS = 1000;
export const BACKGROUND_CROSSFADE_DURATION_MS = 1000;
const BACKGROUND_CROSSFADE_EASING = "cubic-bezier(0, 0, 0.3, 1)";
const BACKGROUND_SCALE_MULTIPLIER = 1.3;
const BACKGROUND_BLUR_RADIUS_PX = 25;
/**
 * Blur as a fraction of the artwork's core-space span. Calibrated to the
 * accepted look of a 158px-wide panel (core 60x296, artwork ~385px, blur
 * 25px → 0.065) so all viewport shapes reproduce that vividness.
 */
const BACKGROUND_BLUR_TO_ARTWORK_RATIO = 0.065;
const BACKGROUND_NORMAL_CORE_SHORT_SIDE_PX = 60;
const BACKGROUND_DEGRADED_CORE_SHORT_SIDE_PX = 30;
const BACKGROUND_REDUCED_CORE_SHORT_SIDE_PX = 20;
const BACKGROUND_MAX_CORE_LONG_SIDE_PX = 512;
const BACKGROUND_MAX_ARTWORK_SOURCE_SIDE_PX = 1024;
const BACKGROUND_BLUR_GUARD_MULTIPLIER = 3;
const BACKGROUND_ARTWORK_FALLBACK_COLOR = "#08080a";
const BACKGROUND_PLAIN_FALLBACK_COLORS = Object.freeze({
  light: "#ffffff",
  dark: "#000000",
});
const BACKGROUND_MAX_CANVAS_PIXELS = 3_000_000;
const BACKGROUND_SLOW_DRAW_THRESHOLD_MS = 15;
const BACKGROUND_TICK_PRESSURE_THRESHOLD_MS = 45;
const BACKGROUND_TICK_SEVERE_THRESHOLD_MS = 100;
const BACKGROUND_DRAW_SEVERE_THRESHOLD_MS = 30;
const BACKGROUND_PRESSURE_DECAY_PER_SECOND = 8;
const BACKGROUND_DRAW_PRESSURE_DECAY_PER_SECOND = 6;
const BACKGROUND_MAX_PRESSURE_SCORE = 64;
const BACKGROUND_CONSTRAINED_SCORE = 12;
const BACKGROUND_CRITICAL_SCORE = 36;
const BACKGROUND_CRITICAL_RECOVERY_SCORE = 8;
const BACKGROUND_NORMAL_RECOVERY_SCORE = 3;
const BACKGROUND_CRITICAL_RECOVERY_MS = 4000;
const BACKGROUND_NORMAL_RECOVERY_MS = 5000;
const BACKGROUND_SCRIMS = Object.freeze({
  light: Object.freeze({ blackAlpha: 16 / 255, whiteAlpha: 54 / 255 }),
  dark: Object.freeze({ blackAlpha: 128 / 255, whiteAlpha: 13 / 255 }),
});
const BACKGROUND_ARTWORK_TONES = Object.freeze({
  light: Object.freeze({ brightness: 0.82, contrast: 1.14, saturation: 2.8 }),
  dark: Object.freeze({ brightness: 0.9, contrast: 1.1, saturation: 2.6 }),
});
/**
 * Vibrance-style adaptation: the fixed saturate() multiplier looks great on
 * mid-saturation covers but turns near-gray artwork into muddy color noise
 * and clips vivid artwork to neon. Scale the multiplier by the artwork's own
 * mean saturation so both extremes converge toward a tasteful middle.
 * The factor maps mean HSL saturation s∈[0,1] to a multiplier weight:
 *   s ≈ 0   → 0.35 (barely boost gray covers — keep them intentionally muted)
 *   s ≈ 0.3 → 1.0  (sweet spot: full configured boost)
 *   s ≈ 0.8+→ 0.55 (already vivid: back off before it clips)
 */
function vibranceWeight(meanSaturation: number): number {
  const s = Math.min(1, Math.max(0, meanSaturation));
  if (s < 0.3) return 0.35 + (s / 0.3) * 0.65;
  return 1 - Math.min(1, (s - 0.3) / 0.5) * 0.45;
}

/** Mean HSL saturation of an artwork, sampled on a small grid. */
function sampleMeanSaturation(source: CanvasImageSource, side: number): number {
  try {
    const probe = document.createElement("canvas");
    const probeSide = 24;
    probe.width = probeSide;
    probe.height = probeSide;
    const context = probe.getContext("2d", { willReadFrequently: true });
    if (!context) return 0.3;
    context.drawImage(source, 0, 0, side, side, 0, 0, probeSide, probeSide);
    const data = context.getImageData(0, 0, probeSide, probeSide).data;
    let total = 0;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index]! / 255;
      const g = data[index + 1]! / 255;
      const b = data[index + 2]! / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lightness = (max + min) / 2;
      const delta = max - min;
      const saturation = delta === 0
        ? 0
        : delta / (1 - Math.abs(2 * lightness - 1) || 1);
      // Very dark / very bright pixels carry little perceived chroma.
      const weight = 1 - Math.abs(2 * lightness - 1) * 0.6;
      total += saturation * weight;
      count += weight;
    }
    probe.width = 1;
    probe.height = 1;
    return count > 0 ? total / count : 0.3;
  } catch {
    return 0.3; // sweet-spot default: behaves exactly like the old constants
  }
}
const BACKGROUND_REDUCED_MOTION_SATURATION_GAIN = 0.8;

const BACKGROUND_LAYERS = Object.freeze([
  Object.freeze({
    periodMs: 120_000,
    direction: -1,
    dxMultiplier: 0,
    dyMultiplier: 0,
    extraCanvasRotation: false,
  }),
  Object.freeze({
    periodMs: 90_000,
    direction: 1,
    dxMultiplier: -0.95,
    dyMultiplier: -0.7,
    extraCanvasRotation: false,
  }),
  Object.freeze({
    periodMs: 70_000,
    direction: 1,
    dxMultiplier: -0.5,
    dyMultiplier: 0.7,
    extraCanvasRotation: true,
  }),
] as const);

export type LyricsBackgroundArtworkSource =
  | {
      readonly kind: "url";
      readonly url: string;
      readonly crossOrigin?: "anonymous" | "use-credentials";
    }
  | {
      readonly kind: "blob";
      readonly blob: Blob;
    };

export type LyricsBackgroundAppearance = "light" | "dark";

export type LyricsBackgroundPerformanceTier =
  | "normal"
  | "constrained"
  | "critical";

export type LyricsBackgroundPerformanceMode =
  | "auto"
  | LyricsBackgroundPerformanceTier;

export interface LyricsBackgroundArtworkUpdateOptions {
  readonly transition?: "crossfade" | "immediate";
  readonly signal?: AbortSignal;
}

export interface LyricsBackgroundArtworkUpdateResult {
  readonly status: "applied" | "superseded";
}

export interface ArtworkBackgroundRenderer {
  setArtwork(
    source: LyricsBackgroundArtworkSource | null,
    options?: LyricsBackgroundArtworkUpdateOptions,
  ): Promise<LyricsBackgroundArtworkUpdateResult>;
  setAppearance(appearance: LyricsBackgroundAppearance): void;
  setActive(active: boolean): void;
  setPerformanceMode(mode: LyricsBackgroundPerformanceMode): void;
  setReducedMotion(reducedMotion: boolean): void;
  destroy(): void;
}

export interface ArtworkBackgroundRendererOptions {
  readonly container: HTMLElement;
  readonly previousCanvas: HTMLCanvasElement;
  readonly currentCanvas: HTMLCanvasElement;
  readonly appearance: LyricsBackgroundAppearance;
  readonly active?: boolean;
  readonly reducedMotion: boolean;
}

interface PendingArtworkLoad {
  readonly promise: Promise<HTMLImageElement>;
  cancel(): void;
}

interface PreparedArtwork {
  /** Mean HSL saturation sampled at prepare time; drives vibrance weight. */
  readonly meanSaturation: number;
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  release(): void;
}

interface BackgroundRenderGeometry {
  readonly width: number;
  readonly height: number;
  readonly blurRadius: number;
  readonly blurGuard: number;
}

type BackgroundPerformanceMode = LyricsBackgroundPerformanceTier;

type ObserverWindow = Window & {
  readonly ResizeObserver?: typeof ResizeObserver;
  readonly IntersectionObserver?: typeof IntersectionObserver;
};

class ArtworkLoadCancelledError extends Error {
  constructor() {
    super("Artwork load was superseded");
    this.name = "ArtworkLoadCancelledError";
  }
}

function require2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is required for the lyrics background");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return context;
}

function clampOpacity(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(1, Math.max(0, parsed));
}

function createArtworkLoad(
  document: Document,
  source: LyricsBackgroundArtworkSource,
): PendingArtworkLoad {
  const image = document.createElement("img");
  image.decoding = "async";
  let objectUrl: string | null = null;
  let settled = false;
  let rejectLoad: (reason?: unknown) => void = () => undefined;

  const cleanup = (): void => {
    image.onload = null;
    image.onerror = null;
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  };

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    rejectLoad = reject;
    image.onload = () => {
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          reject(new Error("Artwork has no drawable pixels"));
          return;
        }
        resolve(image);
      };
      const decode = image.decode?.();
      if (decode) void decode.then(finish, finish);
      else finish();
    };
    image.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Artwork could not be decoded"));
    };

    if (source.kind === "blob") {
      objectUrl = URL.createObjectURL(source.blob);
      image.src = objectUrl;
    } else {
      if (source.crossOrigin) image.crossOrigin = source.crossOrigin;
      image.src = source.url;
    }
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
      image.removeAttribute("src");
      rejectLoad(new ArtworkLoadCancelledError());
    },
  };
}

function resizeCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  context?: CanvasRenderingContext2D,
): boolean {
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  if (context) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
  }
  return true;
}

function releaseCanvasBacking(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): void {
  resizeCanvas(canvas, 1, 1, context);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.filter = "none";
  context.clearRect(0, 0, 1, 1);
}

function prepareArtwork(
  document: Document,
  image: HTMLImageElement,
): PreparedArtwork {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const sourceSide = Math.min(sourceWidth, sourceHeight);
  const targetSide = Math.min(
    sourceSide,
    BACKGROUND_MAX_ARTWORK_SOURCE_SIDE_PX,
  );

  let temporaryCanvas: HTMLCanvasElement | null = null;
  let temporaryContext: CanvasRenderingContext2D | null = null;
  try {
    const canvas = document.createElement("canvas");
    temporaryCanvas = canvas;
    const context = require2dContext(canvas);
    temporaryContext = context;
    resizeCanvas(canvas, targetSide, targetSide, context);
    const sourceX = (sourceWidth - sourceSide) / 2;
    const sourceY = (sourceHeight - sourceSide) / 2;
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceSide,
      sourceSide,
      0,
      0,
      targetSide,
      targetSide,
    );
    image.removeAttribute("src");
    let released = false;
    return {
      meanSaturation: sampleMeanSaturation(canvas, targetSide),
      source: canvas,
      width: targetSide,
      height: targetSide,
      release() {
        if (released) return;
        released = true;
        releaseCanvasBacking(canvas, context);
      },
    };
  } catch {
    if (temporaryCanvas) {
      if (temporaryContext) {
        releaseCanvasBacking(temporaryCanvas, temporaryContext);
      }
      else {
        temporaryCanvas.width = 1;
        temporaryCanvas.height = 1;
      }
    }
    let released = false;
    return {
      meanSaturation: 0.3,
      source: image,
      width: sourceWidth,
      height: sourceHeight,
      release() {
        if (released) return;
        released = true;
        image.removeAttribute("src");
      },
    };
  }
}

function resolveBackgroundRenderGeometry(
  viewportWidth: number,
  viewportHeight: number,
  reducedMotion: boolean,
  degraded: boolean,
): BackgroundRenderGeometry {
  const viewportShortSide = Math.min(viewportWidth, viewportHeight);
  const viewportLongSide = Math.max(viewportWidth, viewportHeight);
  const targetShortSide = reducedMotion
    ? BACKGROUND_REDUCED_CORE_SHORT_SIDE_PX
    : degraded
      ? BACKGROUND_DEGRADED_CORE_SHORT_SIDE_PX
      : BACKGROUND_NORMAL_CORE_SHORT_SIDE_PX;
  const shortSideScale = targetShortSide / viewportShortSide;
  const longSideScale =
    BACKGROUND_MAX_CORE_LONG_SIDE_PX / viewportLongSide;
  const renderScale = Math.min(shortSideScale, longSideScale);
  const width = Math.max(1, Math.round(viewportWidth * renderScale));
  const height = Math.max(1, Math.round(viewportHeight * renderScale));
  // Vividness must not depend on viewport shape. The artwork bitmap spans
  // max(w,h)*SCALE_MULTIPLIER core pixels while blur was flat 25px, so a
  // tall narrow panel (core 60x296 → artwork ~385px, blur = 6.5% of it)
  // kept crisp saturated color blobs while a squarish window (core 60x147 →
  // artwork ~191px, blur = 13%) smeared colors toward gray — the observed
  // "narrower = more vivid". Scale blur with the artwork span, calibrated
  // to the preferred narrow-panel ratio, so every size reproduces the same
  // color statistics.
  const artworkSpan = Math.max(width, height) * BACKGROUND_SCALE_MULTIPLIER;
  const blurRadius = reducedMotion
    ? BACKGROUND_BLUR_RADIUS_PX
    : Math.min(
      40,
      Math.max(6, artworkSpan * BACKGROUND_BLUR_TO_ARTWORK_RATIO),
    );
  return Object.freeze({
    width,
    height,
    blurRadius,
    blurGuard: Math.ceil(
      blurRadius * BACKGROUND_BLUR_GUARD_MULTIPLIER,
    ),
  });
}

function drawClampExtendedSource(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  width: number,
  height: number,
  guard: number,
): void {
  const paddedWidth = width + guard * 2;
  const paddedHeight = height + guard * 2;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, paddedWidth, paddedHeight);
  context.drawImage(source, guard, guard, width, height);
  if (guard <= 0) return;

  context.drawImage(source, 0, 0, 1, height, 0, guard, guard, height);
  context.drawImage(
    source,
    width - 1,
    0,
    1,
    height,
    guard + width,
    guard,
    guard,
    height,
  );
  context.drawImage(source, 0, 0, width, 1, guard, 0, width, guard);
  context.drawImage(
    source,
    0,
    height - 1,
    width,
    1,
    guard,
    guard + height,
    width,
    guard,
  );

  context.drawImage(source, 0, 0, 1, 1, 0, 0, guard, guard);
  context.drawImage(
    source,
    width - 1,
    0,
    1,
    1,
    guard + width,
    0,
    guard,
    guard,
  );
  context.drawImage(
    source,
    0,
    height - 1,
    1,
    1,
    0,
    guard + height,
    guard,
    guard,
  );
  context.drawImage(
    source,
    width - 1,
    height - 1,
    1,
    1,
    guard + width,
    guard + height,
    guard,
    guard,
  );
}

class ArtworkBackgroundRendererImpl implements ArtworkBackgroundRenderer {
  readonly #container: HTMLElement;
  readonly #previousCanvas: HTMLCanvasElement;
  readonly #currentCanvas: HTMLCanvasElement;
  readonly #previousContext: CanvasRenderingContext2D;
  readonly #currentContext: CanvasRenderingContext2D;
  readonly #compositeCanvas: HTMLCanvasElement;
  readonly #compositeContext: CanvasRenderingContext2D;
  readonly #blurSourceCanvas: HTMLCanvasElement;
  readonly #blurSourceContext: CanvasRenderingContext2D;
  readonly #blurCanvas: HTMLCanvasElement;
  readonly #blurContext: CanvasRenderingContext2D;
  readonly #mirrorCanvas: HTMLCanvasElement;
  readonly #mirrorContext: CanvasRenderingContext2D;
  readonly #snapshotCanvas: HTMLCanvasElement;
  readonly #snapshotContext: CanvasRenderingContext2D;
  readonly #document: Document;
  readonly #view: Window | null;
  readonly #resizeObserver: ResizeObserver | null;
  readonly #intersectionObserver: IntersectionObserver | null;
  #artwork: PreparedArtwork | null = null;
  #pendingLoad: PendingArtworkLoad | null = null;
  #requestGeneration = 0;
  #fadeGeneration = 0;
  #fadeAnimation: Animation | null = null;
  #frameRequest: number | null = null;
  #visibilityResumeFrame: number | null = null;
  #lastDrawAtMs = Number.NEGATIVE_INFINITY;
  #width = 0;
  #height = 0;
  #backingScale = 1;
  #appearance: LyricsBackgroundAppearance;
  #active: boolean;
  #reducedMotion: boolean;
  #motionTimeOffsetMs = 0;
  #frozenMotionTimeMs: number | null = null;
  #intersecting = true;
  #performanceMode: BackgroundPerformanceMode = "normal";
  #performanceModeOverride: LyricsBackgroundPerformanceMode = "auto";
  #tickPressureScore = 0;
  #drawPressureScore = 0;
  #lastFrameTickAtMs = Number.NaN;
  #healthySinceMs = Number.NaN;
  #lastSevereDrawAtMs = Number.NaN;
  #destroyed = false;

  readonly #handleVisibilityChange = (): void => {
    if (this.#destroyed) return;
    if (!this.#active || this.#document.hidden) {
      this.#cancelVisibilityResumeDraw();
      this.#stopFrameLoop();
      return;
    }
    this.#scheduleVisibilityResumeDraw();
  };

  readonly #handleWindowResize = (): void => {
    if (this.#active) this.#resize();
  };

  readonly #handleFrame = (nowMs: number): void => {
    this.#frameRequest = null;
    if (!this.#mayAnimate()) {
      this.#resetFrameTickBaseline();
      return;
    }
    this.#sampleFrameTick(nowMs);
    if (nowMs - this.#lastDrawAtMs >= this.#frameIntervalMs()) {
      this.#draw(nowMs);
    }
    this.#frameRequest = this.#view?.requestAnimationFrame(this.#handleFrame) ?? null;
  };

  constructor(options: ArtworkBackgroundRendererOptions) {
    this.#container = options.container;
    this.#previousCanvas = options.previousCanvas;
    this.#currentCanvas = options.currentCanvas;
    this.#previousContext = require2dContext(options.previousCanvas);
    this.#currentContext = require2dContext(options.currentCanvas);
    this.#document = options.container.ownerDocument;
    this.#view = this.#document.defaultView;
    this.#appearance = options.appearance;
    this.#active = options.active ?? true;
    this.#reducedMotion = options.reducedMotion;

    this.#compositeCanvas = this.#document.createElement("canvas");
    this.#compositeContext = require2dContext(this.#compositeCanvas);
    this.#blurSourceCanvas = this.#document.createElement("canvas");
    this.#blurSourceContext = require2dContext(this.#blurSourceCanvas);
    this.#blurCanvas = this.#document.createElement("canvas");
    this.#blurContext = require2dContext(this.#blurCanvas);
    this.#mirrorCanvas = this.#document.createElement("canvas");
    this.#mirrorContext = require2dContext(this.#mirrorCanvas);
    this.#snapshotCanvas = this.#document.createElement("canvas");
    this.#snapshotContext = require2dContext(this.#snapshotCanvas);

    this.#document.addEventListener(
      "visibilitychange",
      this.#handleVisibilityChange,
    );
    this.#view?.addEventListener("resize", this.#handleWindowResize);

    const observerWindow = this.#view as ObserverWindow | null;
    const ResizeObserverConstructor = observerWindow?.ResizeObserver;
    if (ResizeObserverConstructor) {
      const resizeObserver = new ResizeObserverConstructor(() => {
        if (this.#active) this.#resize();
      });
      resizeObserver.observe(this.#container);
      this.#resizeObserver = resizeObserver;
    } else {
      this.#resizeObserver = null;
    }

    const IntersectionObserverConstructor =
      observerWindow?.IntersectionObserver;
    if (IntersectionObserverConstructor) {
      const intersectionObserver = new IntersectionObserverConstructor(
        (entries) => {
          const entry = entries[entries.length - 1];
          if (!entry) return;
          this.#intersecting = entry.isIntersecting;
          if (!this.#active) return;
          if (this.#intersecting) {
            this.#draw(this.#now());
            this.#syncFrameLoop();
          } else {
            this.#stopFrameLoop();
          }
        },
      );
      intersectionObserver.observe(this.#container);
      this.#intersectionObserver = intersectionObserver;
    } else {
      this.#intersectionObserver = null;
    }

    if (this.#active) this.#resize();
  }

  async setArtwork(
    source: LyricsBackgroundArtworkSource | null,
    options: LyricsBackgroundArtworkUpdateOptions = {},
  ): Promise<LyricsBackgroundArtworkUpdateResult> {
    if (this.#destroyed) throw new Error("Lyrics background has been destroyed");
    const generation = ++this.#requestGeneration;
    this.#pendingLoad?.cancel();
    this.#pendingLoad = null;
    if (options.signal?.aborted) {
      return Object.freeze({ status: "superseded" });
    }

    if (source === null) {
      this.#replaceArtwork(null);
      this.#presentArtwork(options.transition ?? "crossfade");
      return Object.freeze({ status: "applied" });
    }

    const pendingLoad = createArtworkLoad(this.#document, source);
    this.#pendingLoad = pendingLoad;
    const handleAbort = (): void => {
      if (
        generation !== this.#requestGeneration ||
        this.#pendingLoad !== pendingLoad
      ) {
        return;
      }
      this.#requestGeneration += 1;
      pendingLoad.cancel();
    };
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    let artwork: HTMLImageElement;
    try {
      artwork = await pendingLoad.promise;
    } catch (error) {
      if (
        error instanceof ArtworkLoadCancelledError ||
        generation !== this.#requestGeneration ||
        this.#destroyed
      ) {
        return Object.freeze({ status: "superseded" });
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", handleAbort);
      if (this.#pendingLoad === pendingLoad) this.#pendingLoad = null;
    }

    if (generation !== this.#requestGeneration || this.#destroyed) {
      artwork.removeAttribute("src");
      return Object.freeze({ status: "superseded" });
    }
    this.#replaceArtwork(prepareArtwork(this.#document, artwork));
    this.#presentArtwork(options.transition ?? "crossfade");
    return Object.freeze({ status: "applied" });
  }

  setAppearance(appearance: LyricsBackgroundAppearance): void {
    if (this.#destroyed || this.#appearance === appearance) return;
    this.#appearance = appearance;
    this.#presentArtwork("crossfade");
  }

  setActive(active: boolean): void {
    if (this.#destroyed || this.#active === active) return;
    this.#cancelVisibilityResumeDraw();
    const nowMs = this.#now();
    const wasFrozen = this.#motionFrozen();
    this.#active = active;
    this.#syncMotionFreeze(wasFrozen, this.#motionFrozen(), nowMs);
    if (!active) {
      this.#stopFrameLoop();
      this.#settleFade();
      return;
    }
    if (!this.#resize()) this.#draw(nowMs);
    this.#syncFrameLoop();
  }

  setPerformanceMode(mode: LyricsBackgroundPerformanceMode): void {
    if (this.#destroyed || this.#performanceModeOverride === mode) return;
    if (
      mode !== "auto" &&
      mode !== "normal" &&
      mode !== "constrained" &&
      mode !== "critical"
    ) {
      throw new TypeError(`Unsupported background performance mode: ${mode}`);
    }
    this.#performanceModeOverride = mode;
    this.#lastDrawAtMs = Number.NEGATIVE_INFINITY;
    this.#resetFrameTickBaseline();
    this.#draw(this.#now());
    this.#syncFrameLoop();
  }

  setReducedMotion(reducedMotion: boolean): void {
    if (this.#destroyed || this.#reducedMotion === reducedMotion) return;
    const nowMs = this.#now();
    const wasFrozen = this.#motionFrozen();
    this.#reducedMotion = reducedMotion;
    this.#syncMotionFreeze(wasFrozen, this.#motionFrozen(), nowMs);
    if (reducedMotion) this.#settleFade();
    if (this.#active) this.#draw(nowMs);
    this.#syncFrameLoop();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#requestGeneration += 1;
    this.#pendingLoad?.cancel();
    this.#pendingLoad = null;
    this.#cancelVisibilityResumeDraw();
    this.#stopFrameLoop();
    this.#settleFade();
    this.#resizeObserver?.disconnect();
    this.#intersectionObserver?.disconnect();
    this.#document.removeEventListener(
      "visibilitychange",
      this.#handleVisibilityChange,
    );
    this.#view?.removeEventListener("resize", this.#handleWindowResize);
    this.#replaceArtwork(null);
    this.#releaseAllCanvasBacking();
  }

  #presentArtwork(transition: "crossfade" | "immediate"): void {
    if (!this.#active) {
      this.#settleFade();
      return;
    }
    const shouldCrossfade =
      transition === "crossfade" &&
      !this.#reducedMotion &&
      this.#width > 0 &&
      this.#height > 0;

    if (shouldCrossfade) this.#snapshotVisibleBackground();
    this.#cancelFade(false);
    this.#draw(this.#now());

    if (shouldCrossfade && typeof this.#currentCanvas.animate === "function") {
      this.#previousCanvas.style.opacity = "1";
      this.#currentCanvas.style.opacity = "0";
      const generation = ++this.#fadeGeneration;
      const animation = this.#currentCanvas.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        {
          duration: BACKGROUND_CROSSFADE_DURATION_MS,
          easing: BACKGROUND_CROSSFADE_EASING,
        },
      );
      this.#fadeAnimation = animation;
      void animation.finished.then(
        () => {
          if (generation !== this.#fadeGeneration || this.#destroyed) return;
          this.#fadeAnimation = null;
          this.#currentCanvas.style.opacity = "1";
          this.#previousCanvas.style.opacity = "0";
          this.#releasePreviousCanvas();
        },
        () => undefined,
      );
    } else {
      this.#settleFade();
    }
    this.#syncFrameLoop();
  }

  #snapshotVisibleBackground(): void {
    const width = Math.max(
      this.#previousCanvas.width,
      this.#currentCanvas.width,
    );
    const height = Math.max(
      this.#previousCanvas.height,
      this.#currentCanvas.height,
    );
    if (width <= 0 || height <= 0) return;
    resizeCanvas(this.#snapshotCanvas, width, height, this.#snapshotContext);
    const context = this.#snapshotContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.globalAlpha = clampOpacity(
      this.#view?.getComputedStyle(this.#previousCanvas).opacity ?? "0",
    );
    context.drawImage(this.#previousCanvas, 0, 0, width, height);
    context.globalAlpha = clampOpacity(
      this.#view?.getComputedStyle(this.#currentCanvas).opacity ?? "1",
    );
    context.drawImage(this.#currentCanvas, 0, 0, width, height);
    context.globalAlpha = 1;

    resizeCanvas(
      this.#previousCanvas,
      width,
      height,
      this.#previousContext,
    );
    this.#previousContext.setTransform(1, 0, 0, 1, 0, 0);
    this.#previousContext.clearRect(0, 0, width, height);
    this.#previousContext.drawImage(this.#snapshotCanvas, 0, 0, width, height);
    resizeCanvas(this.#snapshotCanvas, 1, 1, this.#snapshotContext);
  }

  #settleFade(): void {
    this.#cancelFade(false);
    this.#currentCanvas.style.opacity = "1";
    this.#previousCanvas.style.opacity = "0";
    this.#releasePreviousCanvas();
  }

  #cancelFade(incrementGeneration = true): void {
    if (incrementGeneration) this.#fadeGeneration += 1;
    this.#fadeAnimation?.cancel();
    this.#fadeAnimation = null;
  }

  #releasePreviousCanvas(): void {
    releaseCanvasBacking(this.#previousCanvas, this.#previousContext);
  }

  #replaceArtwork(artwork: PreparedArtwork | null): void {
    const previousArtwork = this.#artwork;
    this.#artwork = artwork;
    previousArtwork?.release();
  }

  #releaseWorkCanvasBacking(): void {
    releaseCanvasBacking(this.#compositeCanvas, this.#compositeContext);
    releaseCanvasBacking(this.#blurSourceCanvas, this.#blurSourceContext);
    releaseCanvasBacking(this.#blurCanvas, this.#blurContext);
    releaseCanvasBacking(this.#mirrorCanvas, this.#mirrorContext);
    releaseCanvasBacking(this.#snapshotCanvas, this.#snapshotContext);
  }

  #releaseAllCanvasBacking(): void {
    this.#releasePreviousCanvas();
    releaseCanvasBacking(this.#currentCanvas, this.#currentContext);
    this.#releaseWorkCanvasBacking();
  }

  #resize(): boolean {
    if (this.#destroyed) return false;
    const width = Math.max(0, this.#container.clientWidth);
    const height = Math.max(0, this.#container.clientHeight);
    const deviceScale = Math.min(
      1,
      Math.max(0.5, this.#view?.devicePixelRatio ?? 1),
    );
    const pixelBudgetScale =
      width > 0 && height > 0
        ? Math.sqrt(BACKGROUND_MAX_CANVAS_PIXELS / (width * height))
        : 1;
    const backingScale = Math.min(deviceScale, pixelBudgetScale);
    const changed =
      width !== this.#width ||
      height !== this.#height ||
      backingScale !== this.#backingScale;
    if (!changed) return false;

    this.#width = width;
    this.#height = height;
    this.#backingScale = backingScale;
    this.#settleFade();
    if (this.#active) this.#draw(this.#now());
    this.#syncFrameLoop();
    return true;
  }

  #mayAnimate(): boolean {
    return (
      !this.#destroyed &&
      this.#active &&
      !this.#reducedMotion &&
      this.#artwork !== null &&
      this.#intersecting &&
      !this.#document.hidden &&
      this.#width > 0 &&
      this.#height > 0 &&
      this.#container.isConnected
    );
  }

  #now(): number {
    return this.#view?.performance.now() ?? Date.now();
  }

  #motionTime(nowMs: number): number {
    if (this.#motionFrozen()) {
      if (this.#frozenMotionTimeMs === null) {
        this.#frozenMotionTimeMs = nowMs + this.#motionTimeOffsetMs;
      }
      return this.#frozenMotionTimeMs;
    }
    return nowMs + this.#motionTimeOffsetMs;
  }

  #motionFrozen(): boolean {
    return !this.#active || this.#reducedMotion;
  }

  #syncMotionFreeze(
    wasFrozen: boolean,
    frozen: boolean,
    nowMs: number,
  ): void {
    if (!wasFrozen && frozen) {
      // Hidden players retain their current artwork phase, just like reduced
      // motion, so resuming does not jump forward by the suspended duration.
      this.#frozenMotionTimeMs = nowMs + this.#motionTimeOffsetMs;
    } else if (wasFrozen && !frozen && this.#frozenMotionTimeMs !== null) {
      this.#motionTimeOffsetMs = this.#frozenMotionTimeMs - nowMs;
      this.#frozenMotionTimeMs = null;
    }
  }

  #syncFrameLoop(): void {
    if (this.#visibilityResumeFrame !== null) return;
    if (!this.#mayAnimate()) {
      this.#stopFrameLoop();
      return;
    }
    if (this.#frameRequest === null && this.#view) {
      this.#frameRequest = this.#view.requestAnimationFrame(this.#handleFrame);
    }
  }

  #scheduleVisibilityResumeDraw(): void {
    this.#cancelVisibilityResumeDraw();
    this.#stopFrameLoop();
    const view = this.#view;
    if (!view) {
      this.#draw(this.#now());
      return;
    }
    this.#visibilityResumeFrame = view.requestAnimationFrame(() => {
      this.#visibilityResumeFrame = null;
      if (this.#destroyed || !this.#active || this.#document.hidden) return;
      this.#visibilityResumeFrame = view.requestAnimationFrame((nowMs) => {
        this.#visibilityResumeFrame = null;
        if (
          this.#destroyed ||
          !this.#active ||
          this.#document.hidden ||
          !this.#intersecting ||
          !this.#container.isConnected
        ) {
          return;
        }
        this.#draw(nowMs);
        this.#syncFrameLoop();
      });
    });
  }

  #cancelVisibilityResumeDraw(): void {
    if (this.#visibilityResumeFrame === null) return;
    this.#view?.cancelAnimationFrame(this.#visibilityResumeFrame);
    this.#visibilityResumeFrame = null;
  }

  #stopFrameLoop(): void {
    this.#resetFrameTickBaseline();
    if (this.#frameRequest !== null) {
      this.#view?.cancelAnimationFrame(this.#frameRequest);
      this.#frameRequest = null;
    }
  }

  #resetFrameTickBaseline(): void {
    this.#lastFrameTickAtMs = Number.NaN;
    this.#healthySinceMs = Number.NaN;
  }

  #frameIntervalMs(): number {
    const mode = this.#effectivePerformanceMode();
    if (mode === "critical") {
      return BACKGROUND_CRITICAL_FRAME_INTERVAL_MS;
    }
    if (mode === "constrained") {
      return BACKGROUND_CONSTRAINED_FRAME_INTERVAL_MS;
    }
    return BACKGROUND_FRAME_INTERVAL_MS;
  }

  #effectivePerformanceMode(): BackgroundPerformanceMode {
    return this.#performanceModeOverride === "auto"
      ? this.#performanceMode
      : this.#performanceModeOverride;
  }

  #sampleFrameTick(nowMs: number): void {
    const previousTickAtMs = this.#lastFrameTickAtMs;
    this.#lastFrameTickAtMs = nowMs;
    if (!Number.isFinite(previousTickAtMs)) return;
    const tickDurationMs = nowMs - previousTickAtMs;
    if (tickDurationMs <= 0) return;

    const elapsedSeconds = Math.min(tickDurationMs, 1000) / 1000;
    this.#tickPressureScore = Math.max(
      0,
      this.#tickPressureScore -
        elapsedSeconds * BACKGROUND_PRESSURE_DECAY_PER_SECOND,
    );
    this.#drawPressureScore = Math.max(
      0,
      this.#drawPressureScore -
        elapsedSeconds * BACKGROUND_DRAW_PRESSURE_DECAY_PER_SECOND,
    );

    if (tickDurationMs > BACKGROUND_TICK_PRESSURE_THRESHOLD_MS) {
      this.#healthySinceMs = Number.NaN;
      const latenessMs =
        tickDurationMs - BACKGROUND_TICK_PRESSURE_THRESHOLD_MS;
      const pressure = Math.min(
        12,
        Math.max(
          1,
          latenessMs /
            (tickDurationMs > BACKGROUND_TICK_SEVERE_THRESHOLD_MS ? 8 : 16),
        ),
      );
      this.#tickPressureScore = Math.min(
        BACKGROUND_MAX_PRESSURE_SCORE,
        this.#tickPressureScore + pressure,
      );
    }
    this.#updatePerformanceMode(nowMs);
  }

  #registerDrawDuration(drawDurationMs: number, nowMs: number): void {
    if (drawDurationMs <= BACKGROUND_SLOW_DRAW_THRESHOLD_MS) {
      this.#updatePerformanceMode(nowMs);
      return;
    }
    const pressure = Math.min(
      8,
      1 +
        (drawDurationMs - BACKGROUND_SLOW_DRAW_THRESHOLD_MS) /
          (drawDurationMs >= BACKGROUND_DRAW_SEVERE_THRESHOLD_MS ? 5 : 10),
    );
    this.#drawPressureScore = Math.min(
      BACKGROUND_MAX_PRESSURE_SCORE,
      this.#drawPressureScore + pressure,
    );
    if (drawDurationMs >= BACKGROUND_DRAW_SEVERE_THRESHOLD_MS) {
      this.#lastSevereDrawAtMs = nowMs;
    }
    this.#updatePerformanceMode(nowMs);
  }

  #updatePerformanceMode(nowMs: number): void {
    const pressureScore = Math.min(
      BACKGROUND_MAX_PRESSURE_SCORE,
      this.#tickPressureScore + this.#drawPressureScore,
    );
    if (this.#performanceMode === "normal") {
      if (pressureScore >= BACKGROUND_CONSTRAINED_SCORE) {
        this.#performanceMode = "constrained";
        this.#healthySinceMs = Number.NaN;
      }
      return;
    }

    if (this.#performanceMode === "constrained") {
      if (pressureScore >= BACKGROUND_CRITICAL_SCORE) {
        this.#performanceMode = "critical";
        this.#healthySinceMs = Number.NaN;
        return;
      }
      if (this.#isHealthyFor(nowMs, BACKGROUND_NORMAL_RECOVERY_MS)) {
        this.#performanceMode = "normal";
        this.#healthySinceMs = nowMs;
      }
      return;
    }

    if (this.#isHealthyFor(nowMs, BACKGROUND_CRITICAL_RECOVERY_MS)) {
      this.#performanceMode = "constrained";
      this.#healthySinceMs = nowMs;
    }
  }

  #isHealthyFor(nowMs: number, durationMs: number): boolean {
    const pressureScore = Math.min(
      BACKGROUND_MAX_PRESSURE_SCORE,
      this.#tickPressureScore + this.#drawPressureScore,
    );
    const severeDrawIsRecent =
      Number.isFinite(this.#lastSevereDrawAtMs) &&
      nowMs - this.#lastSevereDrawAtMs < durationMs;
    if (
      pressureScore >
        (this.#performanceMode === "critical"
          ? BACKGROUND_CRITICAL_RECOVERY_SCORE
          : BACKGROUND_NORMAL_RECOVERY_SCORE) ||
      severeDrawIsRecent
    ) {
      this.#healthySinceMs = Number.NaN;
      return false;
    }
    if (!Number.isFinite(this.#healthySinceMs)) {
      this.#healthySinceMs = nowMs;
      return false;
    }
    return nowMs - this.#healthySinceMs >= durationMs;
  }

  #draw(nowMs: number): void {
    if (
      this.#destroyed ||
      !this.#active ||
      this.#visibilityResumeFrame !== null
    ) {
      return;
    }
    this.#lastDrawAtMs = nowMs;
    if (this.#width <= 0 || this.#height <= 0) {
      releaseCanvasBacking(this.#currentCanvas, this.#currentContext);
      this.#releaseWorkCanvasBacking();
      return;
    }
    if (!this.#artwork) {
      this.#drawPlainFallback();
      this.#releaseWorkCanvasBacking();
      return;
    }
    const drawStartedAtMs = this.#now();
    resizeCanvas(
      this.#currentCanvas,
      Math.max(1, Math.round(this.#width * this.#backingScale)),
      Math.max(1, Math.round(this.#height * this.#backingScale)),
      this.#currentContext,
    );
    const geometry = resolveBackgroundRenderGeometry(
      this.#width,
      this.#height,
      this.#reducedMotion,
      this.#effectivePerformanceMode() !== "normal",
    );
    this.#resizeBuffers(geometry);
    this.#drawComposite(geometry.width, geometry.height, nowMs);
    this.#drawBlur(geometry);
    this.#drawMirror(geometry);

    const drawFinishedAtMs = this.#now();
    this.#registerDrawDuration(
      drawFinishedAtMs - drawStartedAtMs,
      drawFinishedAtMs,
    );
  }

  #drawPlainFallback(): void {
    resizeCanvas(this.#currentCanvas, 1, 1, this.#currentContext);
    const context = this.#currentContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.filter = "none";
    context.fillStyle = this.#fallbackColor();
    context.fillRect(0, 0, 1, 1);
  }

  #resizeBuffers(geometry: BackgroundRenderGeometry): void {
    const { width, height, blurGuard } = geometry;
    const paddedWidth = width + blurGuard * 2;
    const paddedHeight = height + blurGuard * 2;
    resizeCanvas(
      this.#compositeCanvas,
      width,
      height,
      this.#compositeContext,
    );
    resizeCanvas(
      this.#blurSourceCanvas,
      paddedWidth,
      paddedHeight,
      this.#blurSourceContext,
    );
    resizeCanvas(
      this.#blurCanvas,
      paddedWidth,
      paddedHeight,
      this.#blurContext,
    );
    resizeCanvas(
      this.#mirrorCanvas,
      width * 2,
      height * 2,
      this.#mirrorContext,
    );
  }

  #drawComposite(width: number, height: number, nowMs: number): void {
    const context = this.#compositeContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.filter = "none";
    context.fillStyle = this.#fallbackColor();
    context.fillRect(0, 0, width, height);

    if (this.#artwork) {
      const motionTimeMs = this.#motionTime(nowMs);
      // Reduced motion freezes the composition clock; changing the period
      // here would still produce a phase jump on the entering frame.
      const durationMultiplier = 1;
      for (const layer of BACKGROUND_LAYERS) {
        const periodMs = layer.periodMs * durationMultiplier;
        const angle =
          layer.direction *
          2 *
          Math.PI *
          ((motionTimeMs % periodMs) / periodMs);
        this.#drawArtworkLayer(context, width, height, angle, layer);
      }
      const scrim = BACKGROUND_SCRIMS[this.#appearance];
      context.filter = "none";
      context.fillStyle = `rgb(0 0 0 / ${scrim.blackAlpha})`;
      context.fillRect(0, 0, width, height);
      context.fillStyle = `rgb(255 255 255 / ${scrim.whiteAlpha})`;
      context.fillRect(0, 0, width, height);
    }
  }

  #drawArtworkLayer(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    angle: number,
    layer: (typeof BACKGROUND_LAYERS)[number],
  ): void {
    const artwork = this.#artwork;
    if (!artwork) return;
    const sourceSide = Math.min(artwork.width, artwork.height);
    const sourceX = (artwork.width - sourceSide) / 2;
    const sourceY = (artwork.height - sourceSide) / 2;
    const bitmapSide =
      Math.max(width, height) * BACKGROUND_SCALE_MULTIPLIER;
    const baseX = -(bitmapSide - width) / 2;
    const baseY = -(bitmapSide - height) / 2;

    context.save();
    if (layer.extraCanvasRotation) {
      context.translate(width / 2, height / 2);
      context.rotate(angle);
      context.translate(-width / 2, -height / 2);
    }
    context.translate(
      baseX + layer.dxMultiplier * width,
      baseY + layer.dyMultiplier * height,
    );
    context.translate(bitmapSide / 2, bitmapSide / 2);
    context.rotate(angle);
    context.translate(-bitmapSide / 2, -bitmapSide / 2);
    const tone = BACKGROUND_ARTWORK_TONES[this.#appearance];
    const baseSaturation = tone.saturation
      + (this.#reducedMotion ? BACKGROUND_REDUCED_MOTION_SATURATION_GAIN : 0);
    // Vibrance: 1 + (boost-1) * weight keeps saturate >= 1 while adapting
    // the strength to the artwork's own chroma.
    const saturation = 1
      + (baseSaturation - 1) * vibranceWeight(artwork.meanSaturation);
    context.filter =
      `brightness(${tone.brightness}) contrast(${tone.contrast}) saturate(${saturation})`;
    context.drawImage(
      artwork.source,
      sourceX,
      sourceY,
      sourceSide,
      sourceSide,
      0,
      0,
      bitmapSide,
      bitmapSide,
    );
    context.restore();
  }

  #drawBlur(geometry: BackgroundRenderGeometry): void {
    const { width, height, blurRadius, blurGuard } = geometry;
    const paddedWidth = width + blurGuard * 2;
    const paddedHeight = height + blurGuard * 2;
    drawClampExtendedSource(
      this.#blurSourceContext,
      this.#compositeCanvas,
      width,
      height,
      blurGuard,
    );
    const context = this.#blurContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, paddedWidth, paddedHeight);
    context.filter = `blur(${blurRadius}px)`;
    context.drawImage(this.#blurSourceCanvas, 0, 0);
    context.filter = "none";
  }

  #drawMirror(geometry: BackgroundRenderGeometry): void {
    const { width, height, blurGuard } = geometry;
    const mirrorContext = this.#mirrorContext;
    const tileWidth = width * 2;
    const tileHeight = height * 2;
    mirrorContext.setTransform(1, 0, 0, 1, 0, 0);
    mirrorContext.clearRect(0, 0, tileWidth, tileHeight);
    mirrorContext.drawImage(
      this.#blurCanvas,
      blurGuard,
      blurGuard,
      width,
      height,
      0,
      0,
      width,
      height,
    );

    mirrorContext.save();
    mirrorContext.translate(tileWidth, 0);
    mirrorContext.scale(-1, 1);
    mirrorContext.drawImage(
      this.#blurCanvas,
      blurGuard,
      blurGuard,
      width,
      height,
      0,
      0,
      width,
      height,
    );
    mirrorContext.restore();

    mirrorContext.save();
    mirrorContext.translate(0, tileHeight);
    mirrorContext.scale(1, -1);
    mirrorContext.drawImage(
      this.#blurCanvas,
      blurGuard,
      blurGuard,
      width,
      height,
      0,
      0,
      width,
      height,
    );
    mirrorContext.restore();

    mirrorContext.save();
    mirrorContext.translate(tileWidth, tileHeight);
    mirrorContext.scale(-1, -1);
    mirrorContext.drawImage(
      this.#blurCanvas,
      blurGuard,
      blurGuard,
      width,
      height,
      0,
      0,
      width,
      height,
    );
    mirrorContext.restore();

    const context = this.#currentContext;
    context.setTransform(this.#backingScale, 0, 0, this.#backingScale, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.filter = "none";
    context.fillStyle = this.#fallbackColor();
    context.fillRect(0, 0, this.#width, this.#height);
    const drawWidth = this.#width * BACKGROUND_SCALE_MULTIPLIER;
    const drawHeight = this.#height * BACKGROUND_SCALE_MULTIPLIER;
    const translateX = -(drawWidth - this.#width) / 2;
    const translateY = -(drawHeight - this.#height) / 2;
    context.drawImage(
      this.#mirrorCanvas,
      translateX,
      translateY,
      drawWidth * 2,
      drawHeight * 2,
    );
  }

  #fallbackColor(): string {
    return this.#artwork
      ? BACKGROUND_ARTWORK_FALLBACK_COLOR
      : BACKGROUND_PLAIN_FALLBACK_COLORS[this.#appearance];
  }
}

export function createArtworkBackgroundRenderer(
  options: ArtworkBackgroundRendererOptions,
): ArtworkBackgroundRenderer {
  return new ArtworkBackgroundRendererImpl(options);
}
