import type {
  LyricTimeIndex,
  LyricTimeIndexEntry,
} from "../domain/time-index.js";
import { createStableId } from "../domain/ids.js";
import type { LyricDocument, LyricLine, LyricLineType } from "../domain/types.js";
import { selectActiveLines } from "./active-lines.js";

export interface LineCohortMember {
  readonly line: LyricLine;
  readonly lineId: string;
  readonly lineType: LyricLineType;
  readonly documentIndex: number;
  readonly sourceIndex: number | null;
  readonly sectionIndex: number | null;
  readonly beginMs: number | null;
  readonly endMs: number | null;
}

export interface LineCohort {
  /** Stable for the document and canonical member set; never depends on time. */
  readonly id: string;
  readonly documentId: string;
  readonly members: readonly LineCohortMember[];
  readonly lineIds: readonly string[];
  readonly simultaneous: boolean;
  /** Intersection of all known member intervals. */
  readonly sharedBeginMs: number | null;
  readonly sharedEndMs: number | null;
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function freezeMember(
  line: LyricLine,
  documentIndex: number,
  entry: LyricTimeIndexEntry | null,
): LineCohortMember {
  return Object.freeze({
    line,
    lineId: line.id,
    lineType: line.type,
    documentIndex,
    sourceIndex: line.sourceIndex,
    sectionIndex: line.sectionIndex,
    beginMs: finiteOrNull(entry?.beginMs ?? line.begin.valueMs),
    endMs: finiteOrNull(entry?.endMs ?? line.end.valueMs),
  });
}

function resolveSharedInterval(
  members: readonly LineCohortMember[],
): { readonly beginMs: number | null; readonly endMs: number | null } {
  if (members.length === 0 || members.some(({ beginMs }) => beginMs === null)) {
    return { beginMs: null, endMs: null };
  }

  let beginMs = Number.NEGATIVE_INFINITY;
  let endMs: number | null = null;
  for (const member of members) {
    beginMs = Math.max(beginMs, member.beginMs as number);
    if (member.endMs !== null) {
      endMs = endMs === null ? member.endMs : Math.min(endMs, member.endMs);
    }
  }
  return { beginMs, endMs };
}

/**
 * Canonicalizes a cohort without reordering the document. Unknown and duplicate
 * IDs are ignored; duplicate document IDs retain their first source occurrence.
 */
export function createLineCohort(
  document: LyricDocument,
  requestedLineIds: Iterable<string>,
  timeIndex?: LyricTimeIndex,
): LineCohort | null {
  const requested = new Set(requestedLineIds);
  if (requested.size === 0) return null;

  const seen = new Set<string>();
  const members: LineCohortMember[] = [];
  document.lines.forEach((line, documentIndex) => {
    if (!requested.has(line.id) || seen.has(line.id)) return;
    seen.add(line.id);
    members.push(
      freezeMember(line, documentIndex, timeIndex?.getByLineId(line.id) ?? null),
    );
  });
  if (members.length === 0) return null;

  const frozenMembers = Object.freeze(members);
  const lineIds = Object.freeze(members.map(({ lineId }) => lineId));
  const shared = resolveSharedInterval(frozenMembers);
  const simultaneous =
    members.length > 1 &&
    shared.beginMs !== null &&
    (shared.endMs === null || shared.beginMs < shared.endMs);

  return Object.freeze({
    id: createStableId("line-cohort", document.id, ...lineIds),
    documentId: document.id,
    members: frozenMembers,
    lineIds,
    simultaneous,
    sharedBeginMs: shared.beginMs,
    sharedEndMs: shared.endMs,
  });
}

/** Selects all half-open active intervals and preserves canonical source order. */
export function selectActiveLineCohort(
  document: LyricDocument,
  timeIndex: LyricTimeIndex,
  positionMs: number,
): LineCohort | null {
  if (!Number.isFinite(positionMs)) return null;
  const active = selectActiveLines(timeIndex, positionMs);
  return createLineCohort(document, active.orderedLineIds, timeIndex);
}
