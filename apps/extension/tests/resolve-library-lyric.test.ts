import { describe, expect, it } from 'vitest';
import { resolveLibraryLyric } from '../src/library/resolve-library-lyric.js';
import {
  ExtensionLyricLibrary,
  type LyricStorageArea,
} from '../src/library/extension-lyric-library.js';

function memoryStorage(): LyricStorageArea & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      const wanted = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) if (data.has(key)) out[key] = data.get(key);
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
  };
}

async function harness() {
  const library = new ExtensionLyricLibrary(memoryStorage(), () => 1_000);
  const record = await library.upsert({
    source: { provider: 'netease', externalId: '1' },
    title: '小星星',
    creators: ['汪苏泷'],
    durationMs: 213_000,
    format: 'lrc',
    text: '[00:01.00] 一闪一闪亮晶晶',
  });
  return { library, record };
}

describe('resolveLibraryLyric', () => {
  it('applies the explicit preference', async () => {
    const { library, record } = await harness();
    await library.setPreference('bilibili:BV1:p:1', { lyricId: record.id });
    const resolved = await resolveLibraryLyric({ library }, 'bilibili:BV1:p:1');
    expect(resolved?.libraryId).toBe(record.id);
    expect(resolved?.lyric.sourceName).toBe('library:小星星');
  });

  it('respects ignore preference', async () => {
    const { library } = await harness();
    await library.setPreference('bilibili:BV2:p:1', { ignored: true });
    expect(await resolveLibraryLyric({ library }, 'bilibili:BV2:p:1')).toBeNull();
  });

  it('returns null without explicit preference', async () => {
    const { library } = await harness();
    expect(await resolveLibraryLyric({ library }, 'bilibili:BV6:p:1')).toBeNull();
  });
});
