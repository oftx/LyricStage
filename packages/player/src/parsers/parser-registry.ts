import type { LyricFormat } from "../domain/types.js";
import { parseFailure } from "./internal.js";
import { eslrcParser, looksLikeEslrc } from "./eslrc-parser.js";
import { looksLikeLrc, lrcParser } from "./lrc-parser.js";
import { looksLikeLys, lysParser } from "./lys-parser.js";
import { plaintextParser } from "./plaintext-parser.js";
import { looksLikeQrc, qrcParser } from "./qrc-parser.js";
import { ttmlParser } from "./ttml/ttml-parser.js";
import { looksLikeYrc, yrcParser } from "./yrc-parser.js";
import type {
  LyricsParseInput,
  LyricsParseResult,
  LyricsParser,
} from "./types.js";

export interface LyricsParserRegistration {
  readonly format: LyricFormat;
  readonly parser: LyricsParser;
}

function looksLikeTtml(text: string): boolean {
  const beginning = text.replace(/^\uFEFF/, "").slice(0, 4_096);
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[A-Za-z_][\w.-]*:)?tt(?:\s|>)/i.test(
    beginning,
  );
}

function formatFromSourceName(sourceName: string | undefined): LyricFormat | null {
  if (!sourceName) return null;
  const pathname = sourceName.split(/[?#]/u, 1)[0]?.toLowerCase() ?? "";
  if (pathname.endsWith(".ttml")) return "ttml";
  if (pathname.endsWith(".eslrc")) return "eslrc";
  if (pathname.endsWith(".yrc")) return "yrc";
  if (pathname.endsWith(".qrc")) return "qrc";
  if (pathname.endsWith(".lys")) return "lys";
  if (pathname.endsWith(".lrc")) return "lrc";
  if (pathname.endsWith(".txt")) return "plaintext";
  return null;
}

function detectFormat(input: LyricsParseInput): LyricFormat {
  const { text } = input;
  if (looksLikeTtml(text)) return "ttml";
  if (looksLikeYrc(text)) return "yrc";
  if (looksLikeQrc(text)) return "qrc";
  if (looksLikeLys(text)) return "lys";
  if (looksLikeEslrc(text)) return "eslrc";
  if (looksLikeLrc(text)) return "lrc";
  return formatFromSourceName(input.sourceName) ?? "plaintext";
}

function isLyricFormat(value: unknown): value is LyricFormat {
  return (
    value === "ttml" ||
    value === "lrc" ||
    value === "eslrc" ||
    value === "yrc" ||
    value === "qrc" ||
    value === "lys" ||
    value === "plaintext"
  );
}

export class LyricsParserRegistry {
  readonly #parsers: ReadonlyMap<LyricFormat, LyricsParser>;

  constructor(registrations: readonly LyricsParserRegistration[] = []) {
    const parsers = new Map<LyricFormat, LyricsParser>();
    for (const registration of registrations) {
      parsers.set(registration.format, registration.parser);
    }
    this.#parsers = parsers;
  }

  withParser(
    format: LyricFormat,
    parser: LyricsParser,
  ): LyricsParserRegistry {
    return new LyricsParserRegistry([
      ...Array.from(this.#parsers, ([registeredFormat, registeredParser]) => ({
        format: registeredFormat,
        parser: registeredParser,
      })),
      { format, parser },
    ]);
  }

  parse(input: LyricsParseInput): LyricsParseResult {
    try {
      if (
        typeof input !== "object" ||
        input === null ||
        typeof input.text !== "string"
      ) {
        return parseFailure(
          "unknown",
          "unknown",
          "parser.invalid-input",
          "Lyrics parse input must contain a string text field.",
        );
      }

      const hint = input.formatHint;
      if (hint !== undefined && !isLyricFormat(hint)) {
        return parseFailure(
          "unknown",
          "unknown",
          "parser.invalid-format-hint",
          "Lyrics formatHint is not supported.",
        );
      }
      if (
        input.sourceName !== undefined &&
        typeof input.sourceName !== "string"
      ) {
        return parseFailure(
          "unknown",
          "unknown",
          "parser.invalid-source-name",
          "Lyrics sourceName must be a string when provided.",
        );
      }

      const format = hint ?? detectFormat(input);
      const parser = this.#parsers.get(format);
      if (!parser) {
        return parseFailure(
          format,
          "probable",
          "parser.format-unavailable",
          `No ${format} parser is registered.`,
        );
      }

      try {
        return parser.parse(input);
      } catch {
        return parseFailure(
          format,
          "probable",
          "parser.unexpected-error",
          `The registered ${format} parser failed unexpectedly.`,
        );
      }
    } catch {
      return parseFailure(
        "unknown",
        "unknown",
        "parser.unexpected-error",
        "Lyrics format detection failed unexpectedly.",
      );
    }
  }
}

export function createParserRegistry(
  registrations: readonly LyricsParserRegistration[] = [],
): LyricsParserRegistry {
  return new LyricsParserRegistry(registrations);
}

export const defaultParserRegistry = createParserRegistry([
  { format: "ttml", parser: ttmlParser },
  { format: "lrc", parser: lrcParser },
  { format: "eslrc", parser: eslrcParser },
  { format: "yrc", parser: yrcParser },
  { format: "qrc", parser: qrcParser },
  { format: "lys", parser: lysParser },
  { format: "plaintext", parser: plaintextParser },
]);

export function parseLyrics(
  input: LyricsParseInput,
  registry: LyricsParserRegistry = defaultParserRegistry,
): LyricsParseResult {
  return registry.parse(input);
}
