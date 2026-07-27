import { describe, expect, it } from 'vitest';
import { detectFontStorageCapabilities } from '../src/fonts/index.js';

describe('font storage capability detection', () => {
  it('reports IndexedDB and OPFS independently', () => {
    const scope = {
      indexedDB: { open() {} },
      navigator: {
        storage: {
          estimate() {},
          persist() {},
          getDirectory() {},
        },
      },
    } as unknown as typeof globalThis;
    expect(detectFontStorageCapabilities(scope)).toEqual({
      indexedDb: true,
      opfs: true,
      storageEstimate: true,
      persistentStorageRequest: true,
    });
  });
});
