import type { LyricTrackRole } from "./ids.js";
import type {
  LyricDocument,
  LyricLineType,
  LyricTrack,
  LyricTracks,
  LyricWord,
} from "./types.js";

export interface LyricTrackCapabilities {
  readonly presentLineCount: number;
  readonly wordCount: number;
  readonly timedWordCount: number;
  readonly unknownWordTimingCount: number;
  readonly joinGroupCount: number;
}

export interface LyricDocumentCapabilities {
  readonly lineCount: number;
  readonly textLineCount: number;
  readonly lineTypeCounts: Readonly<Record<LyricLineType, number>>;
  readonly timedLineCount: number;
  readonly fullyBoundedLineCount: number;
  readonly openEndedLineCount: number;
  readonly untimedLineCount: number;
  readonly trackCapabilities: Readonly<
    Record<LyricTrackRole, LyricTrackCapabilities>
  >;
  readonly hasKaraoke: boolean;
  readonly hasLineTiming: boolean;
  readonly hasUnknownTiming: boolean;
  readonly hasTranslation: boolean;
  readonly hasBackgroundTranslation: boolean;
  readonly hasPronunciation: boolean;
  readonly hasBackground: boolean;
  readonly hasBackgroundPronunciation: boolean;
  readonly hasInstrumental: boolean;
  readonly joinGroupCount: number;
  readonly hasJoinGroups: boolean;
  readonly hasMultipleAgents: boolean;
  readonly hasSynchronizedLines: boolean;
  readonly hasNonMonotonicLineOrder: boolean;
  readonly languageTags: readonly string[];
}

interface MutableTrackCapabilities {
  presentLineCount: number;
  wordCount: number;
  timedWordCount: number;
  unknownWordTimingCount: number;
  readonly joinGroupIds: Set<string>;
}

function createMutableTrackCapabilities(): MutableTrackCapabilities {
  return {
    presentLineCount: 0,
    wordCount: 0,
    timedWordCount: 0,
    unknownWordTimingCount: 0,
    joinGroupIds: new Set<string>(),
  };
}

function hasCompleteWordTiming(word: LyricWord): boolean {
  const beginMs = word.begin.valueMs;
  const endMs = word.end.valueMs;
  return (
    beginMs !== null &&
    endMs !== null &&
    Number.isFinite(beginMs) &&
    Number.isFinite(endMs) &&
    endMs >= beginMs
  );
}

function inspectTrack(
  track: LyricTrack,
  capabilities: MutableTrackCapabilities,
): void {
  capabilities.presentLineCount += 1;
  capabilities.wordCount += track.words.length;
  for (const word of track.words) {
    if (word.joinGroup) capabilities.joinGroupIds.add(word.joinGroup.id);
    if (hasCompleteWordTiming(word)) {
      capabilities.timedWordCount += 1;
    } else {
      capabilities.unknownWordTimingCount += 1;
    }
  }
}

function freezeTrackCapabilities(
  capabilities: MutableTrackCapabilities,
): LyricTrackCapabilities {
  return Object.freeze({
    presentLineCount: capabilities.presentLineCount,
    wordCount: capabilities.wordCount,
    timedWordCount: capabilities.timedWordCount,
    unknownWordTimingCount: capabilities.unknownWordTimingCount,
    joinGroupCount: capabilities.joinGroupIds.size,
  });
}

function addTrackLanguages(
  languages: Set<string>,
  tracks: LyricTracks,
): void {
  languages.add(tracks.foreground.language.effective);
  if (tracks.foregroundPronunciation) {
    languages.add(tracks.foregroundPronunciation.language.effective);
  }
  if (tracks.background) languages.add(tracks.background.language.effective);
  if (tracks.backgroundPronunciation) {
    languages.add(tracks.backgroundPronunciation.language.effective);
  }
}

/** Derives immutable feature flags without normalizing or mutating the document. */
export function deriveLyricDocumentCapabilities(
  document: LyricDocument,
): LyricDocumentCapabilities {
  const lineTypeCounts: Record<LyricLineType, number> = {
    karaoke: 0,
    "line-timed": 0,
    static: 0,
    credit: 0,
    instrumental: 0,
  };
  const tracks: Record<LyricTrackRole, MutableTrackCapabilities> = {
    foreground: createMutableTrackCapabilities(),
    foregroundPronunciation: createMutableTrackCapabilities(),
    background: createMutableTrackCapabilities(),
    backgroundPronunciation: createMutableTrackCapabilities(),
  };
  const languages = new Set<string>([document.language.effective]);
  const usedAgents = new Set<string>();
  const timedIntervals: Array<{
    readonly beginMs: number;
    readonly endMs: number | null;
  }> = [];
  let textLineCount = 0;
  let timedLineCount = 0;
  let fullyBoundedLineCount = 0;
  let openEndedLineCount = 0;
  let untimedLineCount = 0;
  let hasTranslation = false;
  let hasBackgroundTranslation = false;
  let hasTimedKaraokeWord = false;

  for (const line of document.lines) {
    lineTypeCounts[line.type] += 1;

    const rawBeginMs = line.begin.valueMs;
    const rawEndMs = line.end.valueMs;
    const beginMs =
      rawBeginMs !== null && Number.isFinite(rawBeginMs) ? rawBeginMs : null;
    const endMs =
      rawEndMs !== null && Number.isFinite(rawEndMs) ? rawEndMs : null;
    if (beginMs === null) {
      untimedLineCount += 1;
    } else {
      timedLineCount += 1;
      if (endMs === null) openEndedLineCount += 1;
      else fullyBoundedLineCount += 1;
    }

    if (line.tracks === null) continue;
    textLineCount += 1;
    usedAgents.add(line.agentId);
    if (beginMs !== null) {
      timedIntervals.push({ beginMs, endMs });
    }
    inspectTrack(line.tracks.foreground, tracks.foreground);
    if (line.tracks.foregroundPronunciation) {
      inspectTrack(
        line.tracks.foregroundPronunciation,
        tracks.foregroundPronunciation,
      );
    }
    if (line.tracks.background) {
      inspectTrack(line.tracks.background, tracks.background);
    }
    if (line.tracks.backgroundPronunciation) {
      inspectTrack(
        line.tracks.backgroundPronunciation,
        tracks.backgroundPronunciation,
      );
    }
    if (
      line.type === "karaoke" &&
      [
        line.tracks.foreground,
        line.tracks.foregroundPronunciation,
        line.tracks.background,
        line.tracks.backgroundPronunciation,
      ].some((track) =>
        track?.words.some(hasCompleteWordTiming),
      )
    ) {
      hasTimedKaraokeWord = true;
    }
    addTrackLanguages(languages, line.tracks);
    if (line.translation) {
      hasTranslation = true;
      languages.add(line.translation.language.effective);
    }
    if (line.backgroundTranslation) {
      hasBackgroundTranslation = true;
      languages.add(line.backgroundTranslation.language.effective);
    }
  }

  const trackCapabilities = Object.freeze({
    foreground: freezeTrackCapabilities(tracks.foreground),
    foregroundPronunciation: freezeTrackCapabilities(
      tracks.foregroundPronunciation,
    ),
    background: freezeTrackCapabilities(tracks.background),
    backgroundPronunciation: freezeTrackCapabilities(
      tracks.backgroundPronunciation,
    ),
  });
  const orderedIntervals = timedIntervals.sort(
    (left, right) => left.beginMs - right.beginMs,
  );
  let latestEndMs = Number.NEGATIVE_INFINITY;
  let hasSynchronizedLines = false;
  for (const interval of orderedIntervals) {
    if (interval.beginMs < latestEndMs) hasSynchronizedLines = true;
    latestEndMs = Math.max(
      latestEndMs,
      interval.endMs ?? Number.POSITIVE_INFINITY,
    );
  }
  const joinGroupCount = Object.values(trackCapabilities).reduce(
    (count, track) => count + track.joinGroupCount,
    0,
  );

  return Object.freeze({
    lineCount: document.lines.length,
    textLineCount,
    lineTypeCounts: Object.freeze({ ...lineTypeCounts }),
    timedLineCount,
    fullyBoundedLineCount,
    openEndedLineCount,
    untimedLineCount,
    trackCapabilities,
    hasKaraoke: hasTimedKaraokeWord,
    hasLineTiming: timedLineCount > 0,
    hasUnknownTiming:
      untimedLineCount > 0 ||
      openEndedLineCount > 0 ||
      Object.values(trackCapabilities).some(
        (track) => track.unknownWordTimingCount > 0,
      ),
    hasTranslation,
    hasBackgroundTranslation,
    hasPronunciation: trackCapabilities.foregroundPronunciation.presentLineCount > 0,
    hasBackground: trackCapabilities.background.presentLineCount > 0,
    hasBackgroundPronunciation:
      trackCapabilities.backgroundPronunciation.presentLineCount > 0,
    hasInstrumental: lineTypeCounts.instrumental > 0,
    joinGroupCount,
    hasJoinGroups: joinGroupCount > 0,
    hasMultipleAgents: usedAgents.size > 1,
    hasSynchronizedLines,
    hasNonMonotonicLineOrder:
      !document.source.lineBeginOrderMonotonic ||
      document.source.nonMonotonicLineOrderSamples.length > 0,
    languageTags: Object.freeze([...languages].sort()),
  });
}
