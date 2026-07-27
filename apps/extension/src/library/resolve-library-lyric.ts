/**
 * Library resolution policy for platforms without a lyric source (video
 * sites): explicit per-media preference first (ignores included), then
 * title matching gated at the shared recommendation threshold. Extracted
 * from the content runtime so the composition policy is unit-testable —
 * same pattern as lyric-refresh.ts.
 */
import type { PortableLyricText } from '@lyric-stage/platform-adapters';
import type {
  ExtensionLyricLibrary,
  LyricLibraryRecordV1,
} from './extension-lyric-library.js';
import { matchLyrics, RECOMMENDATION_THRESHOLD } from './lyric-matcher.js';

export interface ResolveLibraryLyricDeps {
  readonly library: ExtensionLyricLibrary;
  /** Page-derived title/creators for the current media. */
  readonly readTitleInfo: () => {
    readonly title: string | null;
    readonly creators: readonly string[];
  };
  /** Current playback duration when known; 0 disables the duration bonus. */
  readonly getDurationMs: () => number;
}

export interface ResolvedLibraryLyric {
  readonly lyric: PortableLyricText;
  readonly libraryId: string;
}

function toPortable(record: LyricLibraryRecordV1): PortableLyricText {
  return {
    format: record.format,
    text: record.text,
    sourceName: `library:${record.title}`,
    ...(record.translationText ? { translationText: record.translationText } : {}),
    ...(record.pronunciationText ? { pronunciationText: record.pronunciationText } : {}),
  };
}

export async function resolveLibraryLyric(
  deps: ResolveLibraryLyricDeps,
  mediaId: string,
): Promise<ResolvedLibraryLyric | null> {
  const preference = await deps.library.getPreference(mediaId);
  if (preference?.ignored) return null;
  let record: LyricLibraryRecordV1 | null = null;
  if (preference?.lyricId) {
    record = await deps.library.getRecord(preference.lyricId);
  }
  if (!record) {
    // Explicit preferences above always apply; auto-matching honors the
    // global switch.
    if (!(await deps.library.isAutoMatchEnabled())) return null;
    const info = deps.readTitleInfo();
    if (!info.title) return null;
    const index = await deps.library.list();
    if (index.length === 0) return null;
    const match = matchLyrics(
      {
        title: info.title,
        creators: info.creators,
        durationMs: deps.getDurationMs(),
      },
      index,
    );
    // Gate auto-apply at the shared threshold: without a picker confirmation
    // step, an unranked best would apply arbitrary low-score entries.
    if (!match.best || match.best.score < RECOMMENDATION_THRESHOLD) return null;
    record = await deps.library.getRecord(match.best.lyricId);
  }
  if (!record) return null;
  return { libraryId: record.id, lyric: toPortable(record) };
}
