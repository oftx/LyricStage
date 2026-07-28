/**
 * Library resolution policy for platforms without a lyric source (video
 * sites): explicit per-media preference only (ignores included).
 * Extracted from the content runtime so the composition policy is unit-testable —
 * same pattern as lyric-refresh.ts.
 */
import type { PortableLyricText } from '@lyric-stage/platform-adapters';
import type {
  ExtensionLyricLibrary,
  LyricLibraryRecordV1,
} from './extension-lyric-library.js';

export interface ResolveLibraryLyricDeps {
  readonly library: ExtensionLyricLibrary;
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
  if (!record) return null;
  return { libraryId: record.id, lyric: toPortable(record) };
}
