import { inspectFontBlob } from './font-binary.js';
import type {
  ActiveFontAssignment,
  FontImportInput,
  FontStorageBackend,
  FontStorageEstimate,
  FontStoragePolicy,
  FontStorageSnapshot,
  FontTarget,
  ImportedFontAsset,
  ImportedFontMetadata,
} from './types.js';
import { DEFAULT_MAXIMUM_FONT_BYTES, validateFontImport } from './validation.js';

const DEFAULT_RESERVE_BYTES = 16 * 1024 * 1024;

export interface FontRepositoryOptions {
  readonly estimateStorage: () => Promise<FontStorageEstimate | null>;
  readonly policy?: Partial<FontStoragePolicy>;
  /**
   * When true (default), reject extension/MIME-valid garbage that is not a
   * recognized font container before the IndexedDB commit.
   */
  readonly validateBinary?: boolean;
}

export class FontRepository {
  readonly #backend: FontStorageBackend;
  readonly #estimateStorage: () => Promise<FontStorageEstimate | null>;
  readonly #maximumFontBytes: number;
  readonly #reserveBytes: number;
  readonly #validateBinary: boolean;

  constructor(backend: FontStorageBackend, options: FontRepositoryOptions) {
    this.#backend = backend;
    this.#estimateStorage = options.estimateStorage;
    this.#maximumFontBytes = options.policy?.maximumFontBytes ?? DEFAULT_MAXIMUM_FONT_BYTES;
    this.#reserveBytes = options.policy?.reserveBytes ?? DEFAULT_RESERVE_BYTES;
    this.#validateBinary = options.validateBinary ?? true;
  }

  public async import(input: FontImportInput): Promise<ImportedFontMetadata> {
    validateFontImport(input, this.#maximumFontBytes);
    if (this.#validateBinary) {
      await inspectFontBlob(input.blob);
    }
    const previous = await this.#backend.get(input.assetId);
    const estimate = await this.#estimateStorage();
    const replacementBytes = Math.max(0, input.blob.size - (previous?.metadata.byteLength ?? 0));
    if (estimate && estimate.quota - estimate.usage - this.#reserveBytes < replacementBytes) {
      throw new DOMException('Insufficient storage quota for font import', 'QuotaExceededError');
    }

    const normalizedInput: FontImportInput = Object.freeze({
      assetId: input.assetId,
      fileName: input.fileName.trim(),
      blob: input.blob,
      importedAtMs: input.importedAtMs,
      targets: Object.freeze([...new Set(input.targets)]),
    });
    return this.#backend.commitImport(normalizedInput);
  }

  public get(assetId: string): Promise<ImportedFontAsset | null> {
    return this.#backend.get(assetId);
  }

  public list(): Promise<readonly ImportedFontMetadata[]> {
    return this.#backend.list();
  }

  public snapshot(): Promise<FontStorageSnapshot> {
    return this.#backend.snapshot();
  }

  public getActive(target: FontTarget): Promise<ImportedFontAsset | null> {
    return this.#backend.getActive(target);
  }

  public listActiveAssignments(): Promise<readonly ActiveFontAssignment[]> {
    return this.#backend.listActiveAssignments();
  }

  public activate(
    target: FontTarget,
    assetId: string,
    revision: number,
    assignedAtMs: number,
  ): Promise<ActiveFontAssignment> {
    return this.#backend.activate(target, assetId, revision, assignedAtMs);
  }

  public delete(assetId: string): Promise<void> {
    return this.#backend.delete(assetId);
  }

  public close(): void {
    this.#backend.close();
  }
}
