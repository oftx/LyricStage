/** Bounded binary checks before a font becomes active. */

const SFNT_VERSIONS = new Set([
  0x00_01_00_00, // TrueType
  0x4f_54_54_4f, // OTTO (CFF OpenType)
  0x74_72_75_65, // true
  0x74_79_70_31, // typ1
]);

const COLLECTION_TAG = 0x74_74_63_66; // ttcf
const WOFF_TAG = 0x77_4f_46_46; // wOFF
const WOFF2_TAG = 0x77_4f_46_32; // wOF2

export type FontBinaryKind = 'sfnt' | 'ttc' | 'woff' | 'woff2';

export interface FontBinaryInspection {
  readonly ok: true;
  readonly kind: FontBinaryKind;
  readonly byteLength: number;
}

export class InvalidFontBinaryError extends TypeError {
  readonly code = 'invalid-font-binary' as const;

  constructor(message = 'font binary is not a recognized font container') {
    super(message);
    this.name = 'InvalidFontBinaryError';
  }
}

/**
 * Cheap container sniff. Rejects MIME/extension-valid garbage before commit.
 * Does not prove every table is well-formed; production may still run FontFace.
 */
export function inspectFontBinary(bytes: ArrayBuffer): FontBinaryInspection {
  if (bytes.byteLength < 4) {
    throw new InvalidFontBinaryError('font binary is too short');
  }
  const view = new DataView(bytes);
  const tag = view.getUint32(0, false);
  if (SFNT_VERSIONS.has(tag)) {
    if (bytes.byteLength < 12) {
      throw new InvalidFontBinaryError('sfnt header is truncated');
    }
    const numTables = view.getUint16(4, false);
    if (numTables === 0 || numTables > 4096) {
      throw new InvalidFontBinaryError('sfnt table count is implausible');
    }
    return { ok: true, kind: 'sfnt', byteLength: bytes.byteLength };
  }
  if (tag === COLLECTION_TAG) {
    if (bytes.byteLength < 12) {
      throw new InvalidFontBinaryError('ttc header is truncated');
    }
    return { ok: true, kind: 'ttc', byteLength: bytes.byteLength };
  }
  if (tag === WOFF_TAG) {
    if (bytes.byteLength < 44) {
      throw new InvalidFontBinaryError('woff header is truncated');
    }
    return { ok: true, kind: 'woff', byteLength: bytes.byteLength };
  }
  if (tag === WOFF2_TAG) {
    if (bytes.byteLength < 48) {
      throw new InvalidFontBinaryError('woff2 header is truncated');
    }
    return { ok: true, kind: 'woff2', byteLength: bytes.byteLength };
  }
  throw new InvalidFontBinaryError();
}

export async function inspectFontBlob(blob: Blob): Promise<FontBinaryInspection> {
  return inspectFontBinary(await blob.arrayBuffer());
}
