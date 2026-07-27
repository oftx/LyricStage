import type { FontRepository } from './font-repository.js';
import type {
  ActiveFontAssignment,
  FontTarget,
  ImportedFontMetadata,
} from './types.js';

export type FontBrokerRequest =
  | { readonly type: 'font-list' }
  | {
    readonly type: 'font-read';
    readonly assetId: string;
    readonly expectedRevision?: number;
  };

export type FontBrokerResponse =
  | {
    readonly ok: true;
    readonly type: 'font-list';
    readonly assets: readonly ImportedFontMetadata[];
    readonly active: readonly ActiveFontAssignment[];
  }
  | {
    readonly ok: true;
    readonly type: 'font-read';
    readonly assetId: string;
    readonly revision: number;
    readonly targets: readonly FontTarget[];
    readonly blob: Blob;
  }
  | { readonly ok: false; readonly code: 'invalid-request' | 'not-found' }
  | {
    readonly ok: false;
    readonly code: 'revision-mismatch';
    readonly assetId: string;
    readonly currentRevision: number;
  };

/** Extension-origin broker; content scripts never create per-site font stores. */
export async function handleFontBrokerRequest(
  repository: FontRepository,
  request: unknown,
): Promise<FontBrokerResponse> {
  if (
    !isRecord(request)
    || !Object.hasOwn(request, 'type')
    || typeof request.type !== 'string'
  ) {
    return { ok: false, code: 'invalid-request' };
  }
  if (request.type === 'font-list' && Object.keys(request).length === 1) {
    return {
      ok: true,
      type: 'font-list',
      ...await repository.snapshot(),
    };
  }
  const requestKeys = Object.keys(request);
  const allowedReadKeys = new Set(['type', 'assetId', 'expectedRevision']);
  const hasExpectedRevision = Object.hasOwn(request, 'expectedRevision');
  const expectedRevision = hasExpectedRevision ? request.expectedRevision : undefined;
  const hasValidExpectedRevision = expectedRevision === undefined
    || (
      typeof expectedRevision === 'number'
      && Number.isSafeInteger(expectedRevision)
      && expectedRevision > 0
    );
  if (
    request.type === 'font-read'
    && (requestKeys.length === 2 || requestKeys.length === 3)
    && requestKeys.every((key) => allowedReadKeys.has(key))
    && Object.hasOwn(request, 'assetId')
    && typeof request.assetId === 'string'
    && /^[a-zA-Z0-9:_-]{1,128}$/.test(request.assetId)
    && hasValidExpectedRevision
    && (requestKeys.length === 2 || hasExpectedRevision)
  ) {
    const asset = await repository.get(request.assetId);
    if (!asset) return { ok: false, code: 'not-found' };
    if (typeof expectedRevision === 'number' && asset.metadata.revision !== expectedRevision) {
      return {
        ok: false,
        code: 'revision-mismatch',
        assetId: asset.metadata.assetId,
        currentRevision: asset.metadata.revision,
      };
    }
    return {
      ok: true,
      type: 'font-read',
      assetId: asset.metadata.assetId,
      revision: asset.metadata.revision,
      targets: asset.metadata.targets,
      blob: asset.blob,
    };
  }
  return { ok: false, code: 'invalid-request' };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
