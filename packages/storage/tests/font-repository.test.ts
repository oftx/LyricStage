import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FontRepository,
  handleFontBrokerRequest,
  IndexedDbFontStorageBackend,
  InvalidFontBinaryError,
  inspectFontBinary,
  validateFontImport,
} from '../src/index.js';

let indexedDb: IDBFactory;

beforeEach(() => {
  indexedDb = new IDBFactory();
});

describe('Extension-origin font repository spike', () => {
  it('persists a font Blob and its active assignment across repository close/reopen', async () => {
    const first = await repository('restart-db');
    const metadata = await first.import(fontInput());
    expect(metadata).toMatchObject({
      assetId: 'font:apple-compatible',
      revision: 1,
      byteLength: 4,
      targets: ['all', 'ja'],
    });
    expect((await first.getActive('ja'))?.metadata.revision).toBe(1);
    first.close();

    const reopened = await repository('restart-db');
    const asset = await reopened.get('font:apple-compatible');
    expect(asset?.metadata.revision).toBe(1);
    expect([...new Uint8Array(await asset!.blob.arrayBuffer())]).toEqual([0, 1, 2, 3]);
    expect((await reopened.getActive('ja'))?.metadata.assetId).toBe('font:apple-compatible');
    expect((await reopened.listActiveAssignments()).map((item) => item.target)).toEqual(['all', 'ja']);
    reopened.close();
  });

  it('serves one stored asset and active metadata to two site consumers through the broker', async () => {
    const repo = await repository('cross-site-db');
    await repo.import(fontInput());
    const firstSite = await handleFontBrokerRequest(repo, {
      type: 'font-read',
      assetId: 'font:apple-compatible',
    });
    const secondSite = await handleFontBrokerRequest(repo, {
      type: 'font-read',
      assetId: 'font:apple-compatible',
    });
    const list = await handleFontBrokerRequest(repo, { type: 'font-list' });
    expect(firstSite).toMatchObject({ ok: true, revision: 1 });
    expect(secondSite).toMatchObject({ ok: true, revision: 1 });
    expect(list).toMatchObject({ ok: true, type: 'font-list' });
    if (firstSite.ok && firstSite.type === 'font-read') {
      expect(firstSite.blob.size).toBe(4);
      const cloned = structuredClone(firstSite);
      expect(cloned.blob).toBeInstanceOf(Blob);
      expect([...new Uint8Array(await cloned.blob.arrayBuffer())]).toEqual([0, 1, 2, 3]);
    }
    if (list.ok && list.type === 'font-list') {
      expect(list.assets[0]?.assetId).toBe('font:apple-compatible');
      expect(list.active.map((item) => item.target)).toEqual(['all', 'ja']);
    }
    repo.close();
  });

  it('rejects invalid files and insufficient quota before replacing committed data', async () => {
    expect(() => validateFontImport({
      ...fontInput(),
      fileName: 'malware.exe',
    })).toThrow('unsupported font extension');

    const backend = await IndexedDbFontStorageBackend.open(indexedDb, 'quota-db');
    const accepted = new FontRepository(backend, {
      estimateStorage: async () => ({ usage: 0, quota: 64 * 1024 * 1024 }),
      policy: { reserveBytes: 0 },
      validateBinary: false,
    });
    await accepted.import(fontInput());
    accepted.close();

    const reopenedBackend = await IndexedDbFontStorageBackend.open(indexedDb, 'quota-db');
    const full = new FontRepository(reopenedBackend, {
      estimateStorage: async () => ({ usage: 100, quota: 100 }),
      policy: { reserveBytes: 0 },
      validateBinary: false,
    });
    await expect(full.import({
      ...fontInput(),
      blob: new Blob([new Uint8Array([9, 9, 9, 9, 9])], { type: 'font/ttf' }),
    })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    const retained = await full.get('font:apple-compatible');
    expect([...new Uint8Array(await retained!.blob.arrayBuffer())]).toEqual([0, 1, 2, 3]);
    expect(retained?.metadata.revision).toBe(1);
    expect((await full.getActive('ja'))?.metadata.revision).toBe(1);
    full.close();
  });

  it('allocates revisions atomically for concurrent repositories', async () => {
    const first = await repository('concurrent-db');
    const second = await repository('concurrent-db');
    const [firstMetadata, secondMetadata] = await Promise.all([
      first.import(fontInput({ bytes: [1, 1, 1] })),
      second.import(fontInput({ bytes: [2, 2, 2] })),
    ]);
    expect([firstMetadata.revision, secondMetadata.revision].sort()).toEqual([1, 2]);

    const reopened = await repository('concurrent-db');
    const final = await reopened.get('font:apple-compatible');
    expect(final?.metadata.revision).toBe(2);
    expect([...new Uint8Array(await final!.blob.arrayBuffer())]).toEqual(
      firstMetadata.revision === 2 ? [1, 1, 1] : [2, 2, 2],
    );
    expect((await reopened.getActive('ja'))?.metadata.revision).toBe(2);
    first.close();
    second.close();
    reopened.close();
  });

  it('supports language-specific activation with an all-target fallback', async () => {
    const repo = await repository('activation-db');
    await repo.import(fontInput({ assetId: 'font:general', targets: ['all'] }));
    const japanese = await repo.import(fontInput({ assetId: 'font:japanese', targets: ['ja'] }));

    expect((await repo.getActive('latin'))?.metadata.assetId).toBe('font:general');
    expect((await repo.getActive('ja'))?.metadata.assetId).toBe('font:japanese');
    const general = await repo.import(fontInput({
      assetId: 'font:general',
      importedAtMs: 2,
      targets: ['all'],
    }));
    expect((await repo.getActive('ja'))?.metadata.assetId).toBe('font:japanese');

    await repo.activate('ja', general.assetId, general.revision, 20);
    expect((await repo.getActive('ja'))?.metadata.assetId).toBe('font:general');
    await expect(repo.activate('ko', 'font:japanese', japanese.revision, 21))
      .rejects.toMatchObject({ name: 'InvalidStateError' });
    await expect(repo.activate('ko', 'font:japanese', japanese.revision + 1, 21))
      .rejects.toMatchObject({ name: 'NotFoundError' });
    expect((await repo.getActive('ko'))?.metadata.assetId).toBe('font:general');
    repo.close();
  });

  it('rolls back the Blob and active pointers when the commit transaction aborts', async () => {
    const backend = await IndexedDbFontStorageBackend.open(indexedDb, 'abort-db');
    const repo = new FontRepository(backend, {
      estimateStorage: async () => ({ usage: 0, quota: 256 * 1024 * 1024 }),
      validateBinary: false,
    });
    await repo.import(fontInput());

    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'active-fonts') {
        throw new DOMException('Injected quota failure', 'QuotaExceededError');
      }
      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
    });
    try {
      await expect(backend.commitImport(fontInput({ bytes: [8, 8, 8] })))
        .rejects.toMatchObject({ name: 'QuotaExceededError' });
    } finally {
      putSpy.mockRestore();
    }

    const retained = await repo.get('font:apple-compatible');
    expect(retained?.metadata.revision).toBe(1);
    expect([...new Uint8Array(await retained!.blob.arrayBuffer())]).toEqual([0, 1, 2, 3]);
    expect((await repo.getActive('ja'))?.metadata.revision).toBe(1);
    repo.close();
  });

  it('increments revision transactionally and deletes active assignments', async () => {
    const repo = await repository('revision-db');
    await repo.import(fontInput());
    const second = await repo.import(fontInput({
      importedAtMs: 2,
      bytes: [4, 5],
    }));
    expect(second.revision).toBe(2);
    expect((await repo.list()).map((asset) => asset.revision)).toEqual([2]);
    await repo.delete('font:apple-compatible');
    expect(await repo.get('font:apple-compatible')).toBeNull();
    expect(await repo.getActive('ja')).toBeNull();
    expect(await repo.listActiveAssignments()).toEqual([]);
    repo.close();
  });

  it('rejects arbitrary broker requests', async () => {
    const repo = await repository('broker-db');
    await repo.import(fontInput());
    expect(await handleFontBrokerRequest(repo, {
      type: 'font-read',
      assetId: 'font:apple-compatible',
      expectedRevision: 2,
    })).toEqual({
      ok: false,
      code: 'revision-mismatch',
      assetId: 'font:apple-compatible',
      currentRevision: 1,
    });
    expect(await handleFontBrokerRequest(repo, {
      type: 'font-read',
      assetId: 'font:apple-compatible',
      expectedRevision: 1,
    })).toMatchObject({ ok: true, type: 'font-read', revision: 1 });
    expect(await handleFontBrokerRequest(repo, {
      type: 'font-read',
      assetId: 'font:apple-compatible',
      unexpected: true,
    })).toEqual({ ok: false, code: 'invalid-request' });
    expect(await handleFontBrokerRequest(repo, Object.assign(
      Object.create({ expectedRevision: 2 }) as Record<string, unknown>,
      { type: 'font-read', assetId: 'font:apple-compatible' },
    ))).toMatchObject({ ok: true, type: 'font-read', revision: 1 });
    expect(await handleFontBrokerRequest(repo, Object.assign(
      Object.create({ type: 'font-read' }) as Record<string, unknown>,
      { assetId: 'font:apple-compatible' },
    ))).toEqual({ ok: false, code: 'invalid-request' });
    expect(await handleFontBrokerRequest(repo, {
      type: 'font-read',
      assetId: '../../secret',
    })).toEqual({ ok: false, code: 'invalid-request' });
    expect(await handleFontBrokerRequest(repo, {
      type: 'font-read',
      assetId: 'missing-font',
    })).toEqual({ ok: false, code: 'not-found' });
    repo.close();
  });

  it('rejects MIME-valid garbage before the binary becomes active', async () => {
    const sfnt = new Uint8Array(12);
    new DataView(sfnt.buffer).setUint32(0, 0x00_01_00_00, false);
    new DataView(sfnt.buffer).setUint16(4, 1, false);
    expect(inspectFontBinary(sfnt.buffer).kind).toBe('sfnt');
    expect(() => inspectFontBinary(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer))
      .toThrow(InvalidFontBinaryError);

    const backend = await IndexedDbFontStorageBackend.open(indexedDb, 'binary-reject-db');
    const strict = new FontRepository(backend, {
      estimateStorage: async () => ({ usage: 0, quota: 256 * 1024 * 1024 }),
      validateBinary: true,
    });
    await expect(strict.import({
      assetId: 'font:garbage',
      fileName: 'Garbage.ttf',
      blob: new Blob([new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])], { type: 'font/ttf' }),
      importedAtMs: 1,
      targets: ['all'],
    })).rejects.toBeInstanceOf(InvalidFontBinaryError);
    expect(await strict.get('font:garbage')).toBeNull();
    await strict.import({
      assetId: 'font:sfnt-stub',
      fileName: 'Stub.ttf',
      blob: new Blob([sfnt], { type: 'font/ttf' }),
      importedAtMs: 1,
      targets: ['all'],
    });
    expect((await strict.get('font:sfnt-stub'))?.metadata.revision).toBe(1);
    strict.close();
  });
});

async function repository(databaseName: string): Promise<FontRepository> {
  const backend = await IndexedDbFontStorageBackend.open(indexedDb, databaseName);
  return new FontRepository(backend, {
    estimateStorage: async () => ({ usage: 0, quota: 256 * 1024 * 1024 }),
    // Existing fixtures are intentionally not real font containers.
    validateBinary: false,
  });
}

function fontInput(overrides: {
  assetId?: string;
  bytes?: number[];
  importedAtMs?: number;
  targets?: readonly ('all' | 'ja')[];
} = {}) {
  return {
    assetId: overrides.assetId ?? 'font:apple-compatible',
    fileName: 'AppleCompatible.ttf',
    blob: new Blob([new Uint8Array(overrides.bytes ?? [0, 1, 2, 3])], { type: 'font/ttf' }),
    importedAtMs: overrides.importedAtMs ?? 1,
    targets: overrides.targets ?? ['all', 'ja'] as const,
  };
}
