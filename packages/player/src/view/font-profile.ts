export const lyricFontTargets = Object.freeze([
  "all",
  "latin",
  "zh-Hans",
  "zh-Hant",
  "ja",
  "ko",
] as const);

export type LyricsFontTarget = (typeof lyricFontTargets)[number];

export type LyricsFontSource =
  | {
      readonly kind: "system";
      readonly family: string;
    }
  | {
      readonly kind: "blob";
      readonly blob: Blob;
    }
  | {
      readonly kind: "google";
      readonly family: string;
    };

export type LyricsFontProfiles = Readonly<
  Partial<Record<LyricsFontTarget, LyricsFontSource | null>>
>;

export interface LyricsFontUpdateOptions {
  readonly signal?: AbortSignal;
}

export interface LyricsFontUpdateResult {
  readonly status: "applied" | "superseded";
}

export type LyricsFontProfileKind = "auto" | "system" | "custom" | "google";
export type LyricsFontOverrideMap = Readonly<
  Record<LyricsFontTarget, string | null>
>;
export type LyricsFontKindMap = Readonly<
  Record<LyricsFontTarget, LyricsFontProfileKind>
>;

export interface LyricsFontApplyHooks<T> {
  beforeApply(): T;
  afterApply(context: T): void;
  afterRollback(context: T): void;
}

export interface LyricsFontProfileManagerOptions {
  readonly document: Document;
  readonly applyFontOverrides: (
    overrides: LyricsFontOverrideMap,
    kinds: LyricsFontKindMap,
  ) => void;
}

export interface LyricsFontProfileManager {
  setSource<T>(
    source: LyricsFontSource | null,
    options: LyricsFontUpdateOptions,
    hooks: LyricsFontApplyHooks<T>,
  ): Promise<LyricsFontUpdateResult>;
  setSources<T>(
    profiles: LyricsFontProfiles,
    options: LyricsFontUpdateOptions,
    hooks: LyricsFontApplyHooks<T>,
  ): Promise<LyricsFontUpdateResult>;
  destroy(): void;
}

type NormalizedFontSource =
  | { readonly kind: "auto" }
  | { readonly kind: "system"; readonly family: string }
  | { readonly kind: "blob"; readonly blob: Blob }
  | { readonly kind: "google"; readonly family: string };

interface OwnedFontResource {
  readonly cssFamily: string;
  activate(): void;
  destroy(): void;
}

interface ActiveFontProfile {
  readonly source: NormalizedFontSource;
  readonly kind: LyricsFontProfileKind;
  readonly cssFamily: string | null;
  readonly resource: OwnedFontResource | null;
}

const autoSource: NormalizedFontSource = Object.freeze({ kind: "auto" });
const googleFontWeightTiers = Object.freeze([
  200,
  300,
  400,
  500,
  600,
  700,
  800,
  900,
] as const);
const googleFontWeightRequest = googleFontWeightTiers.join(";");
const googleFontCompatibilityWeightRequest = "400;500;700";
let nextManagerId = 1;

function normalizeSystemFamily(value: string): string {
  const family = value.trim().replace(/\s+/g, " ");
  if (family.length === 0) {
    throw new Error("A system font family is required");
  }
  if (family.length > 160) {
    throw new Error("The system font family is too long");
  }
  if (/[\u0000-\u001f\u007f]/.test(family)) {
    throw new Error("The system font family contains invalid characters");
  }
  return family;
}

function normalizeSource(source: LyricsFontSource | null): NormalizedFontSource {
  if (source === null) return autoSource;
  if (source.kind === "system") {
    return Object.freeze({
      kind: "system",
      family: normalizeSystemFamily(source.family),
    });
  }
  if (source.kind === "google") {
    return Object.freeze({
      kind: "google",
      family: normalizeSystemFamily(source.family),
    });
  }
  return Object.freeze({ kind: "blob", blob: source.blob });
}

function quoteFontFamily(family: string): string {
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sameSource(
  left: NormalizedFontSource,
  right: NormalizedFontSource,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "auto" && right.kind === "auto") return true;
  if (left.kind === "system" && right.kind === "system") {
    return left.family === right.family;
  }
  if (left.kind === "google" && right.kind === "google") {
    return left.family === right.family;
  }
  return (
    left.kind === "blob" &&
    right.kind === "blob" &&
    left.blob === right.blob
  );
}

function autoProfile(): ActiveFontProfile {
  return Object.freeze({
    source: autoSource,
    kind: "auto",
    cssFamily: null,
    resource: null,
  });
}

function createInitialProfiles(): Map<LyricsFontTarget, ActiveFontProfile> {
  return new Map(lyricFontTargets.map((target) => [target, autoProfile()]));
}

function profileOverrides(
  profiles: ReadonlyMap<LyricsFontTarget, ActiveFontProfile>,
): LyricsFontOverrideMap {
  return Object.freeze(
    Object.fromEntries(
      lyricFontTargets.map((target) => [target, profiles.get(target)?.cssFamily ?? null]),
    ) as Record<LyricsFontTarget, string | null>,
  );
}

function profileKinds(
  profiles: ReadonlyMap<LyricsFontTarget, ActiveFontProfile>,
): LyricsFontKindMap {
  return Object.freeze(
    Object.fromEntries(
      lyricFontTargets.map((target) => [target, profiles.get(target)?.kind ?? "auto"]),
    ) as Record<LyricsFontTarget, LyricsFontProfileKind>,
  );
}

function profileResources(
  profiles: ReadonlyMap<LyricsFontTarget, ActiveFontProfile>,
): Set<OwnedFontResource> {
  return new Set(
    [...profiles.values()].flatMap((profile) =>
      profile.resource ? [profile.resource] : [],
    ),
  );
}

function destroyUnusedResources(
  resources: Iterable<OwnedFontResource>,
  retained: ReadonlySet<OwnedFontResource>,
): void {
  for (const resource of resources) {
    if (!retained.has(resource)) resource.destroy();
  }
}

function throwCollectedErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

class FontUpdateSupersededError extends Error {
  constructor() {
    super("Lyrics font update was superseded");
    this.name = "FontUpdateSupersededError";
  }
}

class FontFaceResource implements OwnedFontResource {
  readonly cssFamily: string;
  readonly #fontSet: FontFaceSet;
  readonly #face: FontFace;
  #active = false;

  constructor(fontSet: FontFaceSet, face: FontFace) {
    this.#fontSet = fontSet;
    this.#face = face;
    this.cssFamily = quoteFontFamily(face.family);
  }

  activate(): void {
    if (this.#active) return;
    this.#fontSet.add(this.#face);
    this.#active = true;
  }

  destroy(): void {
    if (!this.#active) return;
    this.#fontSet.delete(this.#face);
    this.#active = false;
  }
}

interface FontFaceCssRuleLike extends CSSRule {
  readonly style: CSSStyleDeclaration;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteGoogleFontFamily(
  cssText: string,
  sourceFamily: string,
  alias: string,
): string {
  const familyPattern = new RegExp(
    `(font-family\\s*:\\s*)(['"])${escapeRegExp(sourceFamily)}\\2`,
    "gi",
  );
  const rewritten = cssText.replace(
    familyPattern,
    (_match, prefix: string, quote: string) =>
      `${prefix}${quote}${alias}${quote}`,
  );
  if (rewritten === cssText) {
    throw new Error("Google Font stylesheet did not contain its requested family");
  }
  return rewritten;
}

class GoogleFontStyleResource implements OwnedFontResource {
  readonly cssFamily: string;
  readonly #document: Document;
  readonly #style: HTMLStyleElement | null;
  readonly #sheet: CSSStyleSheet | null;
  #active = false;

  private constructor(
    document: Document,
    alias: string,
    style: HTMLStyleElement | null,
    sheet: CSSStyleSheet | null,
  ) {
    this.#document = document;
    this.cssFamily = quoteFontFamily(alias);
    this.#style = style;
    this.#sheet = sheet;
  }

  static async create(
    document: Document,
    sourceFamily: string,
    alias: string,
    cssText: string,
  ): Promise<GoogleFontStyleResource> {
    const adoptedDocument = document;
    const StyleSheetConstructor = document.defaultView?.CSSStyleSheet;
    const adoptedStyleSheets = adoptedDocument.adoptedStyleSheets;
    if (
      StyleSheetConstructor &&
      adoptedStyleSheets &&
      typeof adoptedStyleSheets[Symbol.iterator] === "function"
    ) {
      let sheet: CSSStyleSheet | null = null;
      try {
        sheet = new StyleSheetConstructor();
      } catch {
        // A browser may expose the constructor but reject it in a restricted
        // document. The regular style path below remains available there.
      }
      if (sheet) {
        try {
          if (typeof sheet.replace === "function") {
            await sheet.replace(cssText);
          } else if (typeof sheet.replaceSync === "function") {
            sheet.replaceSync(cssText);
          } else {
            sheet = null;
          }
          if (sheet) {
            const fontFaceRules = [...sheet.cssRules].filter(
              (rule): rule is FontFaceCssRuleLike => rule.type === 5,
            );
            if (fontFaceRules.length === 0) {
              throw new Error("Google Font stylesheet did not contain font faces");
            }
            for (const rule of fontFaceRules) {
              rule.style.setProperty("font-family", quoteFontFamily(alias));
            }
            return new GoogleFontStyleResource(document, alias, null, sheet);
          }
        } catch {
          // Fall through to the validated style-element path for older
          // implementations with incomplete constructable-sheet support.
          sheet = null;
        }
      }
    }

    if (!/@font-face\s*\{/i.test(cssText)) {
      throw new Error("Google Font stylesheet did not contain font faces");
    }
    const style = document.createElement("style");
    style.dataset.amLyricsGoogleFont = alias;
    style.textContent = rewriteGoogleFontFamily(cssText, sourceFamily, alias);
    return new GoogleFontStyleResource(
      document,
      alias,
      style,
      null,
    );
  }

  activate(): void {
    if (this.#active) return;
    if (this.#sheet) {
      const adopted = this.#document.adoptedStyleSheets ?? [];
      if (!adopted.includes(this.#sheet)) {
        this.#document.adoptedStyleSheets = [...adopted, this.#sheet];
      }
    } else if (this.#style) {
      (this.#document.head ?? this.#document.documentElement).append(this.#style);
    }
    this.#active = true;
  }

  destroy(): void {
    if (!this.#active) return;
    if (this.#sheet) {
      const adopted = this.#document.adoptedStyleSheets ?? [];
      this.#document.adoptedStyleSheets = adopted.filter(
        (sheet) => sheet !== this.#sheet,
      );
    }
    this.#style?.remove();
    this.#active = false;
  }
}

class LyricsFontProfileManagerImpl implements LyricsFontProfileManager {
  readonly #document: Document;
  readonly #applyFontOverrides: LyricsFontProfileManagerOptions["applyFontOverrides"];
  readonly #managerId = nextManagerId++;
  #resourceSequence = 0;
  #requestGeneration = 0;
  #profiles = createInitialProfiles();
  #destroyed = false;

  constructor(options: LyricsFontProfileManagerOptions) {
    this.#document = options.document;
    this.#applyFontOverrides = options.applyFontOverrides;
  }

  setSource<T>(
    source: LyricsFontSource | null,
    options: LyricsFontUpdateOptions,
    hooks: LyricsFontApplyHooks<T>,
  ): Promise<LyricsFontUpdateResult> {
    const profiles = { all: source } satisfies Record<
      "all",
      LyricsFontSource | null
    >;
    return this.setSources(profiles, options, hooks);
  }

  async setSources<T>(
    updates: LyricsFontProfiles,
    options: LyricsFontUpdateOptions,
    hooks: LyricsFontApplyHooks<T>,
  ): Promise<LyricsFontUpdateResult> {
    this.#assertAlive();
    const generation = ++this.#requestGeneration;
    if (options.signal?.aborted) return Object.freeze({ status: "superseded" });

    const previousProfiles = this.#profiles;
    const nextProfiles = new Map(previousProfiles);
    const candidateResources = new Set<OwnedFontResource>();
    const resourcesByKey = new Map<Blob | string, Promise<OwnedFontResource>>();
    try {
      for (const target of lyricFontTargets) {
        if (
          generation !== this.#requestGeneration ||
          this.#destroyed ||
          options.signal?.aborted
        ) {
          destroyUnusedResources(candidateResources, new Set());
          return Object.freeze({ status: "superseded" });
        }
        if (!(target in updates)) continue;
        const source = normalizeSource(updates[target] ?? null);
        const current = previousProfiles.get(target) ?? autoProfile();
        if (sameSource(current.source, source)) continue;
        nextProfiles.set(
          target,
          await this.#prepareProfile(
            source,
            generation,
            resourcesByKey,
            candidateResources,
            options.signal,
          ),
        );
      }
    } catch (error) {
      destroyUnusedResources(candidateResources, new Set());
      if (
        error instanceof FontUpdateSupersededError ||
        generation !== this.#requestGeneration ||
        options.signal?.aborted
      ) {
        return Object.freeze({ status: "superseded" });
      }
      throw error;
    }

    if (
      this.#destroyed ||
      generation !== this.#requestGeneration ||
      options.signal?.aborted
    ) {
      destroyUnusedResources(candidateResources, new Set());
      return Object.freeze({ status: "superseded" });
    }
    const changed = lyricFontTargets.some(
      (target) => nextProfiles.get(target) !== previousProfiles.get(target),
    );
    if (!changed) {
      destroyUnusedResources(candidateResources, new Set());
      return Object.freeze({ status: "applied" });
    }

    try {
      for (const resource of candidateResources) resource.activate();
    } catch (error) {
      destroyUnusedResources(candidateResources, new Set());
      throw error;
    }

    let context: T | undefined;
    let contextReady = false;
    try {
      context = hooks.beforeApply();
      contextReady = true;
      this.#applyProfiles(nextProfiles);
      hooks.afterApply(context);
    } catch (error) {
      const rollbackErrors: unknown[] = [error];
      try {
        this.#applyProfiles(previousProfiles);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      this.#profiles = previousProfiles;
      if (contextReady) {
        try {
          hooks.afterRollback(context as T);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      destroyUnusedResources(
        candidateResources,
        profileResources(previousProfiles),
      );
      throwCollectedErrors(rollbackErrors, "Lyrics font update rollback failed");
    }

    destroyUnusedResources(
      profileResources(previousProfiles),
      profileResources(nextProfiles),
    );
    return Object.freeze({ status: "applied" });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#requestGeneration += 1;
    destroyUnusedResources(profileResources(this.#profiles), new Set());
    this.#profiles = createInitialProfiles();
  }

  async #prepareProfile(
    source: NormalizedFontSource,
    generation: number,
    resourcesByKey: Map<Blob | string, Promise<OwnedFontResource>>,
    candidateResources: Set<OwnedFontResource>,
    signal?: AbortSignal,
  ): Promise<ActiveFontProfile> {
    if (source.kind === "auto") return autoProfile();
    if (source.kind === "system") {
      await this.#document.fonts.load(`16px ${quoteFontFamily(source.family)}`);
      return Object.freeze({
        source,
        kind: "system",
        cssFamily: quoteFontFamily(source.family),
        resource: null,
      });
    }

    if (source.kind === "google") {
      const activeResource = [...this.#profiles.values()].find(
        (profile) =>
          profile.source.kind === "google" &&
          profile.source.family === source.family &&
          profile.resource,
      )?.resource;
      let resource = activeResource ?? null;
      if (!resource) {
        const key = `google:${source.family}`;
        let pending = resourcesByKey.get(key);
        if (!pending) {
          pending = this.#createGoogleResource(
            source.family,
            generation,
            signal,
          ).then((created) => {
            candidateResources.add(created);
            return created;
          });
          resourcesByKey.set(key, pending);
        }
        resource = await pending;
      }
      return Object.freeze({
        source,
        kind: "google",
        cssFamily: resource.cssFamily,
        resource,
      });
    }

    const activeResource = [...this.#profiles.values()].find(
      (profile) =>
        profile.source.kind === "blob" &&
        profile.source.blob === source.blob &&
        profile.resource,
    )?.resource;
    let resource = activeResource ?? null;
    if (!resource) {
      let pending = resourcesByKey.get(source.blob);
      if (!pending) {
        pending = this.#createBlobResource(source.blob, generation).then(
          (created) => {
            candidateResources.add(created);
            return created;
          },
        );
        resourcesByKey.set(source.blob, pending);
      }
      resource = await pending;
    }
    return Object.freeze({
      source,
      kind: "custom",
      cssFamily: resource.cssFamily,
      resource,
    });
  }

  async #createBlobResource(
    blob: Blob,
    generation: number,
  ): Promise<OwnedFontResource> {
    const FontFaceConstructor = this.#document.defaultView?.FontFace;
    if (!FontFaceConstructor) {
      throw new Error("Custom font files are not supported in this browser");
    }
    const buffer = await blob.arrayBuffer();
    if (generation !== this.#requestGeneration || this.#destroyed) {
      throw new FontUpdateSupersededError();
    }
    const family = `am-lyrics-custom-${this.#managerId}-${++this.#resourceSequence}`;
    const face = new FontFaceConstructor(family, buffer, {
      display: "block",
      style: "normal",
      weight: "100 900",
    });
    const loadedFace = await face.load();
    if (generation !== this.#requestGeneration || this.#destroyed) {
      throw new FontUpdateSupersededError();
    }
    return new FontFaceResource(this.#document.fonts, loadedFace);
  }

  async #createGoogleResource(
    family: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<OwnedFontResource> {
    const weightedUrl = new URL("https://fonts.googleapis.com/css2");
    weightedUrl.searchParams.set(
      "family",
      `${family}:wght@${googleFontWeightRequest}`,
    );
    weightedUrl.searchParams.set("display", "block");
    let response = await fetch(weightedUrl, {
      referrerPolicy: "no-referrer",
      signal: signal ?? null,
    });
    if (!response.ok) {
      // Preserve the previous three-weight path for families that do not
      // expose every tier before falling back to a regular-only request.
      const compatibilityUrl = new URL("https://fonts.googleapis.com/css2");
      compatibilityUrl.searchParams.set(
        "family",
        `${family}:wght@${googleFontCompatibilityWeightRequest}`,
      );
      compatibilityUrl.searchParams.set("display", "block");
      response = await fetch(compatibilityUrl, {
        referrerPolicy: "no-referrer",
        signal: signal ?? null,
      });
    }
    if (!response.ok) {
      const fallbackUrl = new URL("https://fonts.googleapis.com/css2");
      fallbackUrl.searchParams.set("family", family);
      fallbackUrl.searchParams.set("display", "block");
      response = await fetch(fallbackUrl, {
        referrerPolicy: "no-referrer",
        signal: signal ?? null,
      });
    }
    if (!response.ok) {
      throw new Error(`Google Font could not be loaded (${response.status})`);
    }
    const cssText = await response.text();
    if (generation !== this.#requestGeneration || this.#destroyed) {
      throw new FontUpdateSupersededError();
    }
    // Keep the weights returned by Google intact. Widening a static regular
    // face would falsely advertise variable support and change weight choice.
    const normalizedCss = cssText.replace(
      /font-display:\s*swap\s*;/g,
      "font-display: block;",
    );
    const alias = `am-lyrics-google-${this.#managerId}-${++this.#resourceSequence}`;
    const resource = await GoogleFontStyleResource.create(
      this.#document,
      family,
      alias,
      normalizedCss,
    );
    if (
      generation !== this.#requestGeneration ||
      this.#destroyed ||
      signal?.aborted
    ) {
      resource.destroy();
      throw new FontUpdateSupersededError();
    }
    try {
      resource.activate();
      const loadedFaces = await Promise.all(
        googleFontWeightTiers.map((weight) =>
          this.#document.fonts.load(
            `${weight} 34px ${resource.cssFamily}`,
            "Aa",
          ),
        ),
      );
      if (!loadedFaces.some((faces) => faces.some((face) => face.status === "loaded"))) {
        throw new Error("Google Font was blocked or did not expose a usable face");
      }
    } catch (error) {
      resource.destroy();
      throw error;
    }
    if (
      generation !== this.#requestGeneration ||
      this.#destroyed ||
      signal?.aborted
    ) {
      resource.destroy();
      throw new FontUpdateSupersededError();
    }
    return resource;
  }

  #applyProfiles(
    profiles: Map<LyricsFontTarget, ActiveFontProfile>,
  ): void {
    this.#applyFontOverrides(
      profileOverrides(profiles),
      profileKinds(profiles),
    );
    this.#profiles = profiles;
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("Lyrics font manager has been destroyed");
  }
}

export function createLyricsFontProfileManager(
  options: LyricsFontProfileManagerOptions,
): LyricsFontProfileManager {
  return new LyricsFontProfileManagerImpl(options);
}
