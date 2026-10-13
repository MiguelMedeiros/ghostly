/**
 * An IndexedDB key as bytes whose order is the keys' own (W3C IndexedDB § Compare two keys: a number before a date
 * before a string before binary before an array; strings by UTF-16 code unit; arrays item by item, the shorter
 * first), so that SQLite, comparing them as blobs, sorts and ranges them as IndexedDB does. Held as a "latin1" string
 * (one char per byte): JavaScript compares those in the same order.
 *
 * Every encoding is prefix-free (numbers and dates are 9 bytes; strings, binary and arrays end with a 0 byte no unit or
 * item begins with), so a key followed by another (an index entry's key, then its record's) sorts as the pair does.
 */
const NUMBER = 0x10, DATE = 0x20, STRING = 0x30, BINARY = 0x40, ARRAY = 0x50;

/** The byte after which no encoded key goes on: `key + AFTER` is past every pair that begins with `key`. */
export const AFTER = "\xff";

export function keyBytes(key: unknown): string {
  const out: number[] = [];
  write(key, out, 0);
  let text = "";
  for (let at = 0; at < out.length; at += 8192) text += String.fromCharCode(...out.slice(at, at + 8192));
  return text;
}

function write(key: unknown, out: number[], depth: number): void {
  if (depth > 1000) throw new Error("A key nested too deep");
  if (typeof key === "number") { out.push(NUMBER); number(key, out); return; }
  if (key instanceof Date) { out.push(DATE); number(key.getTime(), out); return; }
  if (typeof key === "string") {
    out.push(STRING);
    // Each code unit from 1 up (0 ends the string, so a shorter string sorts first): one byte below 0x7e (most ids are
    // ASCII), else 0x7f and three bytes, which sort after every one-byte unit as their units do.
    for (let at = 0; at < key.length; at++) {
      const unit = key.charCodeAt(at);
      if (unit < 0x7e) out.push(unit + 1);
      else out.push(0x7f, (unit >> 12) + 1, ((unit >> 6) & 63) + 1, (unit & 63) + 1);
    }
    out.push(0);
    return;
  }
  if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) {
    const bytes = key instanceof ArrayBuffer ? new Uint8Array(key) : new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
    out.push(BINARY);
    for (const byte of bytes) out.push((byte >> 4) + 1, (byte & 15) + 1);
    out.push(0);
    return;
  }
  if (Array.isArray(key)) {
    out.push(ARRAY);
    for (const item of key) write(item, out, depth + 1);
    out.push(0);
    return;
  }
  throw new Error("Not an IndexedDB key");
}

const view = new DataView(new ArrayBuffer(8));
/** A float64 big-endian, its sign bit flipped (a positive number) or every bit flipped (a negative one): bytes in the numbers' order. */
function number(value: number, out: number[]): void {
  view.setFloat64(0, value === 0 ? 0 : value);
  const negative = (view.getUint8(0) & 0x80) !== 0;
  for (let at = 0; at < 8; at++) {
    const byte = view.getUint8(at);
    out.push(negative ? ~byte & 0xff : at === 0 ? byte ^ 0x80 : byte);
  }
}
