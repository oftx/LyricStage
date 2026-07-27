import { createLyricTimeIndex, type LyricTimeIndex } from "../domain/time-index.js";
import type { LyricDocument } from "../domain/types.js";
import type { PlaybackFrame } from "../playback/create-playback-frame.js";
import {
  createLineCohort,
  type LineCohort,
} from "../playback/line-cohorts.js";

export interface DuetRendererOptions {
  readonly resolveRow: (lineId: string) => HTMLElement | null;
}

export interface DuetRendererState {
  readonly documentId: string | null;
  readonly activeCohort: LineCohort | null;
}

export interface DuetRenderer {
  setDocument(document: LyricDocument | null): void;
  renderFrame(frame: PlaybackFrame): void;
  resetPlaybackState(): void;
  getState(): DuetRendererState;
  destroy(): void;
}

class DuetRendererImpl implements DuetRenderer {
  readonly #resolveRow: (lineId: string) => HTMLElement | null;
  #document: LyricDocument | null = null;
  #timeIndex: LyricTimeIndex | null = null;
  #activeCohort: LineCohort | null = null;
  #activeKey: string | null = null;
  #markedLineIds = new Set<string>();
  #destroyed = false;

  constructor(options: DuetRendererOptions) {
    this.#resolveRow = options.resolveRow;
  }

  setDocument(document: LyricDocument | null): void {
    this.#assertAlive();
    this.#clearRows();
    this.#document = document;
    this.#timeIndex = document ? createLyricTimeIndex(document) : null;
    this.#activeCohort = null;
    this.#activeKey = null;
  }

  renderFrame(frame: PlaybackFrame): void {
    this.#assertAlive();
    const document = this.#document;
    const timeIndex = this.#timeIndex;
    if (!document || !timeIndex || frame.documentId !== document.id) return;
    const activeKey = frame.activeLineIdsInSourceOrder
      .map((lineId) => `${lineId.length}:${lineId}`)
      .join("|");
    if (activeKey === this.#activeKey) return;
    const cohort = createLineCohort(
      document,
      frame.activeLineIdsInSourceOrder,
      timeIndex,
    );
    const nextIds = new Set(cohort?.lineIds ?? []);
    for (const lineId of this.#markedLineIds) {
      if (nextIds.has(lineId)) continue;
      this.#clearRow(lineId);
    }
    const simultaneous = cohort?.simultaneous === true;
    cohort?.members.forEach((member, cohortIndex) => {
      const row = this.#resolveRow(member.lineId);
      if (!row) return;
      row.dataset.activeCohortId = cohort.id;
      row.dataset.activeCohortIndex = String(cohortIndex);
      row.dataset.simultaneous = String(simultaneous);
      row.dataset.duetActive = String(simultaneous);
      row.classList.toggle("am-lp-row-simultaneous", simultaneous);
    });
    this.#markedLineIds = nextIds;
    this.#activeCohort = cohort;
    this.#activeKey = activeKey;
  }

  resetPlaybackState(): void {
    this.#assertAlive();
    this.#clearRows();
    this.#activeCohort = null;
    this.#activeKey = null;
  }

  getState(): DuetRendererState {
    return Object.freeze({
      documentId: this.#document?.id ?? null,
      activeCohort: this.#activeCohort,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#clearRows();
    this.#document = null;
    this.#timeIndex = null;
    this.#activeCohort = null;
    this.#activeKey = null;
  }

  #clearRows(): void {
    for (const lineId of this.#markedLineIds) this.#clearRow(lineId);
    this.#markedLineIds.clear();
  }

  #clearRow(lineId: string): void {
    const row = this.#resolveRow(lineId);
    if (!row) return;
    delete row.dataset.activeCohortId;
    delete row.dataset.activeCohortIndex;
    delete row.dataset.simultaneous;
    delete row.dataset.duetActive;
    row.classList.toggle("am-lp-row-simultaneous", false);
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("Duet renderer is destroyed");
  }
}

export function createDuetRenderer(options: DuetRendererOptions): DuetRenderer {
  return new DuetRendererImpl(options);
}
