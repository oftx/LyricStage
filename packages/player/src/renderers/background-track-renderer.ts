import type { LyricDocument } from "../domain/types.js";
import type { PlaybackFrame } from "../playback/create-playback-frame.js";
import {
  createKaraokeRenderer,
  type KaraokePaintMode,
  type KaraokePaintModeOptions,
  type KaraokeRenderOptions,
  type KaraokeRenderer,
} from "./karaoke-renderer.js";
import type { SyncedRowPaintHost } from "../view/row-view.js";

export type BackgroundTrackRenderOptions = KaraokeRenderOptions;

export interface BackgroundTrackRendererOptions {
  readonly resolvePaintHost: (
    lineId: string,
  ) => SyncedRowPaintHost | null;
  readonly now?: () => number;
  readonly active?: boolean;
}

export interface BackgroundTrackRenderer {
  setActive(active: boolean): void;
  setDocument(document: LyricDocument | null): void;
  setPaintMode(mode: KaraokePaintMode, options?: KaraokePaintModeOptions): void;
  hasGeometryObserver(): boolean;
  invalidateGeometry(lineIds?: readonly string[]): void;
  renderFrame(
    frame: PlaybackFrame,
    options?: BackgroundTrackRenderOptions,
  ): void;
  resetPlaybackState(): void;
  getTrackCount(): number;
  getFallbackTrackCount(): number;
  destroy(): void;
}

const backgroundTrackNames = Object.freeze([
  "background",
  "backgroundPronunciation",
] as const);

function hasBackgroundContent(
  line: LyricDocument["lines"][number],
): boolean {
  return (
    line.tracks !== null &&
    (line.tracks.background !== undefined ||
      line.tracks.backgroundPronunciation !== undefined ||
      line.backgroundTranslation !== undefined)
  );
}

class BackgroundTrackRendererImpl implements BackgroundTrackRenderer {
  readonly #renderer: KaraokeRenderer;
  readonly #resolvePaintHost: BackgroundTrackRendererOptions["resolvePaintHost"];
  #destroyed = false;

  constructor(options: BackgroundTrackRendererOptions) {
    this.#resolvePaintHost = options.resolvePaintHost;
    this.#renderer = createKaraokeRenderer({
      resolvePaintHost: options.resolvePaintHost,
      trackNames: backgroundTrackNames,
      ...(options.active !== undefined ? { active: options.active } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  setActive(active: boolean): void {
    this.#assertAlive();
    this.#renderer.setActive(active);
  }

  setDocument(document: LyricDocument | null): void {
    this.#assertAlive();
    if (!document) {
      this.#renderer.setDocument(null);
      return;
    }

    for (const line of document.lines) {
      if (!hasBackgroundContent(line)) continue;
      const host = this.#resolvePaintHost(line.id);
      if (!host) {
        throw new Error(`Missing background paint host for ${line.id}`);
      }
    }

    this.#renderer.setDocument(document);
  }

  setPaintMode(
    mode: KaraokePaintMode,
    options: KaraokePaintModeOptions = {},
  ): void {
    this.#assertAlive();
    this.#renderer.setPaintMode(mode, options);
  }

  hasGeometryObserver(): boolean {
    this.#assertAlive();
    return this.#renderer.hasGeometryObserver();
  }

  invalidateGeometry(lineIds?: readonly string[]): void {
    this.#assertAlive();
    this.#renderer.invalidateGeometry(lineIds);
  }

  renderFrame(
    frame: PlaybackFrame,
    options: BackgroundTrackRenderOptions = {},
  ): void {
    this.#assertAlive();
    this.#renderer.renderFrame(frame, options);
  }

  resetPlaybackState(): void {
    this.#assertAlive();
    this.#renderer.resetPlaybackState();
  }

  getTrackCount(): number {
    return this.#renderer.getTrackCount();
  }

  getFallbackTrackCount(): number {
    return this.#renderer.getFallbackTrackCount();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#renderer.destroy();
  }

  #assertAlive(): void {
    if (this.#destroyed) {
      throw new Error("Background track renderer is destroyed");
    }
  }
}

export function createBackgroundTrackRenderer(
  options: BackgroundTrackRendererOptions,
): BackgroundTrackRenderer {
  return new BackgroundTrackRendererImpl(options);
}
