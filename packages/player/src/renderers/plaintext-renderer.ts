import type {
  LyricDocument,
  LyricLanguage,
  TextLyricLine,
} from "../domain/types.js";
import {
  createLyricLayoutPlan,
  type LyricLayoutPlan,
  type LyricLineLayoutPlan,
} from "../layout/layout-plan.js";
import {
  applyRowLayout,
  createTextBranchElement,
  setBranchVisibility,
  updateTextBranchElement,
  type SecondaryTextVisibility,
  type TextBranchRole,
} from "../view/row-view.js";

export interface PlaintextRenderer {
  setDocument(
    document: LyricDocument | null,
    layoutPlan?: LyricLayoutPlan | null,
  ): void;
  setSecondaryVisibility(visibility: SecondaryTextVisibility): void;
  getRow(lineId: string): HTMLElement | null;
  getRowCount(): number;
  destroy(): void;
}

interface PlaintextBranch {
  readonly role: TextBranchRole;
  readonly text: string;
  readonly language: LyricLanguage;
  readonly visibility: "always" | "pronunciation" | "translation";
  readonly tone: "primary" | "secondary" | "tertiary";
}

interface PlaintextRow {
  readonly element: HTMLElement;
  readonly branches: Map<TextBranchRole, HTMLElement>;
}

function isDistinct(
  candidate: string,
  reference: string | undefined,
): boolean {
  return reference === undefined || candidate !== reference;
}

function hasVisibleText(text: string | undefined): text is string {
  return text !== undefined && text.trim().length > 0;
}

function isEmptyPoemLine(line: TextLyricLine): boolean {
  return !hasVisibleText(line.tracks.foreground.text);
}

function collectBranches(line: TextLyricLine): readonly PlaintextBranch[] {
  const branches: PlaintextBranch[] = [];
  const foreground = line.tracks.foreground;
  const background = line.tracks.background;
  const foregroundPronunciation = line.tracks.foregroundPronunciation;
  const backgroundPronunciation = line.tracks.backgroundPronunciation;

  // Empty poem rows still mount a primary branch so line-height is preserved.
  if (hasVisibleText(foreground.text) || isEmptyPoemLine(line)) {
    branches.push({
      role: "primary",
      text: hasVisibleText(foreground.text) ? foreground.text : "\u00a0",
      language: foreground.language,
      visibility: "always",
      tone: "primary",
    });
  }
  if (
    background &&
    hasVisibleText(background.text) &&
    isDistinct(background.text, foreground.text)
  ) {
    branches.push({
      role: "background",
      text: background.text,
      language: background.language,
      visibility: "always",
      tone: "secondary",
    });
  }
  if (
    foregroundPronunciation &&
    hasVisibleText(foregroundPronunciation.text)
  ) {
    branches.push({
      role: "pronunciation",
      text: foregroundPronunciation.text,
      language: foregroundPronunciation.language,
      visibility: "pronunciation",
      tone: "secondary",
    });
  }
  if (
    backgroundPronunciation &&
    hasVisibleText(backgroundPronunciation.text) &&
    isDistinct(
      backgroundPronunciation.text,
      foregroundPronunciation?.text,
    )
  ) {
    branches.push({
      role: "background-pronunciation",
      text: backgroundPronunciation.text,
      language: backgroundPronunciation.language,
      visibility: "pronunciation",
      tone: "secondary",
    });
  }
  if (line.translation && hasVisibleText(line.translation.text)) {
    branches.push({
      role: "translation",
      text: line.translation.text,
      language: line.translation.language,
      visibility: "translation",
      tone: "tertiary",
    });
  }
  if (
    line.backgroundTranslation &&
    hasVisibleText(line.backgroundTranslation.text) &&
    isDistinct(line.backgroundTranslation.text, line.translation?.text)
  ) {
    branches.push({
      role: "background-translation",
      text: line.backgroundTranslation.text,
      language: line.backgroundTranslation.language,
      visibility: "translation",
      tone: "tertiary",
    });
  }
  return branches;
}

function getLayout(
  plan: LyricLayoutPlan,
  lineId: string,
): LyricLineLayoutPlan {
  const layout = plan.getByLineId(lineId);
  if (!layout) throw new Error(`Missing layout for lyric line "${lineId}"`);
  return layout;
}

class PlaintextRendererImpl implements PlaintextRenderer {
  readonly #container: HTMLElement;
  #documentId: string | null = null;
  #rows = new Map<string, PlaintextRow>();
  #visibility: SecondaryTextVisibility = {
    translationVisible: true,
    pronunciationVisible: true,
  };
  #destroyed = false;

  constructor(container: HTMLElement) {
    this.#container = container;
  }

  setDocument(
    document: LyricDocument | null,
    suppliedLayoutPlan?: LyricLayoutPlan | null,
  ): void {
    this.#assertAlive();
    if (!document) {
      this.#documentId = null;
      this.#rows.clear();
      this.#container.replaceChildren();
      return;
    }

    const layoutPlan = suppliedLayoutPlan ?? createLyricLayoutPlan(document);
    if (layoutPlan.documentId !== document.id) {
      throw new Error("The plaintext layout plan belongs to another document");
    }
    const sameDocument = this.#documentId === document.id;
    const nextRows = new Map<string, PlaintextRow>();
    const fragment = this.#container.ownerDocument.createDocumentFragment();

    for (const line of document.lines) {
      if (line.type === "instrumental") continue;
      const existing = sameDocument ? this.#rows.get(line.id) : undefined;
      const row = existing ?? this.#createRow(line);
      this.#updateRow(row, line, getLayout(layoutPlan, line.id));
      nextRows.set(line.id, row);
      fragment.append(row.element);
    }

    this.#container.replaceChildren(fragment);
    this.#rows.clear();
    this.#rows = nextRows;
    this.#documentId = document.id;
  }

  setSecondaryVisibility(visibility: SecondaryTextVisibility): void {
    this.#assertAlive();
    this.#visibility = { ...visibility };
    for (const row of this.#rows.values()) this.#applyVisibility(row);
  }

  getRow(lineId: string): HTMLElement | null {
    return this.#rows.get(lineId)?.element ?? null;
  }

  getRowCount(): number {
    return this.#rows.size;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#documentId = null;
    this.#rows.clear();
    this.#container.replaceChildren();
  }

  #createRow(line: TextLyricLine): PlaintextRow {
    const element = this.#container.ownerDocument.createElement("div");
    element.classList.add("am-lp-row", "am-lp-plaintext-row");
    element.dataset.lineId = line.id;
    element.dataset.lineType = line.type;
    element.setAttribute("part", "row plaintext-row");
    return { element, branches: new Map() };
  }

  #updateRow(
    row: PlaintextRow,
    line: TextLyricLine,
    layout: LyricLineLayoutPlan,
  ): void {
    const nextBranches = new Map<TextBranchRole, HTMLElement>();
    const orderedElements: HTMLElement[] = [];
    for (const branch of collectBranches(line)) {
      const existing = row.branches.get(branch.role);
      const element =
        existing ??
        createTextBranchElement(
          this.#container.ownerDocument,
          branch.role,
          branch.text,
          branch.language.effective,
          "plaintext",
        );
      updateTextBranchElement(
        element,
        branch.text,
        branch.language.effective,
      );
      element.dataset.tone = branch.tone;
      element.dataset.visibility = branch.visibility;
      element.setAttribute("part", branch.role);
      nextBranches.set(branch.role, element);
      orderedElements.push(element);
    }
    row.element.replaceChildren(...orderedElements);
    row.branches.clear();
    for (const entry of nextBranches) row.branches.set(...entry);
    row.element.dataset.lineType = line.type;
    row.element.dataset.sectionIndex = String(line.sectionIndex);
    if (isEmptyPoemLine(line)) {
      row.element.dataset.empty = "true";
    } else {
      delete row.element.dataset.empty;
    }
    delete row.element.dataset.sectionStart;
    applyRowLayout(row.element, layout);
    this.#applyVisibility(row);
  }

  #applyVisibility(row: PlaintextRow): void {
    for (const element of row.branches.values()) {
      const visibility = element.dataset.visibility;
      const visible =
        visibility === "pronunciation"
          ? this.#visibility.pronunciationVisible
          : visibility === "translation"
            ? this.#visibility.translationVisible
            : true;
      setBranchVisibility(element, visible);
    }
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("Plaintext renderer is destroyed");
  }
}

export function createPlaintextRenderer(
  container: HTMLElement,
): PlaintextRenderer {
  return new PlaintextRendererImpl(container);
}
