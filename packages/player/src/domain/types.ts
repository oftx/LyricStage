export type LyricFormat =
  | "ttml"
  | "lrc"
  | "eslrc"
  | "yrc"
  | "qrc"
  | "lys"
  | "plaintext";

export type KnownLyricTimestampSource =
  | "source"
  | "next-line-inferred"
  | "document-duration-inferred"
  | "media-duration-inferred"
  | "derived"
  | "fallback";

export type LyricTimestamp =
  | {
      readonly valueMs: number;
      readonly source: KnownLyricTimestampSource;
    }
  | {
      readonly valueMs: null;
      readonly source: "unknown";
    };

export type LyricLineType =
  | "karaoke"
  | "line-timed"
  | "static"
  | "credit"
  | "instrumental";

export interface LyricLanguage {
  readonly declared: string | null;
  readonly inferred: string | null;
  readonly effective: string;
}

export interface LyricAgent {
  readonly id: string;
  readonly type: "person" | "group" | "other";
  /** TTML usually omits visual side; layout policy resolves auto later. */
  readonly alignment: "start" | "end" | "auto";
}

export interface LyricWordJoinGroup {
  readonly id: string;
  readonly index: number;
  readonly count: number;
}

export interface LyricWord {
  readonly id: string;
  readonly text: string;
  readonly begin: LyricTimestamp;
  readonly end: LyricTimestamp;
  readonly spaceBefore: boolean;
  readonly joinGroup?: LyricWordJoinGroup;
}

export interface LyricTrack {
  readonly text: string;
  readonly language: LyricLanguage;
  readonly words: readonly LyricWord[];
}

export interface LyricTracks {
  readonly foreground: LyricTrack;
  readonly foregroundPronunciation?: LyricTrack;
  readonly background?: LyricTrack;
  readonly backgroundPronunciation?: LyricTrack;
}

export interface LyricText {
  readonly text: string;
  readonly language: LyricLanguage;
}

interface LyricLineBase {
  readonly id: string;
  /** Canonical source/native-vector order. Never sort the document lines array. */
  readonly index: number;
  /** Null for rows derived by the player, such as instrumental gaps. */
  readonly sourceIndex: number | null;
  /** Preserves the source section used by grouped-tail and cohort policies. */
  readonly sectionIndex: number | null;
  /** Parsing facts and later inference remain distinguishable. */
  readonly begin: LyricTimestamp;
  readonly end: LyricTimestamp;
  readonly agentId: string;
}

export interface TextLyricLine extends LyricLineBase {
  readonly type: Exclude<LyricLineType, "instrumental">;
  readonly tracks: LyricTracks;
  readonly translation?: LyricText;
  readonly backgroundTranslation?: LyricText;
}

export interface InstrumentalLyricLine extends LyricLineBase {
  readonly type: "instrumental";
  readonly sourceIndex: null;
  readonly tracks: null;
}

export type LyricLine = TextLyricLine | InstrumentalLyricLine;

export interface NonMonotonicLineOrderSample {
  readonly previousLineId: string;
  readonly previousIndex: number;
  readonly previousBeginMs: number;
  readonly currentLineId: string;
  readonly currentIndex: number;
  readonly currentBeginMs: number;
}

export interface LyricDocumentSource {
  readonly format: LyricFormat;
  readonly name?: string;
  readonly adapterOrderPolicy: "preserve-source-vector";
  readonly lineBeginOrderMonotonic: boolean;
  readonly nonMonotonicLineOrderSamples: readonly NonMonotonicLineOrderSample[];
}

export interface LyricDocument {
  readonly id: string;
  readonly duration: LyricTimestamp;
  readonly language: LyricLanguage;
  readonly agents: readonly LyricAgent[];
  readonly lines: readonly LyricLine[];
  readonly source: LyricDocumentSource;
}
