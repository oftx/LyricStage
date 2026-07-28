export type SearchPlatform = 'netease' | 'qqmusic';
export type SearchType = 'song' | 'lyric';

export type LyricSearchRequest = {
  readonly query: string;
  readonly platform: SearchPlatform;
  readonly searchType: SearchType;
  readonly limit?: number;
  readonly signal?: AbortSignal;
};

export type LyricSearchResultItem = {
  readonly platform: SearchPlatform;
  readonly externalId: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly album?: string;
  readonly durationMs?: number;
  readonly snippet?: string;
};

export type LyricSearchResult =
  | { readonly ok: true; readonly items: readonly LyricSearchResultItem[] }
  | { readonly ok: false; readonly reason: string };
