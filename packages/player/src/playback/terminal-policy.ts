import { createStableId } from "../domain/ids.js";
import {
  createLyricTimeIndex,
  type LyricTimeIndexEntry,
} from "../domain/time-index.js";
import type {
  KnownLyricTimestampSource,
  LyricDocument,
  LyricLine,
} from "../domain/types.js";

const DEFAULT_COHORT_WINDOW_MS = 600;
const DEFAULT_EXIT_DURATION_MS = 350;

export interface TerminalLinePolicyOptions {
  /** Maximum earlier end included in a same-section line-timed tail. */
  readonly cohortWindowMs?: number;
  readonly exitDurationMs?: number;
}

export type TerminalBoundarySource =
  | KnownLyricTimestampSource
  | "document-duration-clamped";

export type TerminalLineRole = "anchor" | "member";

export interface TerminalLineMember {
  readonly lineId: string;
  readonly documentIndex: number;
  readonly sourceIndex: number | null;
  readonly sectionIndex: number | null;
  readonly beginMs: number;
  /** The line's own effective half-open playback end. */
  readonly endMs: number;
  readonly sourceEndMs: number | null;
  readonly endDistanceMs: number;
  readonly role: TerminalLineRole;
}

export interface TerminalLineCohort {
  readonly id: string;
  readonly documentId: string;
  readonly anchorLineId: string;
  readonly boundaryMs: number;
  readonly boundarySource: TerminalBoundarySource;
  readonly exitDurationMs: number;
  readonly settledAtMs: number;
  readonly coordinated: boolean;
  readonly members: readonly TerminalLineMember[];
  readonly lineIds: readonly string[];
}

export interface TerminalLinePolicy {
  readonly documentId: string;
  readonly cohortWindowMs: number;
  readonly exitDurationMs: number;
  readonly cohort: TerminalLineCohort | null;
}

export type TerminalMemberPhase =
  | "before"
  | "active"
  | "held"
  | "exiting"
  | "settled";

export interface TerminalMemberState {
  readonly lineId: string;
  readonly phase: TerminalMemberPhase;
  readonly elapsedMs: number;
}

export type TerminalPlaybackPhase =
  | "unavailable"
  | "before"
  | "active"
  | "exiting"
  | "settled";

export interface TerminalPlaybackState {
  readonly documentId: string;
  readonly cohortId: string | null;
  readonly positionMs: number;
  readonly positionValid: boolean;
  readonly phase: TerminalPlaybackPhase;
  readonly members: readonly TerminalMemberState[];
  readonly activeLineIds: readonly string[];
  readonly heldLineIds: readonly string[];
  readonly exitingLineIds: readonly string[];
  readonly settledLineIds: readonly string[];
}

interface TerminalCandidate {
  readonly line: LyricLine;
  readonly entry: LyricTimeIndexEntry;
}

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function finiteDelta(laterMs: number, earlierMs: number): number {
  const difference = laterMs - earlierMs;
  if (Number.isFinite(difference)) return Math.max(0, difference);
  return laterMs >= earlierMs ? Number.MAX_VALUE : 0;
}

function finiteSum(left: number, right: number): number {
  const sum = left + right;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

function isTimedTextCandidate(entry: LyricTimeIndexEntry): boolean {
  return (
    entry.line.type !== "instrumental" &&
    entry.line.type !== "credit" &&
    entry.endMs !== null &&
    Number.isFinite(entry.beginMs) &&
    Number.isFinite(entry.endMs) &&
    entry.endMs > entry.beginMs
  );
}

function compareTerminalCandidate(
  left: TerminalCandidate,
  right: TerminalCandidate,
): number {
  const leftEnd = left.entry.endMs as number;
  const rightEnd = right.entry.endMs as number;
  return (
    leftEnd - rightEnd ||
    left.entry.beginMs - right.entry.beginMs ||
    left.entry.documentIndex - right.entry.documentIndex
  );
}

function intervalsOverlap(
  left: LyricTimeIndexEntry,
  right: LyricTimeIndexEntry,
): boolean {
  return (
    left.endMs !== null &&
    right.endMs !== null &&
    left.beginMs < right.endMs &&
    right.beginMs < left.endMs
  );
}

function boundarySource(entry: LyricTimeIndexEntry): TerminalBoundarySource {
  return entry.endClampedToDocument
    ? "document-duration-clamped"
    : entry.line.end.source === "unknown"
      ? "derived"
      : entry.line.end.source;
}

function freezeMember(
  candidate: TerminalCandidate,
  anchor: TerminalCandidate,
): TerminalLineMember {
  const endMs = candidate.entry.endMs as number;
  const boundaryMs = anchor.entry.endMs as number;
  return Object.freeze({
    lineId: candidate.line.id,
    documentIndex: candidate.entry.documentIndex,
    sourceIndex: candidate.line.sourceIndex,
    sectionIndex: candidate.line.sectionIndex,
    beginMs: candidate.entry.beginMs,
    endMs,
    sourceEndMs: candidate.entry.sourceEndMs,
    endDistanceMs: finiteDelta(boundaryMs, endMs),
    role: candidate.line.id === anchor.line.id ? "anchor" : "member",
  });
}

/**
 * Derives the final text boundary independently from loop/reset state. For a
 * line-timed tail, overlapping rows in the same section share the boundary when
 * their own end remains inside the deactivation envelope.
 */
export function createTerminalLinePolicy(
  document: LyricDocument,
  options: TerminalLinePolicyOptions = {},
): TerminalLinePolicy {
  const cohortWindowMs = nonNegativeFinite(
    options.cohortWindowMs,
    DEFAULT_COHORT_WINDOW_MS,
  );
  const exitDurationMs = nonNegativeFinite(
    options.exitDurationMs,
    DEFAULT_EXIT_DURATION_MS,
  );
  const timeIndex = createLyricTimeIndex(document);
  const candidates: TerminalCandidate[] = timeIndex.entries
    .filter(isTimedTextCandidate)
    .map((entry) => ({ line: entry.line, entry }));
  const anchor = candidates.reduce<TerminalCandidate | null>(
    (latest, candidate) =>
      latest === null || compareTerminalCandidate(candidate, latest) > 0
        ? candidate
        : latest,
    null,
  );

  if (anchor === null || anchor.entry.endMs === null) {
    return Object.freeze({
      documentId: document.id,
      cohortWindowMs,
      exitDurationMs,
      cohort: null,
    });
  }

  const boundaryMs = anchor.entry.endMs;
  const memberCandidates = candidates.filter((candidate) => {
    if (candidate.line.id === anchor.line.id) return true;
    if (
      anchor.line.type !== "line-timed" ||
      candidate.line.type !== "line-timed"
    ) {
      return false;
    }
    if (candidate.line.sectionIndex !== anchor.line.sectionIndex) return false;
    if (!intervalsOverlap(candidate.entry, anchor.entry)) return false;
    const candidateEndMs = candidate.entry.endMs as number;
    if (candidateEndMs > boundaryMs) return false;
    return finiteDelta(boundaryMs, candidateEndMs) <= cohortWindowMs;
  });
  const memberIds = new Set(memberCandidates.map(({ line }) => line.id));
  const memberCandidateById = new Map<string, TerminalCandidate>();
  for (const candidate of memberCandidates) {
    if (!memberCandidateById.has(candidate.line.id)) {
      memberCandidateById.set(candidate.line.id, candidate);
    }
  }
  const orderedCandidates = document.lines
    .map((line) => memberCandidateById.get(line.id))
    .filter(
      (candidate): candidate is TerminalCandidate => candidate !== undefined,
    )
    .filter((candidate, index, all) =>
      all.findIndex(({ line }) => line.id === candidate.line.id) === index,
    );
  const members = Object.freeze(
    orderedCandidates.map((candidate) => freezeMember(candidate, anchor)),
  );
  const lineIds = Object.freeze(members.map(({ lineId }) => lineId));
  const settledAtMs = finiteSum(boundaryMs, exitDurationMs);
  const cohort: TerminalLineCohort = Object.freeze({
    id: createStableId(
      "terminal-line-cohort",
      document.id,
      boundaryMs,
      cohortWindowMs,
      exitDurationMs,
      ...lineIds,
    ),
    documentId: document.id,
    anchorLineId: anchor.line.id,
    boundaryMs,
    boundarySource: boundarySource(anchor.entry),
    exitDurationMs,
    settledAtMs,
    coordinated: memberIds.size > 1,
    members,
    lineIds,
  });

  return Object.freeze({
    documentId: document.id,
    cohortWindowMs,
    exitDurationMs,
    cohort,
  });
}

function freezeIds(ids: string[]): readonly string[] {
  return Object.freeze(ids);
}

/** Produces a stateless terminal snapshot for bind, seek, playback, or loop. */
export function resolveTerminalPlaybackState(
  policy: TerminalLinePolicy,
  requestedPositionMs: number,
): TerminalPlaybackState {
  const positionValid = Number.isFinite(requestedPositionMs);
  const positionMs = positionValid ? requestedPositionMs : 0;
  const cohort = policy.cohort;
  if (cohort === null || !positionValid) {
    return Object.freeze({
      documentId: policy.documentId,
      cohortId: null,
      positionMs,
      positionValid,
      phase: "unavailable",
      members: Object.freeze([]),
      activeLineIds: Object.freeze([]),
      heldLineIds: Object.freeze([]),
      exitingLineIds: Object.freeze([]),
      settledLineIds: Object.freeze([]),
    });
  }

  const activeLineIds: string[] = [];
  const heldLineIds: string[] = [];
  const exitingLineIds: string[] = [];
  const settledLineIds: string[] = [];
  const members = Object.freeze(
    cohort.members.map((member): TerminalMemberState => {
      let phase: TerminalMemberPhase;
      let elapsedMs = 0;
      if (positionMs < member.beginMs) {
        phase = "before";
      } else if (positionMs < member.endMs) {
        phase = "active";
        elapsedMs = finiteDelta(positionMs, member.beginMs);
        activeLineIds.push(member.lineId);
      } else if (positionMs < cohort.boundaryMs) {
        phase = "held";
        elapsedMs = finiteDelta(positionMs, member.endMs);
        heldLineIds.push(member.lineId);
      } else if (positionMs < cohort.settledAtMs) {
        phase = "exiting";
        elapsedMs = finiteDelta(positionMs, cohort.boundaryMs);
        exitingLineIds.push(member.lineId);
      } else {
        phase = "settled";
        elapsedMs = finiteDelta(positionMs, cohort.settledAtMs);
        settledLineIds.push(member.lineId);
      }
      return Object.freeze({ lineId: member.lineId, phase, elapsedMs });
    }),
  );

  let firstBeginMs = Number.MAX_VALUE;
  for (const member of cohort.members) {
    firstBeginMs = Math.min(firstBeginMs, member.beginMs);
  }
  const phase: TerminalPlaybackPhase =
    positionMs < firstBeginMs
      ? "before"
      : positionMs < cohort.boundaryMs
        ? "active"
        : positionMs < cohort.settledAtMs
          ? "exiting"
          : "settled";

  return Object.freeze({
    documentId: policy.documentId,
    cohortId: cohort.id,
    positionMs,
    positionValid,
    phase,
    members,
    activeLineIds: freezeIds(activeLineIds),
    heldLineIds: freezeIds(heldLineIds),
    exitingLineIds: freezeIds(exitingLineIds),
    settledLineIds: freezeIds(settledLineIds),
  });
}

export const DEFAULT_TERMINAL_COHORT_WINDOW_MS = DEFAULT_COHORT_WINDOW_MS;
export const DEFAULT_TERMINAL_EXIT_DURATION_MS = DEFAULT_EXIT_DURATION_MS;
