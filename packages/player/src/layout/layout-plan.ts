import { createLyricTimeIndex } from "../domain/time-index.js";
import type {
  LyricAgent,
  LyricDocument,
  LyricLanguage,
  LyricLineType,
} from "../domain/types.js";
import {
  createLyricAgentSidePlan,
  type LyricLineSideResolution,
} from "./agent-side.js";
import {
  resolveLyricLineDirection,
  type LyricDirectionResolution,
} from "./direction.js";
import {
  createLyricLineWidthPlan,
  type LyricLineWidthResolution,
} from "./line-width.js";

export interface LyricLineLayoutPlan {
  readonly lineId: string;
  readonly index: number;
  readonly documentIndex: number;
  readonly sourceIndex: number | null;
  readonly type: LyricLineType;
  readonly direction: LyricDirectionResolution;
  readonly side: LyricLineSideResolution;
  readonly width: LyricLineWidthResolution;
  /** Effective timing from the document index, including duration clamping. */
  readonly beginMs: number | null;
  readonly endMs: number | null;
  readonly endClampedToDocument: boolean;
  readonly language: LyricLanguage;
  readonly agent: LyricAgent | null;
}

export type LyricLineLayout = LyricLineLayoutPlan;

export interface LyricLayoutPlan {
  readonly documentId: string;
  readonly agentMapAvailable: boolean;
  readonly lines: readonly LyricLineLayoutPlan[];
  getByLineId(lineId: string): LyricLineLayoutPlan | null;
}

function cloneLanguage(language: LyricLanguage): LyricLanguage {
  return Object.freeze({
    declared: language.declared,
    inferred: language.inferred,
    effective: language.effective,
  });
}

function cloneAgent(agent: LyricAgent | null): LyricAgent | null {
  if (agent === null) return null;
  return Object.freeze({
    id: agent.id,
    type: agent.type,
    alignment: agent.alignment,
  });
}

/** Creates one immutable, source-ordered layout snapshot for a document. */
export function createLyricLayoutPlan(
  document: LyricDocument,
): LyricLayoutPlan {
  const timeIndex = createLyricTimeIndex(document);
  const timeEntriesByDocumentIndex = new Map(
    timeIndex.entries.map((entry) => [entry.documentIndex, entry]),
  );
  const agentsById = new Map(document.agents.map((agent) => [agent.id, agent]));
  const sidePlan = createLyricAgentSidePlan(document);
  const widthPlan = createLyricLineWidthPlan(document, sidePlan);

  const lines = Object.freeze(
    document.lines.map((line, documentIndex): LyricLineLayoutPlan => {
      const timeEntry = timeEntriesByDocumentIndex.get(documentIndex) ?? null;
      const side = sidePlan.lines[documentIndex];
      const width = widthPlan.lines[documentIndex];
      if (!side || !width) {
        throw new Error(
          `Missing layout inputs for lyric line at ${documentIndex}.`,
        );
      }

      const language =
        line.tracks === null
          ? document.language
          : line.tracks.foreground.language;
      return Object.freeze({
        lineId: line.id,
        index: line.index,
        documentIndex,
        sourceIndex: line.sourceIndex,
        type: line.type,
        direction: resolveLyricLineDirection(document, line),
        side,
        width,
        beginMs: timeEntry?.beginMs ?? null,
        endMs: timeEntry?.endMs ?? null,
        endClampedToDocument: timeEntry?.endClampedToDocument ?? false,
        language: cloneLanguage(language),
        agent: cloneAgent(agentsById.get(line.agentId) ?? null),
      });
    }),
  );
  const byLineId = new Map<string, LyricLineLayoutPlan>();
  for (const line of lines) {
    if (!byLineId.has(line.lineId)) byLineId.set(line.lineId, line);
  }

  return Object.freeze({
    documentId: document.id,
    agentMapAvailable: widthPlan.agentMapAvailable,
    lines,
    getByLineId(lineId: string): LyricLineLayoutPlan | null {
      return byLineId.get(lineId) ?? null;
    },
  });
}
