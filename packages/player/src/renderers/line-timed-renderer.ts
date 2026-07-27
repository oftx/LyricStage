import type { LyricDocument, TextLyricLine } from "../domain/types.js";
import {
  createLyricLayoutPlan,
  type LyricLayoutPlan,
  type LyricLineLayoutPlan,
} from "../layout/layout-plan.js";
import type { PlaybackFrame } from "../playback/create-playback-frame.js";
import {
  createTerminalLinePolicy,
  type TerminalLineCohort,
  type TerminalLineMember,
  type TerminalLinePolicy,
} from "../playback/terminal-policy.js";
import {
  createSyncedRowView,
  type SecondaryTextVisibility,
  type SyncedRowPaintHost,
  type SyncedRowState,
  type SyncedRowView,
} from "../view/row-view.js";

export interface LineTimedRenderOptions {
  readonly reducedMotion?: boolean;
  readonly paintSuppressedLineIds?: ReadonlySet<string>;
  readonly visualStyleFocusLineId?: string | null;
  readonly scaleActiveLineIds?: ReadonlySet<string>;
  /**
   * When set, primary/past paint follows this set instead of time-based
   * activeLineIds. Used so fade-in/out starts with the row-move FLIP (pre-anchor
   * / focus handoff), not after the move already finished.
   * Must include all concurrent active partners — never only the focus line.
   */
  readonly visualPrimaryLineIds?: ReadonlySet<string> | null;
  /** Opacity transition duration matched to the concurrent row-move. */
  readonly alphaDurationMs?: number;
  readonly alphaDelayMs?: number;
  /**
   * When set with alphaDurationMs, only these line ids receive the mid-move
   * fill timing (usually the newly focused line). Concurrent partners keep
   * their already-settled alpha without restarting the ramp.
   */
  readonly alphaTimingLineIds?: ReadonlySet<string>;
}

export interface LineTimedRenderer {
  setDocument(
    document: LyricDocument | null,
    layoutPlan?: LyricLayoutPlan | null,
  ): void;
  setSecondaryVisibility(visibility: SecondaryTextVisibility): void;
  renderFrame(
    frame: PlaybackFrame,
    options?: LineTimedRenderOptions,
  ): void;
  resetPlaybackState(): void;
  getPaintHost(lineId: string): SyncedRowPaintHost | null;
  getRow(lineId: string): HTMLElement | null;
  getForegroundSecondaryLane(lineId: string): HTMLElement | null;
  getSecondaryLane(lineId: string): HTMLElement | null;
  getRowCount(): number;
  destroy(): void;
}

interface LineTimedRow {
  readonly view: SyncedRowView;
  layout: LyricLineLayoutPlan;
}

function getLayout(
  plan: LyricLayoutPlan,
  lineId: string,
): LyricLineLayoutPlan {
  const layout = plan.getByLineId(lineId);
  if (!layout) throw new Error(`Missing layout for lyric line "${lineId}"`);
  return layout;
}

function resolveInactiveState(
  layout: LyricLineLayoutPlan,
  callbackPlaybackPositionMs: number,
): SyncedRowState {
  return layout.endMs !== null && callbackPlaybackPositionMs >= layout.endMs
    ? "past"
    : "future";
}

function resolveTerminalMemberPhase(
  member: TerminalLineMember,
  cohort: TerminalLineCohort,
  positionMs: number,
): "before" | "active" | "held" | "exiting" | "settled" {
  if (!Number.isFinite(positionMs) || positionMs < member.beginMs) return "before";
  if (positionMs < member.endMs) return "active";
  if (positionMs < cohort.boundaryMs) return "held";
  if (positionMs < cohort.settledAtMs) return "exiting";
  return "settled";
}

class LineTimedRendererImpl implements LineTimedRenderer {
  readonly #container: HTMLElement;
  #documentId: string | null = null;
  #terminalPolicy: TerminalLinePolicy | null = null;
  #terminalMemberByLineId = new Map<string, TerminalLineMember>();
  #rows = new Map<string, LineTimedRow>();
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
      this.#terminalPolicy = null;
      this.#terminalMemberByLineId.clear();
      this.#rows.clear();
      this.#container.replaceChildren();
      return;
    }

    const layoutPlan = suppliedLayoutPlan ?? createLyricLayoutPlan(document);
    if (layoutPlan.documentId !== document.id) {
      throw new Error("The line-timed layout plan belongs to another document");
    }
    const sameDocument = this.#documentId === document.id;
    const terminalPolicy = createTerminalLinePolicy(document);
    const terminalMemberByLineId = new Map(
      terminalPolicy.cohort?.members.map((member) => [member.lineId, member]) ??
        [],
    );
    const nextRows = new Map<string, LineTimedRow>();
    const fragment = this.#container.ownerDocument.createDocumentFragment();

    for (const line of document.lines) {
      if (line.type === "instrumental") continue;
      const layout = getLayout(layoutPlan, line.id);
      const existing = sameDocument ? this.#rows.get(line.id) : undefined;
      const row = existing ?? this.#createRow(line, layout);
      row.layout = layout;
      row.view.update(line, layout);
      row.view.setSecondaryVisibility(this.#visibility);
      row.view.setPlaybackState("future", { animate: false });
      const emptyPoem =
        line.tracks !== null
        && line.tracks.foreground.text.trim().length === 0;
      if (emptyPoem) {
        row.view.element.dataset.empty = "true";
      } else {
        delete row.view.element.dataset.empty;
      }
      row.view.element.dataset.terminalCohortMember = String(
        terminalMemberByLineId.has(line.id),
      );
      row.view.element.dataset.terminalCohortAnchor = String(
        terminalPolicy.cohort?.anchorLineId === line.id,
      );
      row.view.element.dataset.terminalPhase = terminalMemberByLineId.has(line.id)
        ? "before"
        : "none";
      nextRows.set(line.id, row);
      fragment.append(row.view.element);
    }

    this.#container.replaceChildren(fragment);
    this.#rows.clear();
    this.#rows = nextRows;
    this.#documentId = document.id;
    this.#terminalPolicy = terminalPolicy;
    this.#terminalMemberByLineId = terminalMemberByLineId;
  }

  setSecondaryVisibility(visibility: SecondaryTextVisibility): void {
    this.#assertAlive();
    this.#visibility = { ...visibility };
    for (const row of this.#rows.values()) {
      row.view.setSecondaryVisibility(visibility);
    }
  }

  renderFrame(
    frame: PlaybackFrame,
    options: LineTimedRenderOptions = {},
  ): void {
    this.#assertAlive();
    if (frame.documentId !== this.#documentId) return;
    const animate = frame.mode === "playback" && !options.reducedMotion;
    const terminalCohort = this.#terminalPolicy?.cohort ?? null;
    const visualStyleFocusDocumentIndex = options.visualStyleFocusLineId
      ? (this.#rows.get(options.visualStyleFocusLineId)?.layout.documentIndex ??
        null)
      : null;

    for (const [lineId, row] of this.#rows) {
      const terminalMember = this.#terminalMemberByLineId.get(lineId);
      const terminalPhase =
        terminalMember && terminalCohort
          ? resolveTerminalMemberPhase(
              terminalMember,
              terminalCohort,
              frame.callbackPlaybackPositionMs,
            )
          : "none";
      const suppressed = options.paintSuppressedLineIds?.has(lineId) === true;
      const concurrentPrimaryTail =
        !suppressed && frame.concurrentPrimaryTailLineIds.has(lineId);
      // Motion-coupled primary: during pre-anchor / focus FLIP, paint the
      // moving-in line as active immediately so fade tracks the move window.
      const motionPrimary = options.visualPrimaryLineIds;
      const isTimePrimary =
        frame.activeLineIds.has(lineId) ||
        concurrentPrimaryTail ||
        terminalPhase === "held";
      const isPrimary = !suppressed && (
        motionPrimary
          ? motionPrimary.has(lineId)
          : isTimePrimary
      );
      const state = isPrimary
        ? "active"
        : visualStyleFocusDocumentIndex === null
          ? resolveInactiveState(
              row.layout,
              frame.callbackPlaybackPositionMs,
            )
          : row.layout.documentIndex < visualStyleFocusDocumentIndex
            ? "past"
            : "future";
      const alphaTimingAllowed =
        !options.alphaTimingLineIds
        || options.alphaTimingLineIds.has(lineId);
      const alphaTiming =
        animate
        && alphaTimingAllowed
        && options.alphaDurationMs !== undefined
        && Number.isFinite(options.alphaDurationMs)
        && options.alphaDurationMs > 0
          ? {
              alphaDurationMs: options.alphaDurationMs,
              alphaDelayMs: options.alphaDelayMs ?? 0,
            }
          : {};
      row.view.setPlaybackState(state, {
        animate,
        ...(options.scaleActiveLineIds
          ? { scaleActiveOverride: options.scaleActiveLineIds.has(lineId) }
          : {}),
        ...alphaTiming,
      });
      if (
        row.view.element.dataset.concurrentPrimaryTail !==
        String(concurrentPrimaryTail)
      ) {
        row.view.element.dataset.concurrentPrimaryTail = String(
          concurrentPrimaryTail,
        );
      }
      if (row.view.element.dataset.terminalPhase !== terminalPhase) {
        row.view.element.dataset.terminalPhase = terminalPhase;
      }
      if (terminalPhase === "exiting") {
        row.view.element.dataset.transitionRole = "terminal-exit";
      } else if (row.view.element.dataset.transitionRole === "terminal-exit") {
        row.view.element.dataset.transitionRole =
          state === "past" ? "deactivate" : state === "active" ? "activate" : "settle";
      }
    }
  }

  resetPlaybackState(): void {
    this.#assertAlive();
    for (const row of this.#rows.values()) {
      row.view.setPlaybackState("future", { animate: false });
    }
  }

  getRow(lineId: string): HTMLElement | null {
    return this.#rows.get(lineId)?.view.element ?? null;
  }

  getPaintHost(lineId: string): SyncedRowPaintHost | null {
    return this.#rows.get(lineId)?.view ?? null;
  }

  getSecondaryLane(lineId: string): HTMLElement | null {
    return this.#rows.get(lineId)?.view.backgroundLaneElement ?? null;
  }

  getForegroundSecondaryLane(lineId: string): HTMLElement | null {
    return this.#rows.get(lineId)?.view.foregroundSecondaryLaneElement ?? null;
  }

  getRowCount(): number {
    return this.#rows.size;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#documentId = null;
    this.#terminalPolicy = null;
    this.#terminalMemberByLineId.clear();
    this.#rows.clear();
    this.#container.replaceChildren();
  }

  #createRow(
    line: TextLyricLine,
    layout: LyricLineLayoutPlan,
  ): LineTimedRow {
    return {
      view: createSyncedRowView(
        this.#container.ownerDocument,
        line,
        layout,
      ),
      layout,
    };
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("Line-timed renderer is destroyed");
  }
}

export function createLineTimedRenderer(
  container: HTMLElement,
): LineTimedRenderer {
  return new LineTimedRendererImpl(container);
}
