import type { LyricDocument, LyricFormat } from "../domain/types.js";

export interface LyricsParseInput {
  readonly text: string;
  readonly sourceName?: string;
  readonly formatHint?: LyricFormat;
  readonly preferredLanguages?: readonly string[];
  /** Optional host fact used to resolve otherwise open-ended final lines. */
  readonly mediaDurationMs?: number;
}

export interface ParseDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly lineId?: string;
  readonly sourceIndex?: number;
}

export interface LyricsParseError {
  readonly code: string;
  readonly message: string;
}

export type LyricsParseResult =
  | {
      readonly ok: true;
      readonly format: LyricFormat;
      readonly confidence: "exact" | "probable";
      readonly document: LyricDocument;
      readonly diagnostics: readonly ParseDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly format: LyricFormat | "unknown";
      readonly confidence: "probable" | "unknown";
      readonly error: LyricsParseError;
      readonly diagnostics: readonly ParseDiagnostic[];
    };

export interface LyricsParser {
  readonly id: string;
  parse(input: LyricsParseInput): LyricsParseResult;
}
