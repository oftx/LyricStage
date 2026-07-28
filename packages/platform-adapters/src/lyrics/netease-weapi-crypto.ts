/**
 * NetEase weapi encryption wrapper.
 *
 * Prefers the page's own `asrsea` function (loaded by music-corona.min.js)
 * when available — this guarantees byte-identical output to the real client.
 * Falls back to a local Web Crypto + BigInt RSA implementation for headless
 * contexts where the page script is not loaded.
 */

const WEAPI_PUB_EXP = '010001';
const WEAPI_MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725'
  + '152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312'
  + 'ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424'
  + 'd813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const WEAPI_PRESET_KEY = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const MODULUS_HEX_LEN = 256;
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

type WeapiResult = { readonly params: string; readonly encSecKey: string };

/**
 * Read the page's `asrsea` function from the NetEase SPA iframe (MAIN world).
 * Returns null when not on a NetEase page or the function is missing.
 */
function getPageAsrsea(): ((d: string, e: string, f: string, g: string) => { encText: string; encSecKey: string }) | null {
  try {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[name="contentFrame"]');
    const win = iframe?.contentWindow ?? window;
    const asrseaFn = (win as unknown as Record<string, unknown>).asrsea;
    if (typeof asrseaFn === 'function') {
      return asrseaFn as (d: string, e: string, f: string, g: string) => { encText: string; encSecKey: string };
    }
  } catch { /* cross-origin or missing */ }
  return null;
}

/**
 * Encrypt a JSON string for NetEase `/weapi/` endpoints.
 * Returns `{ params, encSecKey }` for `application/x-www-form-urlencoded` POST.
 */
export async function weapiEncrypt(jsonText: string): Promise<WeapiResult> {
  const pageAsrsea = getPageAsrsea();
  if (pageAsrsea) {
    const result = pageAsrsea(jsonText, WEAPI_PUB_EXP, WEAPI_MODULUS, WEAPI_PRESET_KEY);
    return { params: result.encText, encSecKey: result.encSecKey };
  }
  return localWeapiEncrypt(jsonText);
}

// ---------------------------------------------------------------------------
// Local fallback: Web Crypto AES + BigInt RSA
// ---------------------------------------------------------------------------

function randomSecretKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let key = '';
  for (let i = 0; i < 16; i++) {
    key += CHARS[bytes[i]! % CHARS.length];
  }
  return key;
}

async function aesCbcEncrypt(plaintext: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'AES-CBC' }, false, ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: enc.encode(IV) }, cryptoKey, enc.encode(plaintext),
  );
  return btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
}

function rsaEncrypt(text: string): string {
  let hex = '';
  for (let i = text.length - 1; i >= 0; i--) {
    hex += text.charCodeAt(i).toString(16).padStart(2, '0');
  }
  const base = BigInt('0x' + hex);
  const mod = BigInt('0x' + WEAPI_MODULUS);
  let result = 1n;
  let b = base % mod;
  let e = BigInt(0x10001);
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result.toString(16).padStart(MODULUS_HEX_LEN, '0');
}

async function localWeapiEncrypt(jsonText: string): Promise<WeapiResult> {
  const secretKey = randomSecretKey();
  const firstPass = await aesCbcEncrypt(jsonText, WEAPI_PRESET_KEY);
  const params = await aesCbcEncrypt(firstPass, secretKey);
  const encSecKey = rsaEncrypt(secretKey);
  return { params, encSecKey };
}
