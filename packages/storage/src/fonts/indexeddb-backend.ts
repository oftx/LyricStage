import type {
  ActiveFontAssignment,
  FontImportInput,
  FontStorageBackend,
  FontStorageSnapshot,
  FontTarget,
  ImportedFontAsset,
  ImportedFontMetadata,
} from './types.js';
import { fontTargets } from './types.js';
import { validateFontImport } from './validation.js';

interface StoredFontRecord extends ImportedFontMetadata {
  readonly blob: Blob;
}

const DATABASE_VERSION = 2;
const STORE_NAME = 'fonts';
const ACTIVE_STORE_NAME = 'active-fonts';
const ALL_TARGET: FontTarget = 'all';

export class IndexedDbFontStorageBackend implements FontStorageBackend {
  readonly #database: IDBDatabase;

  private constructor(database: IDBDatabase) {
    this.#database = database;
  }

  public static async open(
    indexedDb: IDBFactory,
    databaseName = 'lyric-stage-font-storage-spike',
  ): Promise<IndexedDbFontStorageBackend> {
    const request = indexedDb.open(databaseName, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const upgradeRequest = event.target as IDBOpenDBRequest;
      const database = upgradeRequest.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'assetId' });
      }
      if (!database.objectStoreNames.contains(ACTIVE_STORE_NAME)) {
        database.createObjectStore(ACTIVE_STORE_NAME, { keyPath: 'target' });
      }
    };
    const database = await openRequest(request);
    database.onversionchange = () => database.close();
    return new IndexedDbFontStorageBackend(database);
  }

  public get(assetId: string): Promise<ImportedFontAsset | null> {
    return runTransaction(this.#database, STORE_NAME, 'readonly', (transaction, complete, _fail, guard) => {
      const request = transaction.objectStore(STORE_NAME).get(assetId);
      request.onsuccess = guard(() => {
        const record = request.result as StoredFontRecord | undefined;
        complete(record ? assetFromRecord(record) : null);
      });
    });
  }

  public list(): Promise<readonly ImportedFontMetadata[]> {
    return runTransaction(this.#database, STORE_NAME, 'readonly', (transaction, complete, _fail, guard) => {
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = guard(() => {
        const records = request.result as StoredFontRecord[];
        complete(Object.freeze(records.map(metadataFromRecord)));
      });
    });
  }

  public commitImport(input: FontImportInput): Promise<ImportedFontMetadata> {
    validateFontImport(input, Number.MAX_SAFE_INTEGER);
    return runTransaction(
      this.#database,
      [STORE_NAME, ACTIVE_STORE_NAME],
      'readwrite',
      (transaction, complete, _fail, guard) => {
        const fonts = transaction.objectStore(STORE_NAME);
        const activeFonts = transaction.objectStore(ACTIVE_STORE_NAME);
        const previousRequest = fonts.get(input.assetId);
        previousRequest.onsuccess = guard(() => {
          const previous = previousRequest.result as StoredFontRecord | undefined;
          const metadata = Object.freeze({
            assetId: input.assetId,
            revision: (previous?.revision ?? 0) + 1,
            fileName: input.fileName.trim(),
            mimeType: input.blob.type || 'application/octet-stream',
            byteLength: input.blob.size,
            importedAtMs: input.importedAtMs,
            targets: Object.freeze([...new Set(input.targets)]),
          });
          fonts.put({ ...metadata, blob: input.blob });

          const assignmentsRequest = activeFonts.getAll();
          assignmentsRequest.onsuccess = guard(() => {
            const assignments = assignmentsRequest.result as ActiveFontAssignment[];
            const targets = metadata.targets;
            for (const assignment of assignments) {
              const shouldClear = assignment.assetId === metadata.assetId
                && !targets.includes(assignment.target);
              if (shouldClear) {
                activeFonts.delete(assignment.target);
              }
            }
            for (const target of targets) {
              activeFonts.put({
                target,
                assetId: metadata.assetId,
                revision: metadata.revision,
                assignedAtMs: metadata.importedAtMs,
              } satisfies ActiveFontAssignment);
            }
            complete(metadata);
          });
        });
      },
    );
  }

  public getActive(target: FontTarget): Promise<ImportedFontAsset | null> {
    return runTransaction(
      this.#database,
      [STORE_NAME, ACTIVE_STORE_NAME],
      'readonly',
      (transaction, complete, _fail, guard) => {
        const activeFonts = transaction.objectStore(ACTIVE_STORE_NAME);
        const assignmentsRequest = activeFonts.getAll();
        assignmentsRequest.onsuccess = guard(() => {
          const assignments = assignmentsRequest.result as ActiveFontAssignment[];
          const exact = assignments.find((candidate) => candidate.target === target);
          const fallback = assignments.find((candidate) => candidate.target === ALL_TARGET);
          const candidates = exact && fallback && exact.target !== fallback.target
            ? [exact, fallback]
            : [exact ?? fallback].filter((candidate): candidate is ActiveFontAssignment => Boolean(candidate));
          const resolveCandidate = (index: number): void => {
            const assignment = candidates[index];
            if (!assignment) {
              complete(null);
              return;
            }
            const fontRequest = transaction.objectStore(STORE_NAME).get(assignment.assetId);
            fontRequest.onsuccess = guard(() => {
              const record = fontRequest.result as StoredFontRecord | undefined;
              if (!record || record.revision !== assignment.revision) {
                resolveCandidate(index + 1);
                return;
              }
              complete(assetFromRecord(record));
            });
          };
          resolveCandidate(0);
        });
      },
    );
  }

  public snapshot(): Promise<FontStorageSnapshot> {
    return runTransaction(
      this.#database,
      [STORE_NAME, ACTIVE_STORE_NAME],
      'readonly',
      (transaction, complete, _fail, guard) => {
        const fontsRequest = transaction.objectStore(STORE_NAME).getAll();
        const activeRequest = transaction.objectStore(ACTIVE_STORE_NAME).getAll();
        let fontRecords: StoredFontRecord[] | null = null;
        let assignmentRecords: ActiveFontAssignment[] | null = null;
        const publish = (): void => {
          if (!fontRecords || !assignmentRecords) return;
          complete(Object.freeze({
            assets: Object.freeze(fontRecords.map(metadataFromRecord)),
            active: Object.freeze(assignmentRecords.map(assignmentFromRecord)),
          }));
        };
        fontsRequest.onsuccess = guard(() => {
          fontRecords = fontsRequest.result as StoredFontRecord[];
          publish();
        });
        activeRequest.onsuccess = guard(() => {
          assignmentRecords = activeRequest.result as ActiveFontAssignment[];
          publish();
        });
      },
    );
  }

  public listActiveAssignments(): Promise<readonly ActiveFontAssignment[]> {
    return runTransaction(
      this.#database,
      ACTIVE_STORE_NAME,
      'readonly',
      (transaction, complete, _fail, guard) => {
        const request = transaction.objectStore(ACTIVE_STORE_NAME).getAll();
        request.onsuccess = guard(() => {
          const assignments = request.result as ActiveFontAssignment[];
          complete(Object.freeze(assignments.map(assignmentFromRecord)));
        });
      },
    );
  }

  public activate(
    target: FontTarget,
    assetId: string,
    revision: number,
    assignedAtMs: number,
  ): Promise<ActiveFontAssignment> {
    return runTransaction(
      this.#database,
      [STORE_NAME, ACTIVE_STORE_NAME],
      'readwrite',
      (transaction, complete, fail, guard) => {
        if (
          !fontTargets.includes(target)
          || !/^[a-zA-Z0-9:_-]{1,128}$/.test(assetId)
          || !Number.isSafeInteger(revision)
          || revision <= 0
          || !Number.isFinite(assignedAtMs)
          || assignedAtMs < 0
        ) {
          fail(new TypeError('Active font assignment is invalid'));
          return;
        }
        const fontRequest = transaction.objectStore(STORE_NAME).get(assetId);
        fontRequest.onsuccess = guard(() => {
          const record = fontRequest.result as StoredFontRecord | undefined;
          if (!record || record.revision !== revision) {
            fail(new DOMException('Font revision is not available', 'NotFoundError'));
            return;
          }
          if (!record.targets.includes(target) && !record.targets.includes(ALL_TARGET)) {
            fail(new DOMException('Font is not available for this target', 'InvalidStateError'));
            return;
          }
          const assignment = Object.freeze({ target, assetId, revision, assignedAtMs });
          transaction.objectStore(ACTIVE_STORE_NAME).put(assignment);
          complete(assignment);
        });
      },
    );
  }

  public delete(assetId: string): Promise<void> {
    return runTransaction(
      this.#database,
      [STORE_NAME, ACTIVE_STORE_NAME],
      'readwrite',
      (transaction, complete, _fail, guard) => {
        const activeFonts = transaction.objectStore(ACTIVE_STORE_NAME);
        const assignmentsRequest = activeFonts.getAll();
        assignmentsRequest.onsuccess = guard(() => {
          const assignments = assignmentsRequest.result as ActiveFontAssignment[];
          for (const assignment of assignments) {
            if (assignment.assetId === assetId) activeFonts.delete(assignment.target);
          }
          transaction.objectStore(STORE_NAME).delete(assetId);
          complete(undefined);
        });
      },
    );
  }

  public close(): void {
    this.#database.close();
  }
}

function assetFromRecord(record: StoredFontRecord): ImportedFontAsset {
  return Object.freeze({ metadata: metadataFromRecord(record), blob: record.blob });
}

function metadataFromRecord(record: StoredFontRecord): ImportedFontMetadata {
  return Object.freeze({
    assetId: record.assetId,
    revision: record.revision,
    fileName: record.fileName,
    mimeType: record.mimeType,
    byteLength: record.byteLength,
    importedAtMs: record.importedAtMs,
    targets: Object.freeze([...record.targets]),
  });
}

function assignmentFromRecord(record: ActiveFontAssignment): ActiveFontAssignment {
  return Object.freeze({
    target: record.target,
    assetId: record.assetId,
    revision: record.revision,
    assignedAtMs: record.assignedAtMs,
  });
}

function openRequest(request: IDBOpenDBRequest): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new DOMException('IndexedDB open is blocked by another connection', 'InvalidStateError'));
    };
  });
}

function runTransaction<T>(
  database: IDBDatabase,
  stores: string | readonly string[],
  mode: IDBTransactionMode,
  operation: (
    transaction: IDBTransaction,
    complete: (value: T) => void,
    fail: (error: unknown) => void,
    guard: (callback: () => void) => () => void,
  ) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(stores, mode);
    let result: T | undefined;
    let hasResult = false;
    let settled = false;
    let failure: unknown = null;

    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      failure = error;
      try {
        transaction.abort();
      } catch {
        rejectOnce(error);
      }
    };
    const guard = (callback: () => void): (() => void) => () => {
      try {
        callback();
      } catch (error) {
        fail(error);
      }
    };

    transaction.oncomplete = () => {
      if (settled) return;
      if (!hasResult) {
        rejectOnce(new Error('IndexedDB transaction completed without a result'));
        return;
      }
      settled = true;
      resolve(result as T);
    };
    transaction.onerror = (event) => {
      const request = event.target as IDBRequest<unknown> | null;
      failure ??= request?.error ?? transaction.error ?? new Error('IndexedDB transaction failed');
    };
    transaction.onabort = () => {
      rejectOnce(failure ?? transaction.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    };

    try {
      operation(transaction, (value) => {
        result = value;
        hasResult = true;
      }, fail, guard);
    } catch (error) {
      fail(error);
    }
  });
}
