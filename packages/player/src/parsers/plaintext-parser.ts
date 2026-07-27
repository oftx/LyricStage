import type { LyricDocument, TextLyricLine } from "../domain/types.js";
import { inferLyricLanguage } from "../domain/language.js";
import {
  createDefaultAgentId,
  createDocumentId,
  createLineId,
  describeSourceOrder,
  parseFailure,
  readMediaDuration,
  resolveLanguage,
} from "./internal.js";
import { knownTimestamp, unknownTimestamp } from "./time.js";
import type {
  LyricsParseInput,
  LyricsParseResult,
  LyricsParser,
  ParseDiagnostic,
} from "./types.js";

function parsePlaintextInternal(input: LyricsParseInput): LyricsParseResult {
  if (typeof input.text !== "string") {
    return parseFailure(
      "plaintext",
      "probable",
      "plaintext.invalid-input",
      "Plaintext input must be a string.",
    );
  }

  const diagnostics: ParseDiagnostic[] = [];
  const mediaDurationMs = readMediaDuration(input, diagnostics);
  const sourceLines = input.text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  const documentId = createDocumentId("plaintext", input);
  const agentId = createDefaultAgentId(documentId);
  const language = resolveLanguage(input);
  const lines: TextLyricLine[] = [];
  let sectionIndex = 0;
  let blankLineCount = 0;

  for (let sourceIndex = 0; sourceIndex < sourceLines.length; sourceIndex += 1) {
    const raw = sourceLines[sourceIndex];
    if (raw === undefined) continue;
    const isBlank = raw.trim().length === 0;

    // Leading blanks are ignored; each mid-document blank becomes a full-height
    // empty row so poem spacing matches a text line (not a collapsed margin).
    if (isBlank) {
      if (lines.length === 0) continue;
      blankLineCount += 1;
      sectionIndex += 1;
      const index = lines.length;
      lines.push({
        id: createLineId(documentId, sourceIndex, 0),
        index,
        sourceIndex,
        sectionIndex,
        begin: unknownTimestamp(),
        end: unknownTimestamp(),
        agentId,
        type: "static",
        tracks: {
          foreground: {
            text: "",
            language,
            words: [],
          },
        },
      });
      continue;
    }

    const text = raw;
    const index = lines.length;
    const lineLanguage = inferLyricLanguage(
      text,
      language.declared,
      language.effective,
    );
    lines.push({
      id: createLineId(documentId, sourceIndex, 0),
      index,
      sourceIndex,
      sectionIndex,
      begin: unknownTimestamp(),
      end: unknownTimestamp(),
      agentId,
      type: "static",
      tracks: {
        foreground: {
          text,
          language: lineLanguage,
          words: [],
        },
      },
    });
  }

  if (lines.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "plaintext.empty",
      message: "Plaintext input contains no lyric lines.",
    });
    return parseFailure(
      "plaintext",
      "probable",
      "plaintext.empty",
      "Plaintext input contains no lyric lines.",
      diagnostics,
    );
  }

  if (blankLineCount > 0) {
    diagnostics.push({
      severity: "info",
      code: "plaintext.blank-lines-preserved",
      message: "Blank lines were preserved as full-height empty poem rows.",
    });
  }

  const document: LyricDocument = {
    id: documentId,
    duration:
      mediaDurationMs === null
        ? unknownTimestamp()
        : knownTimestamp(mediaDurationMs, "media-duration-inferred"),
    language,
    agents: [{ id: agentId, type: "person", alignment: "auto" }],
    lines,
    source: describeSourceOrder("plaintext", input, lines),
  };

  return {
    ok: true,
    format: "plaintext",
    confidence: "probable",
    document,
    diagnostics,
  };
}

export function parsePlaintext(input: LyricsParseInput): LyricsParseResult {
  try {
    return parsePlaintextInternal(input);
  } catch {
    return parseFailure(
      "plaintext",
      "probable",
      "plaintext.internal-error",
      "Plaintext parsing failed unexpectedly.",
    );
  }
}

export const plaintextParser: LyricsParser = {
  id: "plaintext",
  parse: parsePlaintext,
};
