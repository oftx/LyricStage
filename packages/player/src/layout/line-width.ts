import type { LyricAgent, LyricDocument } from "../domain/types.js";
import {
  createLyricAgentSidePlan,
  type LyricAgentSidePlan,
} from "./agent-side.js";

export type LyricLineWidthRatio = 1 | 0.85;

export type LyricLineWidthReason =
  | "non-karaoke"
  | "agent-map-unavailable"
  | "multi-person-agent-map"
  | "non-person-agent-map"
  | "single-person";

export interface LyricLineWidthResolution {
  readonly lineId: string;
  readonly documentIndex: number;
  readonly fraction: LyricLineWidthRatio;
  readonly constrained: boolean;
  readonly reason: LyricLineWidthReason;
}

export interface LyricLineWidthPlan {
  readonly agentMapAvailable: boolean;
  readonly personAgentCount: number;
  readonly personOrOtherAgentCount: number;
  readonly lines: readonly LyricLineWidthResolution[];
  getByLineId(lineId: string): LyricLineWidthResolution | null;
}

function uniqueAgents(agents: readonly LyricAgent[]): readonly LyricAgent[] {
  const seen = new Set<string>();
  return agents.filter((agent) => {
    if (seen.has(agent.id)) return false;
    seen.add(agent.id);
    return true;
  });
}

function freezeWidth(
  lineId: string,
  documentIndex: number,
  ratio: LyricLineWidthRatio,
  reason: LyricLineWidthReason,
): LyricLineWidthResolution {
  return Object.freeze({
    lineId,
    documentIndex,
    fraction: ratio,
    constrained: ratio < 1,
    reason,
  });
}

/** Derives song-level duet eligibility before resolving each karaoke row width. */
export function createLyricLineWidthPlan(
  document: LyricDocument,
  sidePlan: LyricAgentSidePlan = createLyricAgentSidePlan(document),
): LyricLineWidthPlan {
  const agents = uniqueAgents(document.agents);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const personAgentCount = agents.filter(
    (agent) => agent.type === "person",
  ).length;
  const personOrOtherAgentCount = agents.filter(
    (agent) => agent.type === "person" || agent.type === "other",
  ).length;
  const agentMapAvailable =
    personOrOtherAgentCount > 1 &&
    sidePlan.lines.some((line) => line.sideCode === 6);

  const lines = Object.freeze(
    document.lines.map((line, documentIndex) => {
      if (line.type !== "karaoke") {
        return freezeWidth(line.id, documentIndex, 1, "non-karaoke");
      }
      if (!agentMapAvailable) {
        return freezeWidth(
          line.id,
          documentIndex,
          1,
          "agent-map-unavailable",
        );
      }

      const agent = agentsById.get(line.agentId) ?? null;
      if (agent !== null && agent.type !== "person") {
        return freezeWidth(
          line.id,
          documentIndex,
          0.85,
          "non-person-agent-map",
        );
      }
      if (agent?.type === "person" && personAgentCount > 1) {
        return freezeWidth(
          line.id,
          documentIndex,
          0.85,
          "multi-person-agent-map",
        );
      }
      return freezeWidth(line.id, documentIndex, 1, "single-person");
    }),
  );
  const byLineId = new Map<string, LyricLineWidthResolution>();
  for (const line of lines) {
    if (!byLineId.has(line.lineId)) byLineId.set(line.lineId, line);
  }

  return Object.freeze({
    agentMapAvailable,
    personAgentCount,
    personOrOtherAgentCount,
    lines,
    getByLineId(lineId: string): LyricLineWidthResolution | null {
      return byLineId.get(lineId) ?? null;
    },
  });
}
