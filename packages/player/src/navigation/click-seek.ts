import type { LyricDocument, LyricLine } from "../domain/types.js";
import type { PlaybackSnapshot } from "../playback/types.js";

export interface PlaybackCommands {
  seekTo(positionMs: number): void;
  play?(): void;
}

export interface ClickSeekRequest {
  readonly lineId: string;
  readonly positionMs: number;
  readonly resumePlayback: boolean;
  readonly evidence: "source-confirmed-seek-to-line-begin";
}

export interface ClickSeekExecution {
  readonly request: ClickSeekRequest;
  readonly resumed: boolean;
}

export function isClickSeekEligible(line: LyricLine): boolean {
  if (line.type === "instrumental" || line.type === "credit") return false;
  const positionMs = line.begin.valueMs;
  return positionMs !== null && Number.isFinite(positionMs) && positionMs >= 0;
}

export function createClickSeekRequest(
  document: LyricDocument,
  lineId: string,
  snapshot: PlaybackSnapshot | null,
): ClickSeekRequest | null {
  const line = document.lines.find((candidate) => candidate.id === lineId);
  if (!line || !isClickSeekEligible(line)) return null;
  const positionMs = line.begin.valueMs;
  if (positionMs === null) return null;
  return Object.freeze({
    lineId,
    positionMs,
    resumePlayback: snapshot?.playing !== true,
    evidence: "source-confirmed-seek-to-line-begin",
  });
}

export function executeClickSeek(
  request: ClickSeekRequest,
  commands: PlaybackCommands,
): ClickSeekExecution {
  commands.seekTo(request.positionMs);
  const resumed = request.resumePlayback && typeof commands.play === "function";
  if (resumed) commands.play?.();
  return Object.freeze({ request, resumed });
}
