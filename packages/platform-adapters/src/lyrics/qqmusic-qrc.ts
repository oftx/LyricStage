// @ts-nocheck — ported DES/QRC crypto from lyric-stage; keep binary-correct.
const QRC_KEY = new TextEncoder().encode('!@#)(*$%123ZXC!@!@#)(NHL');
const MAX_QQ_LYRIC_TEXT_LENGTH = 16 * 1024 * 1024;
// QQ's encrypted QRC uses a fixed three-key DES chain unavailable in Web Crypto.
const SBOX: readonly (readonly number[])[] = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

export type QqInflater = (bytes: Uint8Array) => Promise<string>;

function bitnum(bytes: Uint8Array, bit: number, targetBit: number): number {
  const byteIndex = Math.floor(bit / 32) * 4 + 3 - Math.floor((bit % 32) / 8);
  const shift = 7 - (bit % 8);
  return ((bytes[byteIndex] >> shift) & 1) << targetBit;
}

function bitnumIntr(value: number, bit: number, targetBit: number): number {
  return ((value >>> (31 - bit)) & 1) << targetBit;
}

function bitnumIntl(value: number, bit: number, targetBit: number): number {
  return ((value << bit) & 0x80000000) >>> targetBit;
}

function sboxBit(value: number): number {
  return (value & 32) | ((value & 31) >>> 1) | ((value & 1) << 4);
}

function initialPermutation(input: Uint8Array): [number, number] {
  const left =
    bitnum(input, 57, 31) | bitnum(input, 49, 30) | bitnum(input, 41, 29) | bitnum(input, 33, 28) |
    bitnum(input, 25, 27) | bitnum(input, 17, 26) | bitnum(input, 9, 25) | bitnum(input, 1, 24) |
    bitnum(input, 59, 23) | bitnum(input, 51, 22) | bitnum(input, 43, 21) | bitnum(input, 35, 20) |
    bitnum(input, 27, 19) | bitnum(input, 19, 18) | bitnum(input, 11, 17) | bitnum(input, 3, 16) |
    bitnum(input, 61, 15) | bitnum(input, 53, 14) | bitnum(input, 45, 13) | bitnum(input, 37, 12) |
    bitnum(input, 29, 11) | bitnum(input, 21, 10) | bitnum(input, 13, 9) | bitnum(input, 5, 8) |
    bitnum(input, 63, 7) | bitnum(input, 55, 6) | bitnum(input, 47, 5) | bitnum(input, 39, 4) |
    bitnum(input, 31, 3) | bitnum(input, 23, 2) | bitnum(input, 15, 1) | bitnum(input, 7, 0);
  const right =
    bitnum(input, 56, 31) | bitnum(input, 48, 30) | bitnum(input, 40, 29) | bitnum(input, 32, 28) |
    bitnum(input, 24, 27) | bitnum(input, 16, 26) | bitnum(input, 8, 25) | bitnum(input, 0, 24) |
    bitnum(input, 58, 23) | bitnum(input, 50, 22) | bitnum(input, 42, 21) | bitnum(input, 34, 20) |
    bitnum(input, 26, 19) | bitnum(input, 18, 18) | bitnum(input, 10, 17) | bitnum(input, 2, 16) |
    bitnum(input, 60, 15) | bitnum(input, 52, 14) | bitnum(input, 44, 13) | bitnum(input, 36, 12) |
    bitnum(input, 28, 11) | bitnum(input, 20, 10) | bitnum(input, 12, 9) | bitnum(input, 4, 8) |
    bitnum(input, 62, 7) | bitnum(input, 54, 6) | bitnum(input, 46, 5) | bitnum(input, 38, 4) |
    bitnum(input, 30, 3) | bitnum(input, 22, 2) | bitnum(input, 14, 1) | bitnum(input, 6, 0);
  return [left >>> 0, right >>> 0];
}

function inversePermutation(left: number, right: number): Uint8Array {
  const output = new Uint8Array(8);
  output[3] = bitnumIntr(right, 7, 7) | bitnumIntr(left, 7, 6) | bitnumIntr(right, 15, 5) |
    bitnumIntr(left, 15, 4) | bitnumIntr(right, 23, 3) | bitnumIntr(left, 23, 2) |
    bitnumIntr(right, 31, 1) | bitnumIntr(left, 31, 0);
  output[2] = bitnumIntr(right, 6, 7) | bitnumIntr(left, 6, 6) | bitnumIntr(right, 14, 5) |
    bitnumIntr(left, 14, 4) | bitnumIntr(right, 22, 3) | bitnumIntr(left, 22, 2) |
    bitnumIntr(right, 30, 1) | bitnumIntr(left, 30, 0);
  output[1] = bitnumIntr(right, 5, 7) | bitnumIntr(left, 5, 6) | bitnumIntr(right, 13, 5) |
    bitnumIntr(left, 13, 4) | bitnumIntr(right, 21, 3) | bitnumIntr(left, 21, 2) |
    bitnumIntr(right, 29, 1) | bitnumIntr(left, 29, 0);
  output[0] = bitnumIntr(right, 4, 7) | bitnumIntr(left, 4, 6) | bitnumIntr(right, 12, 5) |
    bitnumIntr(left, 12, 4) | bitnumIntr(right, 20, 3) | bitnumIntr(left, 20, 2) |
    bitnumIntr(right, 28, 1) | bitnumIntr(left, 28, 0);
  output[7] = bitnumIntr(right, 3, 7) | bitnumIntr(left, 3, 6) | bitnumIntr(right, 11, 5) |
    bitnumIntr(left, 11, 4) | bitnumIntr(right, 19, 3) | bitnumIntr(left, 19, 2) |
    bitnumIntr(right, 27, 1) | bitnumIntr(left, 27, 0);
  output[6] = bitnumIntr(right, 2, 7) | bitnumIntr(left, 2, 6) | bitnumIntr(right, 10, 5) |
    bitnumIntr(left, 10, 4) | bitnumIntr(right, 18, 3) | bitnumIntr(left, 18, 2) |
    bitnumIntr(right, 26, 1) | bitnumIntr(left, 26, 0);
  output[5] = bitnumIntr(right, 1, 7) | bitnumIntr(left, 1, 6) | bitnumIntr(right, 9, 5) |
    bitnumIntr(left, 9, 4) | bitnumIntr(right, 17, 3) | bitnumIntr(left, 17, 2) |
    bitnumIntr(right, 25, 1) | bitnumIntr(left, 25, 0);
  output[4] = bitnumIntr(right, 0, 7) | bitnumIntr(left, 0, 6) | bitnumIntr(right, 8, 5) |
    bitnumIntr(left, 8, 4) | bitnumIntr(right, 16, 3) | bitnumIntr(left, 16, 2) |
    bitnumIntr(right, 24, 1) | bitnumIntr(left, 24, 0);
  return output;
}

function fFunction(state: number, key: Uint8Array): number {
  state >>>= 0;
  let first = bitnumIntl(state, 31, 0) | ((state & 0xf0000000) >>> 1) | bitnumIntl(state, 4, 5) |
    bitnumIntl(state, 3, 6) | ((state & 0x0f000000) >>> 3) | bitnumIntl(state, 8, 11) |
    bitnumIntl(state, 7, 12) | ((state & 0x00f00000) >>> 5) | bitnumIntl(state, 12, 17) |
    bitnumIntl(state, 11, 18) | ((state & 0x000f0000) >>> 7) | bitnumIntl(state, 16, 23);
  let second = bitnumIntl(state, 15, 0) | ((state & 0x0000f000) << 15) | bitnumIntl(state, 20, 5) |
    bitnumIntl(state, 19, 6) | ((state & 0x00000f00) << 13) | bitnumIntl(state, 24, 11) |
    bitnumIntl(state, 23, 12) | ((state & 0x000000f0) << 11) | bitnumIntl(state, 28, 17) |
    bitnumIntl(state, 27, 18) | ((state & 0x0000000f) << 9) | bitnumIntl(state, 0, 23);
  first >>>= 0;
  second >>>= 0;

  const expanded = [
    (first >>> 24) & 0xff, (first >>> 16) & 0xff, (first >>> 8) & 0xff,
    (second >>> 24) & 0xff, (second >>> 16) & 0xff, (second >>> 8) & 0xff,
  ];
  for (let index = 0; index < 6; index++) expanded[index] ^= key[index];

  const result = (
    (SBOX[0][sboxBit(expanded[0] >>> 2)] << 28) |
    (SBOX[1][sboxBit(((expanded[0] & 0x03) << 4) | (expanded[1] >>> 4))] << 24) |
    (SBOX[2][sboxBit(((expanded[1] & 0x0f) << 2) | (expanded[2] >>> 6))] << 20) |
    (SBOX[3][sboxBit(expanded[2] & 0x3f)] << 16) |
    (SBOX[4][sboxBit(expanded[3] >>> 2)] << 12) |
    (SBOX[5][sboxBit(((expanded[3] & 0x03) << 4) | (expanded[4] >>> 4))] << 8) |
    (SBOX[6][sboxBit(((expanded[4] & 0x0f) << 2) | (expanded[5] >>> 6))] << 4) |
    SBOX[7][sboxBit(expanded[5] & 0x3f)]
  ) >>> 0;

  return (bitnumIntl(result, 15, 0) | bitnumIntl(result, 6, 1) | bitnumIntl(result, 19, 2) |
    bitnumIntl(result, 20, 3) | bitnumIntl(result, 28, 4) | bitnumIntl(result, 11, 5) |
    bitnumIntl(result, 27, 6) | bitnumIntl(result, 16, 7) | bitnumIntl(result, 0, 8) |
    bitnumIntl(result, 14, 9) | bitnumIntl(result, 22, 10) | bitnumIntl(result, 25, 11) |
    bitnumIntl(result, 4, 12) | bitnumIntl(result, 17, 13) | bitnumIntl(result, 30, 14) |
    bitnumIntl(result, 9, 15) | bitnumIntl(result, 1, 16) | bitnumIntl(result, 7, 17) |
    bitnumIntl(result, 23, 18) | bitnumIntl(result, 13, 19) | bitnumIntl(result, 31, 20) |
    bitnumIntl(result, 26, 21) | bitnumIntl(result, 2, 22) | bitnumIntl(result, 8, 23) |
    bitnumIntl(result, 18, 24) | bitnumIntl(result, 12, 25) | bitnumIntl(result, 29, 26) |
    bitnumIntl(result, 5, 27) | bitnumIntl(result, 21, 28) | bitnumIntl(result, 10, 29) |
    bitnumIntl(result, 3, 30) | bitnumIntl(result, 24, 31)) >>> 0;
}

type DesSchedule = Uint8Array[];

function cryptBlock(input: Uint8Array, key: DesSchedule): Uint8Array {
  let [left, right] = initialPermutation(input);
  for (let index = 0; index < 15; index++) {
    const previousRight = right;
    right = (fFunction(right, key[index]!) ^ left) >>> 0;
    left = previousRight;
  }
  left = (fFunction(right, key[15]!) ^ left) >>> 0;
  return inversePermutation(left, right);
}

function keySchedule(key: Uint8Array, mode: 0 | 1): Uint8Array[] {
  const schedule = Array.from({ length: 16 }, () => new Uint8Array(6));
  const roundShift = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
  const permC = [56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35];
  const permD = [62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3];
  const compression = [
    13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1,
    40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31,
  ];

  let c = 0;
  let d = 0;
  for (let index = 0; index < 28; index++) {
    c += bitnum(key, permC[index]!, 31 - index);
    d += bitnum(key, permD[index]!, 31 - index);
  }
  c >>>= 0;
  d >>>= 0;

  for (let round = 0; round < 16; round++) {
    c = ((c << roundShift[round]!) | (c >>> (28 - roundShift[round]!))) & 0xfffffff0;
    d = ((d << roundShift[round]!) | (d >>> (28 - roundShift[round]!))) & 0xfffffff0;
    c >>>= 0;
    d >>>= 0;
    const targetRound = mode === 0 ? 15 - round : round;

    for (let index = 0; index < 24; index++) {
      schedule[targetRound]![Math.floor(index / 8)] |= bitnumIntr(c, compression[index]!, 7 - (index % 8));
    }
    for (let index = 24; index < 48; index++) {
      schedule[targetRound]![Math.floor(index / 8)] |= bitnumIntr(d, compression[index]! - 27, 7 - (index % 8));
    }
  }
  return schedule;
}

function tripleDesKeySetup(key: Uint8Array, mode: 0 | 1): DesSchedule[] {
  const first = key.subarray(0, 8);
  const second = key.subarray(8, 16);
  const third = key.subarray(16, 24);
  if (mode === 1) return [keySchedule(first, 1), keySchedule(second, 0), keySchedule(third, 1)];
  return [keySchedule(third, 0), keySchedule(second, 1), keySchedule(first, 0)];
}

function tripleDesCrypt(data: Uint8Array, keys: readonly DesSchedule[]): Uint8Array {
  let output = data;
  for (const key of keys) output = cryptBlock(output, key);
  return output;
}

export function tripleDesDecrypt(input: Uint8Array, key: Uint8Array = QRC_KEY): Uint8Array {
  if (key.length < 24 || input.length % 8 !== 0) throw new Error('QRC 数据长度无效');
  const output = new Uint8Array(input.length);
  const keys = tripleDesKeySetup(key, 0);
  for (let offset = 0; offset < input.length; offset += 8) {
    output.set(tripleDesCrypt(input.subarray(offset, offset + 8), keys), offset);
  }
  return output;
}

function hexToBytes(hex: string): Uint8Array {
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('QRC 十六进制数据无效');
  }
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.length; index++) output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return output;
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function decompressQqDeflate(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持 QRC 解压');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('deflate'));
  return bytesToText(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export async function inflateQqText(bytes: Uint8Array, inflater: QqInflater = decompressQqDeflate): Promise<string> {
  let firstError: unknown = null;
  let trailingZeros = 0;
  while (trailingZeros < 7 && bytes.length > trailingZeros && bytes[bytes.length - 1 - trailingZeros] === 0) trailingZeros++;
  for (let trim = 0; trim <= trailingZeros; trim++) {
    try {
      return await inflater(trim ? bytes.subarray(0, bytes.length - trim) : bytes);
    } catch (error) {
      firstError ??= error;
    }
  }
  const detail = firstError instanceof Error && firstError.message !== 'Failed to fetch'
    ? `：${firstError.message}`
    : '';
  throw new Error(`QRC 解压失败${detail}`);
}

function isPlainLyricText(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('<?xml') || /^\[(?:\d{1,3}:|\d+,)/.test(trimmed) || trimmed.includes('\n[');
}

export async function decodeQqLyricBlob(value: string, inflater?: QqInflater): Promise<string> {
  if (!value) return '';
  if (value.length > MAX_QQ_LYRIC_TEXT_LENGTH) throw new Error('QQ 音乐歌词响应过大');
  const trimmed = value.trim();
  if (isPlainLyricText(trimmed)) return value;

  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 16 === 0) {
    return inflateQqText(tripleDesDecrypt(hexToBytes(trimmed)), inflater);
  }

  try {
    const decoded = bytesToText(base64ToBytes(trimmed));
    if (isPlainLyricText(decoded)) return decoded;
    if (/^[0-9a-f]+$/i.test(decoded.trim()) && decoded.trim().length % 16 === 0) {
      return inflateQqText(tripleDesDecrypt(hexToBytes(decoded.trim())), inflater);
    }
    return decoded;
  } catch {
    return value;
  }
}

export function extractQqLyricContent(value: string): string {
  if (!value) return '';
  if (!value.trimStart().startsWith('<?xml')) return value;
  const match = value.match(/<Lyric_1\b[^>]*\bLyricContent=(['"])([\s\S]*?)\1\s*\/>/i);
  if (!match) throw new Error('QQ 音乐返回的 QRC XML 无效');
  if (typeof DOMParser === 'undefined') return match[2]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const xml = new DOMParser().parseFromString(`<QrcText>${match[2]}</QrcText>`, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('QQ 音乐返回的 QRC 内容无效');
  return xml.documentElement.textContent ?? '';
}

export interface QqLyricTrack {
  songmid: string;
  songid: number;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
}

function textToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function buildQqLyricPayload(track: QqLyricTrack): Record<string, unknown> {
  return {
    comm: {
      ct: 11,
      cv: '1003006',
      v: '1003006',
      os_ver: '15',
      phonetype: '24122RKC7C',
      tmeAppID: 'qqmusiclight',
      nettype: 'NETWORK_WIFI',
      udid: '0',
    },
    request: {
      method: 'GetPlayLyricInfo',
      module: 'music.musichallSong.PlayLyricInfo',
      param: {
        songID: track.songid,
        songName: textToBase64(track.title),
        singerName: textToBase64(track.artist),
        albumName: textToBase64(track.album),
        interval: track.durationSeconds,
        qrc: 1,
        qrc_t: 0,
        crypt: 1,
        roma: 1,
        trans: 1,
        type: 0,
      },
    },
  };
}

export function parseQqJson(value: string): unknown {
  const trimmed = value.trim().replace(/^\uFEFF/, '');
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const opening = trimmed.indexOf('(');
    const closing = trimmed.lastIndexOf(')');
    if (opening >= 0 && closing > opening) return JSON.parse(trimmed.slice(opening + 1, closing)) as unknown;
    throw new Error('QQ 音乐返回格式无效');
  }
}
