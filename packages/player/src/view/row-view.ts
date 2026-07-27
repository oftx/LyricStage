import type { TextLyricLine } from "../domain/types.js";
import { resolveLyricPrimaryScript } from "../domain/language.js";
import type { LyricLineLayoutPlan } from "../layout/layout-plan.js";

export type SecondaryTextVisibility = Readonly<{
  translationVisible: boolean;
  pronunciationVisible: boolean;
}>;

export type SyncedRowState = "future" | "active" | "past";
export type SyncedPaintTrackName =
  | "foreground"
  | "foregroundPronunciation"
  | "background"
  | "backgroundPronunciation";
export type SyncedTrackContentOwner = "row" | "karaoke";

export interface SyncedRowStateOptions {
  readonly animate: boolean;
  readonly scaleActiveOverride?: boolean;
  /**
   * When set, opacity fade is timed to the row-move window: fade starts when
   * the line starts moving and finishes when the move completes.
   */
  readonly alphaDurationMs?: number;
  readonly alphaDelayMs?: number;
}

export type TextBranchRole =
  | "primary"
  | "background"
  | "pronunciation"
  | "background-pronunciation"
  | "translation"
  | "background-translation";

export interface SyncedRowPaintHost {
  readonly lineId: string;
  readonly rowElement: HTMLElement;
  getTrackElement(trackName: SyncedPaintTrackName): HTMLElement | null;
  claimTrackElement(
    trackName: SyncedPaintTrackName,
    owner: SyncedTrackContentOwner,
  ): HTMLElement | null;
  releaseTrackElement(
    trackName: SyncedPaintTrackName,
    text: string,
    language: string,
  ): void;
  setBackgroundSecondaryVisibility(
    visibility: SecondaryTextVisibility,
  ): void;
}

export interface SyncedRowView extends SyncedRowPaintHost {
  readonly element: HTMLElement;
  readonly primaryElement: HTMLElement;
  readonly foregroundSecondaryLaneElement: HTMLElement | null;
  readonly pronunciationElement: HTMLElement | null;
  readonly translationElement: HTMLElement | null;
  readonly backgroundLaneElement: HTMLElement | null;
  readonly backgroundElement: HTMLElement | null;
  readonly backgroundPronunciationElement: HTMLElement | null;
  readonly backgroundTranslationElement: HTMLElement | null;
  update(line: TextLyricLine, layout: LyricLineLayoutPlan): void;
  setSecondaryVisibility(visibility: SecondaryTextVisibility): void;
  setPlaybackState(
    state: SyncedRowState,
    options: SyncedRowStateOptions,
  ): void;
}

const activeScale = "var(--am-lp-row-scale-active, 1)";
const inactiveScale = "var(--am-lp-row-scale-rest, 0.98)";

function setLanguage(element: HTMLElement, language: string): void {
  element.lang = language;
  element.dir = "auto";
}

export function createTextBranchElement(
  ownerDocument: Document,
  role: TextBranchRole,
  text: string,
  language: string,
  context: "line" | "plaintext" = "line",
): HTMLElement {
  const element = ownerDocument.createElement("div");
  const contextRole =
    role === "background-pronunciation"
      ? "pronunciation"
      : role === "background-translation"
        ? "translation"
        : role;
  element.classList.add(
    "am-lp-text",
    `am-lp-${context}-${contextRole}`,
  );
  if (contextRole !== role) {
    element.classList.add(`am-lp-${context}-${role}`);
  }
  element.dataset.textRole = role;
  element.textContent = text;
  setLanguage(element, language);
  return element;
}

export function updateTextBranchElement(
  element: HTMLElement,
  text: string,
  language: string,
): void {
  if (element.textContent !== text) element.textContent = text;
  setLanguage(element, language);
}

export function setBranchVisibility(
  element: HTMLElement,
  visible: boolean,
): void {
  element.hidden = !visible;
  element.setAttribute("aria-hidden", String(!visible));
}

export function setRowSeekActionable(
  element: HTMLElement | null,
  actionable: boolean,
): void {
  if (!element) return;
  element.dataset.seekable = String(actionable);
  if (actionable) {
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    return;
  }
  const root =
    typeof element.getRootNode === "function"
      ? (element.getRootNode() as Document | ShadowRoot)
      : null;
  if (root?.activeElement === element) element.blur();
  element.removeAttribute("role");
  element.removeAttribute("tabindex");
}

export function applyRowLayout(
  element: HTMLElement,
  layout: LyricLineLayoutPlan,
): void {
  const { direction, side, width } = layout;
  element.classList.toggle("am-lp-row-start", side.side === "start");
  element.classList.toggle("am-lp-row-end", side.side === "end");
  element.classList.toggle(
    "am-lp-row-width-constrained",
    width.constrained,
  );
  element.classList.toggle(
    "am-lp-row-width-full",
    !width.constrained,
  );
  element.classList.toggle(
    "am-lp-row-direction-ltr",
    direction.direction === "ltr",
  );
  element.classList.toggle(
    "am-lp-row-direction-rtl",
    direction.direction === "rtl",
  );

  element.dataset.lineIndex = String(layout.index);
  element.dataset.documentIndex = String(layout.documentIndex);
  element.dataset.lineType = layout.type;
  if (layout.type === "instrumental") {
    delete element.dataset.primaryScript;
  } else {
    element.dataset.primaryScript = resolveLyricPrimaryScript(layout.language);
  }
  element.dataset.agentSide = side.side;
  element.dataset.agentSideCode = String(side.sideCode);
  element.dataset.agentSideReason = side.reason;
  element.dataset.direction = direction.direction;
  element.dataset.directionSource = direction.source;
  element.dataset.widthFraction = String(width.fraction);
  element.dataset.widthReason = width.reason;
  element.dataset.endClampedToDocument = String(
    layout.endClampedToDocument,
  );
  if (layout.sourceIndex === null) delete element.dataset.sourceIndex;
  else element.dataset.sourceIndex = String(layout.sourceIndex);

  element.style.direction = direction.direction;
  element.style.setProperty(
    "--am-lp-line-width",
    String(width.fraction),
  );
}

function setTone(
  element: HTMLElement,
  tone: "primary" | "secondary" | "tertiary",
): void {
  element.dataset.tone = tone;
}

function createOptionalBranch(
  ownerDocument: Document,
  role: Exclude<TextBranchRole, "primary">,
  text: string | undefined,
  language: string | undefined,
): HTMLElement | null {
  if (text === undefined || language === undefined || text.trim().length === 0) {
    return null;
  }
  return createTextBranchElement(ownerDocument, role, text, language);
}

class SyncedRowViewImpl implements SyncedRowView {
  readonly element: HTMLElement;
  readonly lineId: string;
  readonly primaryElement: HTMLElement;
  readonly #accessiblePrimaryElement: HTMLElement;
  foregroundSecondaryLaneElement: HTMLElement | null = null;
  pronunciationElement: HTMLElement | null;
  translationElement: HTMLElement | null;
  backgroundLaneElement: HTMLElement | null = null;
  backgroundElement: HTMLElement | null;
  backgroundPronunciationElement: HTMLElement | null;
  backgroundTranslationElement: HTMLElement | null;
  #visibility: SecondaryTextVisibility = {
    translationVisible: true,
    pronunciationVisible: true,
  };
  #state: SyncedRowState | null = null;
  #animate: boolean | null = null;
  #scaleActiveOverride: boolean | null = null;

  get rowElement(): HTMLElement {
    return this.element;
  }

  constructor(
    ownerDocument: Document,
    line: TextLyricLine,
    layout: LyricLineLayoutPlan,
  ) {
    this.lineId = line.id;
    this.element = ownerDocument.createElement("div");
    this.element.classList.add("am-lp-row", "am-lp-line-row");
    this.element.dataset.lineId = line.id;
    this.element.setAttribute("part", "row synced-row");

    const primary = line.tracks.foreground;
    this.primaryElement = createTextBranchElement(
      ownerDocument,
      "primary",
      primary.text,
      primary.language.effective,
    );
    const accessiblePrimary = ownerDocument.createElement("span");
    accessiblePrimary.className = "am-lp-accessible-text";
    accessiblePrimary.textContent = primary.text;
    setLanguage(accessiblePrimary, primary.language.effective);
    accessiblePrimary.setAttribute("aria-hidden", "true");
    this.#accessiblePrimaryElement = accessiblePrimary;
    this.#setTrackOwner(this.primaryElement, "row");
    this.primaryElement.setAttribute("part", "primary");
    this.pronunciationElement = createOptionalBranch(
      ownerDocument,
      "pronunciation",
      line.tracks.foregroundPronunciation?.text,
      line.tracks.foregroundPronunciation?.language.effective,
    );
    this.translationElement = createOptionalBranch(
      ownerDocument,
      "translation",
      line.translation?.text,
      line.translation?.language.effective,
    );
    this.backgroundElement = createOptionalBranch(
      ownerDocument,
      "background",
      line.tracks.background?.text,
      line.tracks.background?.language.effective,
    );
    this.backgroundPronunciationElement = createOptionalBranch(
      ownerDocument,
      "background-pronunciation",
      line.tracks.backgroundPronunciation?.text,
      line.tracks.backgroundPronunciation?.language.effective,
    );
    this.backgroundTranslationElement = createOptionalBranch(
      ownerDocument,
      "background-translation",
      line.backgroundTranslation?.text,
      line.backgroundTranslation?.language.effective,
    );
    if (this.pronunciationElement) {
      this.#setTrackOwner(this.pronunciationElement, "row");
    }
    if (this.backgroundElement) {
      this.#setTrackOwner(this.backgroundElement, "row");
    }
    if (this.backgroundPronunciationElement) {
      this.#setTrackOwner(this.backgroundPronunciationElement, "row");
    }
    this.#reconcileForegroundSecondaryLane();
    this.#reconcileBackgroundLane();
    this.#replaceRowChildren();
    applyRowLayout(this.element, layout);
    this.#applyBranchRoles();
    this.setSecondaryVisibility(this.#visibility);
    this.setPlaybackState("future", { animate: false });
  }

  update(line: TextLyricLine, layout: LyricLineLayoutPlan): void {
    if (line.id !== this.lineId) {
      throw new Error("A synced row cannot be rebound to a different line id");
    }
    const primary = line.tracks.foreground;
    this.#updateOwnedTrackElement(
      this.primaryElement,
      primary.text,
      primary.language.effective,
    );
    this.pronunciationElement = this.#reconcileOptionalBranch(
      this.pronunciationElement,
      "pronunciation",
      line.tracks.foregroundPronunciation?.text,
      line.tracks.foregroundPronunciation?.language.effective,
    );
    this.translationElement = this.#reconcileOptionalBranch(
      this.translationElement,
      "translation",
      line.translation?.text,
      line.translation?.language.effective,
    );
    this.backgroundElement = this.#reconcileOptionalBranch(
      this.backgroundElement,
      "background",
      line.tracks.background?.text,
      line.tracks.background?.language.effective,
    );
    this.backgroundPronunciationElement = this.#reconcileOptionalBranch(
      this.backgroundPronunciationElement,
      "background-pronunciation",
      line.tracks.backgroundPronunciation?.text,
      line.tracks.backgroundPronunciation?.language.effective,
    );
    this.backgroundTranslationElement = this.#reconcileOptionalBranch(
      this.backgroundTranslationElement,
      "background-translation",
      line.backgroundTranslation?.text,
      line.backgroundTranslation?.language.effective,
    );
    this.#reconcileForegroundSecondaryLane();
    this.#reconcileBackgroundLane();
    this.#replaceRowChildren();
    applyRowLayout(this.element, layout);
    this.#applyBranchRoles();
    this.setSecondaryVisibility(this.#visibility);
  }

  setSecondaryVisibility(visibility: SecondaryTextVisibility): void {
    this.#visibility = { ...visibility };
    if (this.pronunciationElement) {
      setBranchVisibility(
        this.pronunciationElement,
        visibility.pronunciationVisible,
      );
    }
    if (this.translationElement) {
      setBranchVisibility(
        this.translationElement,
        visibility.translationVisible,
      );
    }
    this.setBackgroundSecondaryVisibility(visibility);
  }

  setBackgroundSecondaryVisibility(
    visibility: SecondaryTextVisibility,
  ): void {
    if (this.backgroundPronunciationElement) {
      setBranchVisibility(
        this.backgroundPronunciationElement,
        visibility.pronunciationVisible,
      );
    }
    if (this.backgroundTranslationElement) {
      setBranchVisibility(
        this.backgroundTranslationElement,
        visibility.translationVisible,
      );
    }
  }

  getTrackElement(trackName: SyncedPaintTrackName): HTMLElement | null {
    switch (trackName) {
      case "foreground":
        return this.primaryElement;
      case "foregroundPronunciation":
        return this.pronunciationElement;
      case "background":
        return this.backgroundElement;
      case "backgroundPronunciation":
        return this.backgroundPronunciationElement;
      default: {
        const exhaustiveTrackName: never = trackName;
        return exhaustiveTrackName;
      }
    }
  }

  claimTrackElement(
    trackName: SyncedPaintTrackName,
    owner: SyncedTrackContentOwner,
  ): HTMLElement | null {
    const element = this.getTrackElement(trackName);
    if (element) this.#setTrackOwner(element, owner);
    return element;
  }

  releaseTrackElement(
    trackName: SyncedPaintTrackName,
    text: string,
    language: string,
  ): void {
    const element = this.getTrackElement(trackName);
    if (!element) return;
    this.#setTrackOwner(element, "row");
    updateTextBranchElement(element, text, language);
    if (element === this.primaryElement) {
      updateTextBranchElement(this.#accessiblePrimaryElement, text, language);
    }
    element.setAttribute("aria-label", text);
  }

  setPlaybackState(
    state: SyncedRowState,
    options: SyncedRowStateOptions,
  ): void {
    const animate = options.animate;
    const scaleActiveOverride = options.scaleActiveOverride ?? null;
    const hasAlphaTiming =
      options.alphaDurationMs !== undefined
      && Number.isFinite(options.alphaDurationMs)
      && options.alphaDurationMs >= 0;

    const stateChanged = this.#state !== state;
    const animateChanged = this.#animate !== animate;
    const scaleOverrideChanged = this.#scaleActiveOverride !== scaleActiveOverride;

    // Never clear fill clocks on unchanged rAF frames — that aborts an in-flight
    // opacity transition and looks like a hard jump.
    if (!stateChanged && !animateChanged && !scaleOverrideChanged) {
      return;
    }

    const wasActive = this.#state === "active";
    this.#state = state;
    this.#animate = animate;
    this.#scaleActiveOverride = scaleActiveOverride;

    // Enable CSS transitions before opacity/scale targets change.
    this.element.dataset.animate = String(animate);

    const active = state === "active";
    const scaleActive = scaleActiveOverride ?? active;

    // Scale-only updates (concurrent partners keeping active while focus
    // handoff starts) must not restart alpha clocks — that causes a mid-line
    // shrink/grow flash when multi-line overlap is active.
    const applyAlphaClocks = stateChanged || (hasAlphaTiming && active && !wasActive);
    if (applyAlphaClocks) {
      if (hasAlphaTiming) {
        const durationMs = Math.round(options.alphaDurationMs as number);
        const delayMs =
          options.alphaDelayMs !== undefined
          && Number.isFinite(options.alphaDelayMs)
          && options.alphaDelayMs >= 0
            ? Math.round(options.alphaDelayMs)
            : 0;
        this.element.style.setProperty("--am-lp-alpha-duration", `${durationMs}ms`);
        this.element.style.setProperty("--am-lp-alpha-delay", `${delayMs}ms`);
        this.element.style.setProperty("--am-lp-curve-alpha", "linear");
      } else {
        this.element.style.removeProperty("--am-lp-alpha-duration");
        this.element.style.removeProperty("--am-lp-alpha-delay");
        this.element.style.removeProperty("--am-lp-curve-alpha");
        this.element.style.removeProperty("--am-lp-scale-duration");
        this.element.style.removeProperty("--am-lp-scale-delay");
      }
    }

    this.element.dataset.visualState = state;
    if (scaleActiveOverride === null) {
      delete this.element.dataset.scaleActiveOverride;
    } else {
      this.element.dataset.scaleActiveOverride = String(scaleActiveOverride);
    }
    if (stateChanged) {
      this.element.dataset.transitionRole = active
        ? "activate"
        : state === "past"
          ? "deactivate"
          : "settle";
    }
    this.element.classList.toggle("am-lp-row-active", active);
    this.element.classList.toggle("am-lp-row-past", state === "past");
    this.element.classList.toggle("am-lp-row-future", state === "future");
    this.element.style.setProperty(
      "--am-lp-row-scale",
      scaleActive ? activeScale : inactiveScale,
    );

    // Register transition timing before opacity target changes (state only).
    if (animate && stateChanged) {
      void this.element.offsetWidth;
    }

    if (!stateChanged && !animateChanged) {
      // Scale override only — skip tone rewrites.
      return;
    }

    const dynamicTone = this.#dynamicTone(active);
    setTone(this.primaryElement, dynamicTone);
    if (this.pronunciationElement) {
      // Row-owned pronunciation = full-line ruby with no karaoke sweep.
      // Lighting it with the row read as a mistimed flash (user feedback);
      // it stays tertiary like the translation. Karaoke-owned bindings keep
      // their own sweep-driven brightness and ignore this tone anyway.
      const pronunciationOwnedByKaraoke =
        this.pronunciationElement.dataset.contentOwner === 'karaoke';
      setTone(
        this.pronunciationElement,
        pronunciationOwnedByKaraoke ? dynamicTone : 'tertiary',
      );
    }
    if (this.backgroundElement) {
      setTone(this.backgroundElement, dynamicTone);
    }
    if (this.backgroundPronunciationElement) {
      setTone(this.backgroundPronunciationElement, dynamicTone);
    }
    if (this.translationElement) setTone(this.translationElement, "tertiary");
    if (this.backgroundTranslationElement) {
      setTone(this.backgroundTranslationElement, "tertiary");
    }
  }

  #applyBranchRoles(): void {
    this.primaryElement.dataset.branchState = "dynamic";
    const dynamicTone = this.#dynamicTone(this.#state === "active");
    setTone(this.primaryElement, dynamicTone);
    if (this.pronunciationElement) {
      this.pronunciationElement.dataset.branchState = "dynamic";
      this.pronunciationElement.setAttribute("part", "pronunciation");
      setTone(this.pronunciationElement, dynamicTone);
    }
    if (this.translationElement) {
      this.translationElement.dataset.branchState = "fixed-tertiary";
      this.translationElement.setAttribute("part", "translation");
      setTone(this.translationElement, "tertiary");
    }
    if (this.backgroundElement) {
      this.backgroundElement.dataset.branchState = "dynamic";
      this.backgroundElement.setAttribute("part", "background");
      setTone(this.backgroundElement, dynamicTone);
    }
    if (this.backgroundPronunciationElement) {
      this.backgroundPronunciationElement.dataset.branchState = "dynamic";
      this.backgroundPronunciationElement.setAttribute(
        "part",
        "background-pronunciation",
      );
      setTone(this.backgroundPronunciationElement, dynamicTone);
    }
    if (this.backgroundTranslationElement) {
      this.backgroundTranslationElement.dataset.branchState = "fixed-tertiary";
      this.backgroundTranslationElement.setAttribute(
        "part",
        "background-translation",
      );
      setTone(this.backgroundTranslationElement, "tertiary");
    }
  }

  #dynamicTone(active: boolean): "primary" | "secondary" | "tertiary" {
    if (this.element.dataset.lineType === "credit") return "secondary";
    return active ? "primary" : "tertiary";
  }

  #setTrackOwner(
    element: HTMLElement,
    owner: SyncedTrackContentOwner,
  ): void {
    element.dataset.contentOwner = owner;
    element.dataset.renderer = owner === "karaoke" ? "karaoke" : "line-timed";
    if (element !== this.primaryElement) return;
    const karaokeOwned = owner === "karaoke";
    element.setAttribute("aria-hidden", String(karaokeOwned));
    this.#accessiblePrimaryElement.setAttribute(
      "aria-hidden",
      String(!karaokeOwned),
    );
    if (karaokeOwned) element.removeAttribute("aria-label");
  }

  #updateOwnedTrackElement(
    element: HTMLElement,
    text: string,
    language: string,
  ): void {
    element.lang = language;
    element.dir = "auto";
    const karaokeOwned =
      element === this.primaryElement &&
      element.dataset.contentOwner === "karaoke";
    if (karaokeOwned) element.removeAttribute("aria-label");
    else element.setAttribute("aria-label", text);
    if (element === this.primaryElement) {
      updateTextBranchElement(this.#accessiblePrimaryElement, text, language);
    }
    if (element.dataset.contentOwner !== "karaoke") {
      updateTextBranchElement(element, text, language);
    }
  }

  #reconcileOptionalBranch(
    current: HTMLElement | null,
    role: Exclude<TextBranchRole, "primary">,
    text: string | undefined,
    language: string | undefined,
  ): HTMLElement | null {
    if (
      text === undefined ||
      language === undefined ||
      text.trim().length === 0
    ) {
      current?.remove();
      return null;
    }
    if (current) {
      this.#updateOwnedTrackElement(current, text, language);
      return current;
    }
    const element = createTextBranchElement(
      this.element.ownerDocument,
      role,
      text,
      language,
    );
    if (
      role === "pronunciation" ||
      role === "background" ||
      role === "background-pronunciation"
    ) {
      this.#setTrackOwner(element, "row");
    }
    return element;
  }

  #reconcileBackgroundLane(): void {
    const children = [
      this.backgroundElement,
      this.backgroundPronunciationElement,
      this.backgroundTranslationElement,
    ].filter((element): element is HTMLElement => element !== null);
    if (children.length === 0) {
      this.backgroundLaneElement?.remove();
      this.backgroundLaneElement = null;
      return;
    }
    if (!this.backgroundLaneElement) {
      this.backgroundLaneElement = this.element.ownerDocument.createElement("div");
      this.backgroundLaneElement.className = "am-lp-background-lane";
      this.backgroundLaneElement.dataset.lane = "background";
      this.backgroundLaneElement.dataset.laneTarget = "none";
      this.backgroundLaneElement.dataset.laneVisual = "none";
      this.backgroundLaneElement.setAttribute("part", "background-lane");
    }
    this.backgroundLaneElement.replaceChildren(...children);
  }

  #reconcileForegroundSecondaryLane(): void {
    const children = [
      this.pronunciationElement,
      this.translationElement,
    ].filter((element): element is HTMLElement => element !== null);
    if (children.length === 0) {
      this.foregroundSecondaryLaneElement?.remove();
      this.foregroundSecondaryLaneElement = null;
      return;
    }
    if (!this.foregroundSecondaryLaneElement) {
      this.foregroundSecondaryLaneElement =
        this.element.ownerDocument.createElement("div");
      this.foregroundSecondaryLaneElement.className =
        "am-lp-foreground-secondary-lane";
      this.foregroundSecondaryLaneElement.dataset.lane = "foreground-secondary";
      this.foregroundSecondaryLaneElement.dataset.laneTarget = "expanded";
      this.foregroundSecondaryLaneElement.dataset.laneVisual = "expanded";
      this.foregroundSecondaryLaneElement.setAttribute(
        "part",
        "foreground-secondary-lane",
      );
    }
    this.foregroundSecondaryLaneElement.replaceChildren(...children);
  }

  #replaceRowChildren(): void {
    this.element.replaceChildren(
      this.primaryElement,
      this.#accessiblePrimaryElement,
      ...(this.foregroundSecondaryLaneElement
        ? [this.foregroundSecondaryLaneElement]
        : []),
      ...(this.backgroundLaneElement ? [this.backgroundLaneElement] : []),
    );
  }
}

export function createSyncedRowView(
  ownerDocument: Document,
  line: TextLyricLine,
  layout: LyricLineLayoutPlan,
): SyncedRowView {
  return new SyncedRowViewImpl(ownerDocument, line, layout);
}
