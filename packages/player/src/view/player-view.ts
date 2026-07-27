import { playerStyleText } from "./styles/player-styles.generated.js";
import type { LyricsContentRegion } from "./content-region.js";
import {
  lyricFontTargets,
  type LyricsFontKindMap,
  type LyricsFontOverrideMap,
  type LyricsFontProfileKind,
  type LyricsFontTarget,
} from "./font-profile.js";
import {
  DEFAULT_LYRICS_FONT_WEIGHT_TIER,
  type LyricsFontWeightTier,
} from "./font-weight-tier.js";
import type { LyricsLayoutProfile } from "./layout-profile.js";
import type { LyricsSurfaceMode } from "./surface-mode.js";

export type PlayerViewLayer = "synced" | "plaintext";

const themePropertyRegistrations = Object.freeze([
  Object.freeze({
    name: "--am-lp-theme-foreground-channel",
    syntax: "<number>",
    inherits: true,
    initialValue: "255",
  }),
  Object.freeze({
    name: "--am-lp-theme-surface-channel",
    syntax: "<number>",
    inherits: true,
    initialValue: "8",
  }),
]);
const themePropertiesRegisteredWindows = new WeakSet<Window>();

type CSSPropertyRegistryWindow = Window & {
  readonly CSS?: {
    registerProperty(registration: {
      readonly name: string;
      readonly syntax: string;
      readonly inherits: boolean;
      readonly initialValue: string;
    }): void;
  };
};

function registerThemeTransitionProperties(view: Window | null): void {
  if (!view || themePropertiesRegisteredWindows.has(view)) return;
  themePropertiesRegisteredWindows.add(view);
  const css = (view as CSSPropertyRegistryWindow).CSS;
  const registerProperty = css?.registerProperty;
  if (typeof registerProperty !== "function") return;
  for (const registration of themePropertyRegistrations) {
    try {
      registerProperty.call(css, registration);
    } catch {
      // The document registry is shared by every player instance.
    }
  }
}

export interface PlayerView {
  readonly instanceHost: HTMLElement;
  readonly shadowRoot: ShadowRoot;
  readonly root: HTMLElement;
  readonly background: HTMLElement;
  readonly backgroundPreviousCanvas: HTMLCanvasElement;
  readonly backgroundCurrentCanvas: HTMLCanvasElement;
  readonly panel: HTMLElement;
  readonly syncedLayer: HTMLElement;
  readonly syncedRows: HTMLElement;
  readonly plaintextLayer: HTMLElement;
  readonly plaintextRows: HTMLElement;
  setContentRegion(region: LyricsContentRegion): void;
  setFontWeightTier(tier: LyricsFontWeightTier): void;
  setPlaintextFontWeightTier(tier: LyricsFontWeightTier): void;
  setLayoutProfile(profile: LyricsLayoutProfile): void;
  setReducedMotion(reducedMotion: boolean): void;
  setSurfaceMode(mode: LyricsSurfaceMode): void;
  setSecondaryVisibility(
    translationVisible: boolean,
    pronunciationVisible: boolean,
  ): void;
  setFontOverride(
    cssFamily: string | null,
    kind: LyricsFontProfileKind,
  ): void;
  setFontOverrides(
    overrides: LyricsFontOverrideMap,
    kinds: LyricsFontKindMap,
  ): void;
  destroy(): void;
}

function createLayer(
  document: Document,
  name: PlayerViewLayer,
): { readonly layer: HTMLElement; readonly rows: HTMLElement } {
  const layer = document.createElement("div");
  layer.className = `am-lp-layer am-lp-${name}-layer`;
  layer.dataset.layer = name;
  layer.setAttribute("role", "group");
  layer.setAttribute(
    "aria-label",
    name === "plaintext" ? "Plain lyrics" : "Synchronized lyrics",
  );
  const rows = document.createElement("div");
  rows.className = "am-lp-rows";
  rows.dataset.rows = name;
  layer.append(rows);
  return { layer, rows };
}

function fontOverrideProperty(target: LyricsFontTarget): string {
  if (target === "all") return "--am-lp-font-override";
  return `--am-lp-font-override-${target.toLowerCase()}`;
}

function summarizeFontKind(kinds: LyricsFontKindMap): string {
  const values = new Set(Object.values(kinds));
  if (values.size === 0) return "auto";
  if (values.size === 1) return [...values][0] ?? "auto";
  return "mixed";
}

class PlayerViewImpl implements PlayerView {
  readonly instanceHost: HTMLElement;
  readonly shadowRoot: ShadowRoot;
  readonly root: HTMLElement;
  readonly background: HTMLElement;
  readonly backgroundPreviousCanvas: HTMLCanvasElement;
  readonly backgroundCurrentCanvas: HTMLCanvasElement;
  readonly panel: HTMLElement;
  readonly syncedLayer: HTMLElement;
  readonly syncedRows: HTMLElement;
  readonly plaintextLayer: HTMLElement;
  readonly plaintextRows: HTMLElement;
  #destroyed = false;

  constructor(host: HTMLElement) {
    const document = host.ownerDocument;
    registerThemeTransitionProperties(document.defaultView);
    const instanceHost = document.createElement("div");
    instanceHost.dataset.amLyricsPlayer = "";
    const shadowRoot = instanceHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.dataset.amLyricsPlayerStyles = "";
    style.textContent = playerStyleText;

    const root = document.createElement("div");
    root.className = "am-lp-root";
    root.dataset.amLyricsPlayerRoot = "";
    root.dataset.fontProfile = "auto";
    root.dataset.fontWeightTier = String(DEFAULT_LYRICS_FONT_WEIGHT_TIER);
    root.dataset.layoutProfile = "auto";
    root.setAttribute("part", "root");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Lyrics");
    const background = document.createElement("div");
    background.className = "am-lp-artwork-background";
    background.setAttribute("aria-hidden", "true");
    const backgroundPreviousCanvas = document.createElement("canvas");
    backgroundPreviousCanvas.className =
      "am-lp-artwork-background-canvas am-lp-artwork-background-previous";
    const backgroundCurrentCanvas = document.createElement("canvas");
    backgroundCurrentCanvas.className =
      "am-lp-artwork-background-canvas am-lp-artwork-background-current";
    background.append(backgroundPreviousCanvas, backgroundCurrentCanvas);
    const panel = document.createElement("div");
    panel.className = "am-lp-panel";
    const synced = createLayer(document, "synced");
    const plaintext = createLayer(document, "plaintext");
    synced.layer.dataset.layerActive = "true";
    synced.layer.setAttribute("aria-hidden", "false");
    plaintext.layer.dataset.layerActive = "false";
    plaintext.layer.setAttribute("aria-hidden", "true");
    plaintext.layer.inert = true;
    plaintext.layer.hidden = true;
    panel.append(synced.layer, plaintext.layer);
    root.append(background, panel);
    shadowRoot.append(style, root);

    try {
      host.append(instanceHost);
    } catch (error) {
      instanceHost.remove();
      throw error;
    }

    this.instanceHost = instanceHost;
    this.shadowRoot = shadowRoot;
    this.root = root;
    this.background = background;
    this.backgroundPreviousCanvas = backgroundPreviousCanvas;
    this.backgroundCurrentCanvas = backgroundCurrentCanvas;
    this.panel = panel;
    this.syncedLayer = synced.layer;
    this.syncedRows = synced.rows;
    this.plaintextLayer = plaintext.layer;
    this.plaintextRows = plaintext.rows;
  }

  setLayoutProfile(profile: LyricsLayoutProfile): void {
    if (this.#destroyed) return;
    this.root.dataset.layoutProfile = profile;
  }

  setFontWeightTier(tier: LyricsFontWeightTier): void {
    if (this.#destroyed) return;
    this.root.dataset.fontWeightTier = String(tier);
  }

  setPlaintextFontWeightTier(tier: LyricsFontWeightTier): void {
    if (this.#destroyed) return;
    this.root.dataset.plaintextWeightTier = String(tier);
  }

  setContentRegion(region: LyricsContentRegion): void {
    if (this.#destroyed) return;
    this.root.style.setProperty(
      "--am-lp-content-region-left",
      String(region.left),
    );
    this.root.style.setProperty(
      "--am-lp-content-region-right",
      String(region.right),
    );
  }

  setReducedMotion(reducedMotion: boolean): void {
    if (this.#destroyed) return;
    this.root.dataset.reducedMotion = String(reducedMotion);
  }

  setSurfaceMode(mode: LyricsSurfaceMode): void {
    if (this.#destroyed) return;
    this.root.dataset.surfaceMode = mode;
  }

  setSecondaryVisibility(
    translationVisible: boolean,
    pronunciationVisible: boolean,
  ): void {
    if (this.#destroyed) return;
    this.root.dataset.translationVisible = String(translationVisible);
    this.root.dataset.pronunciationVisible = String(pronunciationVisible);
  }

  setFontOverride(
    cssFamily: string | null,
    kind: LyricsFontProfileKind,
  ): void {
    if (this.#destroyed) return;
    if (cssFamily === null) {
      this.instanceHost.style.removeProperty("--am-lp-font-override");
    } else {
      this.instanceHost.style.setProperty("--am-lp-font-override", cssFamily);
    }
    this.root.dataset.fontProfile = kind;
  }

  setFontOverrides(
    overrides: LyricsFontOverrideMap,
    kinds: LyricsFontKindMap,
  ): void {
    if (this.#destroyed) return;
    for (const target of lyricFontTargets) {
      const property = fontOverrideProperty(target);
      this.instanceHost.style.removeProperty(property);
      const cssFamily = overrides[target];
      if (cssFamily !== null) {
        this.instanceHost.style.setProperty(property, cssFamily);
      }
    }
    this.root.dataset.fontProfile = summarizeFontKind(kinds);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.instanceHost.remove();
  }
}

export function createPlayerView(host: HTMLElement): PlayerView {
  return new PlayerViewImpl(host);
}
