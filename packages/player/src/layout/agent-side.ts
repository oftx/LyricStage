import type {
  LyricAgent,
  LyricDocument,
  LyricLine,
} from "../domain/types.js";
import {
  resolveLyricLineDirection,
  type LyricLayoutDirection,
} from "./direction.js";

export type LyricSideCode = 1 | 5 | 6;
export type LyricLineSide = "start" | "end";

export type LyricSideReason =
  | "explicit-start"
  | "explicit-end"
  | "group-neutral"
  | "first-person"
  | "first-other"
  | "same-agent"
  | "changed-agent-same-direction"
  | "changed-agent-different-direction"
  | "next-text-line"
  | "no-following-text-line";

export interface LyricLineSideResolution {
  readonly lineId: string;
  readonly documentIndex: number;
  readonly sideCode: LyricSideCode;
  readonly side: LyricLineSide;
  readonly reason: LyricSideReason;
}

export interface LyricAgentSidePlan {
  readonly lines: readonly LyricLineSideResolution[];
  getByLineId(lineId: string): LyricLineSideResolution | null;
}

interface PreviousVoiceState {
  readonly agentId: string;
  readonly sideCode: 5 | 6;
  readonly direction: LyricLayoutDirection;
}

function toSide(sideCode: LyricSideCode): LyricLineSide {
  return sideCode === 6 ? "end" : "start";
}

function freezeResolution(
  line: LyricLine,
  documentIndex: number,
  sideCode: LyricSideCode,
  reason: LyricSideReason,
): LyricLineSideResolution {
  return Object.freeze({
    lineId: line.id,
    documentIndex,
    sideCode,
    side: toSide(sideCode),
    reason,
  });
}
function resolveExplicitSide(
  line: LyricLine,
  documentIndex: number,
  agent: LyricAgent,
): LyricLineSideResolution | null {
  if (agent.alignment === "start") {
    return freezeResolution(line, documentIndex, 5, "explicit-start");
  }
  if (agent.alignment === "end") {
    return freezeResolution(line, documentIndex, 6, "explicit-end");
  }
  return null;
}

function initialVoiceSide(agent: LyricAgent | null): 5 | 6 {
  return agent?.type === "other" ? 6 : 5;
}

function initialVoiceReason(agent: LyricAgent | null): LyricSideReason {
  return agent?.type === "other" ? "first-other" : "first-person";
}

function resolveTextLineSide(
  document: LyricDocument,
  line: LyricLine,
  documentIndex: number,
  agent: LyricAgent | null,
  previousVoice: PreviousVoiceState | null,
): {
  readonly resolution: LyricLineSideResolution;
  readonly nextPreviousVoice: PreviousVoiceState | null;
} {
  const direction = resolveLyricLineDirection(document, line).direction;
  const explicit = agent
    ? resolveExplicitSide(line, documentIndex, agent)
    : null;

  if (agent?.type === "group") {
    return {
      resolution:
        explicit ??
        freezeResolution(line, documentIndex, 1, "group-neutral"),
      nextPreviousVoice: previousVoice,
    };
  }

  if (explicit) {
    return {
      resolution: explicit,
      nextPreviousVoice: {
        agentId: line.agentId,
        sideCode: explicit.sideCode === 6 ? 6 : 5,
        direction,
      },
    };
  }

  if (previousVoice === null) {
    const sideCode = initialVoiceSide(agent);
    return {
      resolution: freezeResolution(
        line,
        documentIndex,
        sideCode,
        initialVoiceReason(agent),
      ),
      nextPreviousVoice: { agentId: line.agentId, sideCode, direction },
    };
  }

  if (previousVoice.agentId === line.agentId) {
    return {
      resolution: freezeResolution(
        line,
        documentIndex,
        previousVoice.sideCode,
        "same-agent",
      ),
      nextPreviousVoice: {
        agentId: line.agentId,
        sideCode: previousVoice.sideCode,
        direction,
      },
    };
  }

  const sameDirection = previousVoice.direction === direction;
  const sideCode = sameDirection
    ? previousVoice.sideCode === 5
      ? 6
      : 5
    : previousVoice.sideCode;
  return {
    resolution: freezeResolution(
      line,
      documentIndex,
      sideCode,
      sameDirection
        ? "changed-agent-same-direction"
        : "changed-agent-different-direction",
    ),
    nextPreviousVoice: { agentId: line.agentId, sideCode, direction },
  };
}

/** Plans all sides in one pass so repeated agents retain document-wide context. */
export function createLyricAgentSidePlan(
  document: LyricDocument,
): LyricAgentSidePlan {
  const agentsById = new Map(document.agents.map((agent) => [agent.id, agent]));
  const resolutions: Array<LyricLineSideResolution | null> = [];
  let previousVoice: PreviousVoiceState | null = null;

  document.lines.forEach((line, documentIndex) => {
    if (line.type === "instrumental") {
      resolutions.push(null);
      return;
    }

    const result = resolveTextLineSide(
      document,
      line,
      documentIndex,
      agentsById.get(line.agentId) ?? null,
      previousVoice,
    );
    resolutions.push(result.resolution);
    previousVoice = result.nextPreviousVoice;
  });

  let nextTextSide: LyricLineSideResolution | null = null;
  for (let index = document.lines.length - 1; index >= 0; index -= 1) {
    const line = document.lines[index];
    const resolution = resolutions[index];
    if (!line) continue;
    if (resolution !== null && resolution !== undefined) {
      nextTextSide = resolution;
      continue;
    }

    resolutions[index] = nextTextSide
      ? freezeResolution(
          line,
          index,
          nextTextSide.sideCode,
          "next-text-line",
        )
      : freezeResolution(line, index, 1, "no-following-text-line");
  }

  const lines = Object.freeze(
    resolutions.filter(
      (resolution): resolution is LyricLineSideResolution =>
        resolution !== null,
    ),
  );
  const byLineId = new Map<string, LyricLineSideResolution>();
  for (const resolution of lines) {
    if (!byLineId.has(resolution.lineId)) {
      byLineId.set(resolution.lineId, resolution);
    }
  }

  return Object.freeze({
    lines,
    getByLineId(lineId: string): LyricLineSideResolution | null {
      return byLineId.get(lineId) ?? null;
    },
  });
}
