export interface FontStorageCapabilities {
  readonly indexedDb: boolean;
  readonly opfs: boolean;
  readonly storageEstimate: boolean;
  readonly persistentStorageRequest: boolean;
}

export function detectFontStorageCapabilities(scope: typeof globalThis): FontStorageCapabilities {
  const storage = scope.navigator?.storage;
  return Object.freeze({
    indexedDb: typeof scope.indexedDB?.open === 'function',
    opfs: typeof storage?.getDirectory === 'function',
    storageEstimate: typeof storage?.estimate === 'function',
    persistentStorageRequest: typeof storage?.persist === 'function',
  });
}
