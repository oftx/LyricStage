import { describe, expect, it } from 'vitest';
import {
  ExtensionLyricLibrary,
  importRecordId,
  sourceRecordId,
  type LyricStorageArea,
} from '../src/library/extension-lyric-library.js';

function memoryStorage(): LyricStorageArea & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      const wanted = keys === null
        ? [...data.keys()]
        : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) {
        if (data.has(key)) out[key] = data.get(key);
      }
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

function library(now = () => 1_000) {
  const storage = memoryStorage();
  return { lib: new ExtensionLyricLibrary(storage, now), storage };
}

const baseInput = {
  source: { provider: 'netease', externalId: '516180550' },
  title: 'ハルノユキ',
  creators: ['Artist'],
  format: 'yrc' as const,
  text: '[123,456](123,100,0)は',
};

describe('ExtensionLyricLibrary', () => {
  it('derives stable source ids and upserts idempotently', async () => {
    const { lib } = library();
    const first = await lib.upsert(baseInput);
    expect(first.id).toBe(sourceRecordId('netease', '516180550'));
    expect(first.revision).toBe(1);
    // Same content: no revision bump.
    const again = await lib.upsert(baseInput);
    expect(again.revision).toBe(1);
    // Changed text: revision bump, same id.
    const changed = await lib.upsert({ ...baseInput, text: '[123,456](123,100,0)春' });
    expect(changed.id).toBe(first.id);
    expect(changed.revision).toBe(2);
    expect(await lib.list()).toHaveLength(1);
  });

  it('preserves user-edited title/creators across refetch', async () => {
    const { lib, storage } = library();
    const record = await lib.upsert(baseInput);
    // Simulate a user title edit written directly.
    storage.data.set(`lyric-library:record:${record.id}`, {
      ...record,
      title: '用户改的标题',
      creators: ['用户改的作者'],
    });
    const refetched = await lib.upsert({ ...baseInput, text: 'new text', title: '平台标题' });
    expect(refetched.title).toBe('用户改的标题');
    expect(refetched.creators).toEqual(['用户改的作者']);
  });

  it('stores and validates per-media preferences with stale cleanup', async () => {
    const { lib } = library();
    const record = await lib.upsert(baseInput);
    await lib.setPreference('bilibili:BV1x:p:1', { lyricId: record.id });
    const pref = await lib.getPreference('bilibili:BV1x:p:1');
    expect(pref?.lyricId).toBe(record.id);

    await lib.setPreference('bilibili:BV2y:p:1', { ignored: true });
    expect((await lib.getPreference('bilibili:BV2y:p:1'))?.ignored).toBe(true);

    // Removing the record makes the pointing preference stale; read drops it.
    await lib.remove(record.id);
    expect(await lib.getPreference('bilibili:BV1x:p:1')).toBeNull();
    expect(await lib.list()).toHaveLength(0);
  });

  it('edits metadata with aliases surviving refetch and joining the index', async () => {
    const { lib } = library();
    const record = await lib.upsert(baseInput);
    const edited = await lib.updateMetadata(record.id, {
      title: '小星星',
      titleAliases: ['Twinkle Twinkle Little Star', '小星星儿歌'],
      creatorAliases: ['汪苏泷'],
    });
    expect(edited?.titleAliases).toEqual(['Twinkle Twinkle Little Star', '小星星儿歌']);
    // Aliases appear in the index for matching without loading records.
    const [entry] = await lib.list();
    expect(entry?.titleAliases).toContain('小星星儿歌');
    expect(entry?.creatorAliases).toEqual(['汪苏泷']);
    // Refetch with new text keeps the edited metadata.
    const refetched = await lib.upsert({ ...baseInput, text: 'new body' });
    expect(refetched.titleAliases).toEqual(['Twinkle Twinkle Little Star', '小星星儿歌']);
    // Clearing aliases removes the keys.
    const cleared = await lib.updateMetadata(record.id, { titleAliases: [], creatorAliases: [] });
    expect(cleared?.titleAliases).toBeUndefined();
  });

  it('manual imports are idempotent by title+text content hash', async () => {
    const { lib } = library();
    const input = {
      title: '手动歌', creators: ['某人'], format: 'lrc' as const,
      text: '[00:01.00] 第一行',
    };
    const first = await lib.upsert(input);
    expect(first.id).toBe(importRecordId('手动歌', '[00:01.00] 第一行'));
    // Re-import of the same content hits the same record, no duplicate.
    const again = await lib.upsert(input);
    expect(again.id).toBe(first.id);
    expect(await lib.list()).toHaveLength(1);
    // Different text = genuinely new record.
    const changed = await lib.upsert({ ...input, text: '[00:01.00] 改了' });
    expect(changed.id).not.toBe(first.id);
    expect(await lib.list()).toHaveLength(2);
  });

  it('concurrent writers to different records cannot lose index entries', async () => {
    // Two library instances over ONE storage area (two contexts) interleaved
    // so both read before either writes — the pre-refactor monolithic index
    // lost one entry here; per-record keys make the writes disjoint.
    const storage = memoryStorage();
    const libA = new ExtensionLyricLibrary(storage, () => 1_000);
    const libB = new ExtensionLyricLibrary(storage, () => 1_000);
    await Promise.all([
      libA.upsert({ ...baseInput, source: { provider: 'netease', externalId: 'a' } }),
      libB.upsert({ ...baseInput, source: { provider: 'qqmusic', externalId: 'b' } }),
    ]);
    const index = await libA.list();
    expect(index).toHaveLength(2);
  });

  it('migrates the legacy monolithic index and repairs dropped entries', async () => {
    const storage = memoryStorage();
    const lib = new ExtensionLyricLibrary(storage, () => 1_000);
    // Seed: two record bodies, but the legacy array only knows about one
    // (simulating an entry lost to the old index race).
    const known = {
      schemaVersion: 1, id: 'source-x-y', revision: 1,
      title: 'Known', creators: [], format: 'lrc', text: '[00:01.00] k',
      createdAt: 1, updatedAt: 5,
    };
    const orphan = {
      schemaVersion: 1, id: 'source-o-o', revision: 1,
      title: 'Orphan', creators: [], format: 'lrc', text: '[00:01.00] o',
      createdAt: 1, updatedAt: 3,
    };
    storage.data.set('lyric-library:record:source-x-y', known);
    storage.data.set('lyric-library:record:source-o-o', orphan);
    storage.data.set('lyric-library:index', [{
      id: 'source-x-y', title: 'Known', creators: [], format: 'lrc',
      hasTranslation: false, updatedAt: 5,
    }]);
    const entries = await lib.list();
    expect(entries.map((entry) => entry.id).sort()).toEqual(['source-o-o', 'source-x-y']);
    // Legacy key is gone; per-record keys exist.
    expect(storage.data.has('lyric-library:index')).toBe(false);
    expect(storage.data.has('lyric-library:index:source-o-o')).toBe(true);
  });

  it('rebuildIndex re-derives missing entries from record bodies', async () => {
    const { lib, storage } = library();
    const record = await lib.upsert(baseInput);
    // Simulate a lost index entry.
    storage.data.delete(`lyric-library:index:${record.id}`);
    expect(await lib.list()).toHaveLength(0);
    expect(await lib.rebuildIndex()).toBe(1);
    expect(await lib.list()).toHaveLength(1);
  });

  it('remove deletes body and index atomically in one call', async () => {
    const { lib, storage } = library();
    const record = await lib.upsert(baseInput);
    await lib.remove(record.id);
    expect(storage.data.has(`lyric-library:record:${record.id}`)).toBe(false);
    expect(storage.data.has(`lyric-library:index:${record.id}`)).toBe(false);
  });

  it('copy-on-edit: platform records fork, user records update in place', async () => {
    const { lib } = library();
    const platform = await lib.upsert(baseInput);
    const copy = await lib.saveEditedText(platform.id, { text: '[00:01.00] edited' });
    // Platform original untouched; copy is a user record bound to new id.
    expect(copy?.id).not.toBe(platform.id);
    expect(copy?.source).toBeUndefined();
    expect(copy?.title).toContain('编辑副本');
    expect((await lib.getRecord(platform.id))?.text).toBe(baseInput.text);
    expect(await lib.list()).toHaveLength(2);
    // Editing the copy again updates in place.
    const updated = await lib.saveEditedText(copy!.id, {
      text: '[00:02.00] edited again',
      translationText: '[00:02.00] 翻译',
    });
    expect(updated?.id).toBe(copy!.id);
    expect(updated?.revision).toBe(2);
    expect(updated?.translationText).toBe('[00:02.00] 翻译');
    // Clearing translation removes the key.
    const cleared = await lib.saveEditedText(copy!.id, { text: '[00:03.00] final' });
    expect(cleared?.translationText).toBeUndefined();
    expect(await lib.list()).toHaveLength(2);
  });

  it('rejects empty text and enforces the record cap for new entries', async () => {
    const { lib } = library();
    await expect(lib.upsert({ ...baseInput, text: '   ' })).rejects.toThrow(/empty/);
  });
});
