import type {
  LyricDocumentSource,
  LyricFormat,
  LyricLanguage,
  LyricLine,
  NonMonotonicLineOrderSample,
} from "../domain/types.js";
import {
  createAgentId,
  createDocumentId as createCanonicalDocumentId,
  createLineId as createCanonicalLineId,
} from "../domain/ids.js";
import {
  inferLyricLanguage,
  normalizeLanguageTag,
} from "../domain/language.js";
import type {
  LyricsParseInput,
  LyricsParseResult,
  ParseDiagnostic,
} from "./types.js";

export function parseFailure(
  format: LyricFormat | "unknown",
  confidence: "probable" | "unknown",
  code: string,
  message: string,
  diagnostics: readonly ParseDiagnostic[] = [],
): LyricsParseResult {
  return {
    ok: false,
    format,
    confidence,
    error: { code, message },
    diagnostics:
      diagnostics.length > 0
        ? diagnostics
        : [{ severity: "error", code, message }],
  };
}

export function resolveLanguage(
  input: LyricsParseInput,
  declared: string | null = null,
): LyricLanguage {
  let preferred: string | null = null;
  for (const candidate of input.preferredLanguages ?? []) {
    preferred = normalizeLanguageTag(candidate);
    if (preferred !== null) break;
  }
  return inferLyricLanguage(input.text, declared, preferred);
}

export function createDocumentId(
  format: LyricFormat,
  input: LyricsParseInput,
): string {
  return createCanonicalDocumentId(format, input.sourceName, input.text);
}

export function createDefaultAgentId(documentId: string): string {
  return createAgentId(documentId);
}

export function createLineId(
  documentId: string,
  sourceIndex: number,
  occurrence: number,
): string {
  return createCanonicalLineId(documentId, sourceIndex, occurrence);
}

export function describeSourceOrder(
  format: LyricFormat,
  input: LyricsParseInput,
  lines: readonly LyricLine[],
): LyricDocumentSource {
  const samples: NonMonotonicLineOrderSample[] = [];
  let previous: LyricLine | null = null;

  for (const line of lines) {
    if (line.begin.valueMs === null) continue;
    if (
      previous !== null &&
      previous.begin.valueMs !== null &&
      previous.begin.valueMs > line.begin.valueMs
    ) {
      samples.push({
        previousLineId: previous.id,
        previousIndex: previous.index,
        previousBeginMs: previous.begin.valueMs,
        currentLineId: line.id,
        currentIndex: line.index,
        currentBeginMs: line.begin.valueMs,
      });
    }
    previous = line;
  }

  const name = input.sourceName;
  return {
    format,
    ...(name === undefined ? {} : { name }),
    adapterOrderPolicy: "preserve-source-vector",
    lineBeginOrderMonotonic: samples.length === 0,
    nonMonotonicLineOrderSamples: samples,
  };
}

export function readMediaDuration(
  input: LyricsParseInput,
  diagnostics: ParseDiagnostic[],
): number | null {
  if (input.mediaDurationMs === undefined) return null;
  if (
    typeof input.mediaDurationMs === "number" &&
    Number.isFinite(input.mediaDurationMs) &&
    input.mediaDurationMs >= 0
  ) {
    return input.mediaDurationMs;
  }

  diagnostics.push({
    severity: "warning",
    code: "time.invalid-media-duration",
    message: "mediaDurationMs must be a finite non-negative number.",
  });
  return null;
}
