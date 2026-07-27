import type { LyricFormat } from "./types.js";

export type LyricTrackRole =
  | "foreground"
  | "foregroundPronunciation"
  | "background"
  | "backgroundPronunciation";

export type StableIdPart = string | number | boolean | null | undefined;

function serializeIdPart(part: StableIdPart): string {
  if (part === null) return "null";
  if (part === undefined) return "undefined";
  return `${typeof part}:${String(part)}`;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function normalizeNamespace(namespace: string): string {
  const normalized = namespace
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "id";
}

/** Creates a deterministic compact ID without retaining source lyric text. */
export function createStableId(
  namespace: string,
  ...parts: readonly StableIdPart[]
): string {
  const serialized = parts
    .map((part) => {
      const value = serializeIdPart(part);
      return `${value.length}:${value}`;
    })
    .join("|");
  return `${normalizeNamespace(namespace)}-${fnv1a32(serialized)}`;
}

export function createDocumentId(
  format: LyricFormat,
  sourceName: string | null | undefined,
  sourceText: string,
): string {
  return createStableId("document", format, sourceName ?? null, sourceText);
}

export function createAgentId(
  documentId: string,
  sourceAgentId: string = "default",
): string {
  return createStableId("agent", documentId, sourceAgentId);
}

export function createLineId(
  documentId: string,
  sourceIndex: number,
  occurrence: number = 0,
): string {
  return createStableId("line", documentId, sourceIndex, occurrence);
}

export function createWordId(
  lineId: string,
  trackRole: LyricTrackRole,
  wordIndex: number,
): string {
  return createStableId("word", lineId, trackRole, wordIndex);
}

export function createJoinGroupId(
  lineId: string,
  trackRole: LyricTrackRole,
  groupIndex: number,
): string {
  return createStableId("join-group", lineId, trackRole, groupIndex);
}

export function createDerivedLineId(
  documentId: string,
  kind: string,
  previousLineId: string | null,
  nextLineId: string | null,
): string {
  return createStableId(
    "derived-line",
    documentId,
    kind,
    previousLineId,
    nextLineId,
  );
}
