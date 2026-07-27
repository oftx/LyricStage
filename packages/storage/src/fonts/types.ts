export const fontTargets = Object.freeze([
  'all',
  'latin',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
] as const);

export type FontTarget = (typeof fontTargets)[number];

export interface ImportedFontMetadata {
  readonly assetId: string;
  readonly revision: number;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly importedAtMs: number;
  readonly targets: readonly FontTarget[];
}

export interface ImportedFontAsset {
  readonly metadata: ImportedFontMetadata;
  readonly blob: Blob;
}

export interface FontImportInput {
  readonly assetId: string;
  readonly fileName: string;
  readonly blob: Blob;
  readonly importedAtMs: number;
  readonly targets: readonly FontTarget[];
}

export interface ActiveFontAssignment {
  readonly target: FontTarget;
  readonly assetId: string;
  readonly revision: number;
  readonly assignedAtMs: number;
}

export interface FontStorageSnapshot {
  readonly assets: readonly ImportedFontMetadata[];
  readonly active: readonly ActiveFontAssignment[];
}

export interface FontStorageEstimate {
  readonly usage: number;
  readonly quota: number;
}

export interface FontStoragePolicy {
  readonly maximumFontBytes: number;
  readonly reserveBytes: number;
}

export interface FontStorageBackend {
  get(assetId: string): Promise<ImportedFontAsset | null>;
  list(): Promise<readonly ImportedFontMetadata[]>;
  snapshot(): Promise<FontStorageSnapshot>;
  /**
   * Allocates the next revision and publishes the active target assignments
   * in the same IndexedDB transaction as the Blob write.
   */
  commitImport(input: FontImportInput): Promise<ImportedFontMetadata>;
  getActive(target: FontTarget): Promise<ImportedFontAsset | null>;
  listActiveAssignments(): Promise<readonly ActiveFontAssignment[]>;
  activate(
    target: FontTarget,
    assetId: string,
    revision: number,
    assignedAtMs: number,
  ): Promise<ActiveFontAssignment>;
  delete(assetId: string): Promise<void>;
  close(): void;
}
