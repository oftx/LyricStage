import { fontTargets, type FontImportInput, type FontTarget } from './types.js';

export const DEFAULT_MAXIMUM_FONT_BYTES = 64 * 1024 * 1024;
const supportedMimeTypes = new Set([
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'application/font-sfnt',
  'application/vnd.ms-opentype',
  'application/octet-stream',
]);
const supportedExtensions = new Set(['ttf', 'otf', 'woff', 'woff2', 'ttc']);

export function validateFontImport(
  input: FontImportInput,
  maximumFontBytes = DEFAULT_MAXIMUM_FONT_BYTES,
): void {
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(input.assetId)) {
    throw new TypeError('assetId is invalid');
  }
  const fileName = input.fileName.trim();
  if (fileName.length === 0 || fileName.length > 255 || /[\u0000-\u001f\u007f]/.test(fileName)) {
    throw new TypeError('fileName is invalid');
  }
  const extension = fileName.split('.').at(-1)?.toLowerCase() ?? '';
  if (!supportedExtensions.has(extension)) throw new TypeError('unsupported font extension');
  if (input.blob.size <= 0 || input.blob.size > maximumFontBytes) {
    throw new RangeError('font file size is outside the supported range');
  }
  if (input.blob.type && !supportedMimeTypes.has(input.blob.type.toLowerCase())) {
    throw new TypeError('unsupported font MIME type');
  }
  if (!Number.isFinite(input.importedAtMs) || input.importedAtMs < 0) {
    throw new RangeError('importedAtMs must be finite and non-negative');
  }
  if (input.targets.length === 0 || !input.targets.every(isFontTarget)) {
    throw new TypeError('at least one valid font target is required');
  }
}

function isFontTarget(value: unknown): value is FontTarget {
  return fontTargets.includes(value as FontTarget);
}
