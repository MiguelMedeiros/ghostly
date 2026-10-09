const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Encode(str: string): Uint8Array {
  return textEncoder.encode(str);
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

type NativeToBase64 = (this: Uint8Array, options?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }) => string;
/** `Uint8Array.prototype.toBase64` (Node 25+, Chrome 140+, Firefox 133+, Safari 18.2+): ~200x the JS below. */
const nativeToBase64 = (Uint8Array.prototype as { toBase64?: NativeToBase64 }).toBase64;

const tableOf = (chars: string) => Uint8Array.from(chars, (c) => c.charCodeAt(0));
const BASE64_TABLE = tableOf("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
const BASE64URL_TABLE = tableOf("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_");

/**
 * Base64 where the runtime has no native encoder (Node 22 and 24, older WebViews): the characters go into bytes and
 * become one string at the end. Every file chunk is encoded (files/3 `pf-data`), so this is on a transfer's path.
 */
function encodeBase64(bytes: Uint8Array, table: Uint8Array, pad: boolean): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0, i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = table[n >>> 18];
    out[o++] = table[(n >>> 12) & 63];
    out[o++] = table[(n >>> 6) & 63];
    out[o++] = table[n & 63];
  }
  const rest = bytes.length - i;
  if (rest) {
    const n = (bytes[i] << 16) | (rest === 2 ? bytes[i + 1] << 8 : 0);
    out[o++] = table[n >>> 18];
    out[o++] = table[(n >>> 12) & 63];
    if (rest === 2) out[o++] = table[(n >>> 6) & 63];
    else if (pad) out[o++] = 61; // "="
    if (pad) out[o++] = 61;
  }
  return textDecoder.decode(out.subarray(0, o));
}

export function toBase64(bytes: Uint8Array): string {
  return nativeToBase64 ? nativeToBase64.call(bytes) : encodeBase64(bytes, BASE64_TABLE, true);
}

export function fromBase64(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  return nativeToBase64 ? nativeToBase64.call(bytes, { alphabet: "base64url", omitPadding: true }) : encodeBase64(bytes, BASE64URL_TABLE, false);
}

export function fromBase64Url(str: string): Uint8Array {
  let b = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return fromBase64(b);
}

const Z32_ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";

export function toZ32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += Z32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += Z32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromZ32(str: string): Uint8Array {
  const out = new Uint8Array(Math.floor((str.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of str) {
    const v = Z32_ALPHABET.indexOf(char);
    if (v < 0) throw new Error(`Invalid z-base-32 character: ${char}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
