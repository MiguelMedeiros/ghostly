import { bytesEqual, utf8Decode, utf8Encode } from "./bytes";

/*
 * JSON in its canonical form (RFC 8785, JCS), as WISP 1200 signs and reads it: object keys sorted by their UTF-16 code
 * units, no whitespace, strings and numbers written as ECMAScript's JSON.stringify writes them. A reader never trusts
 * that bytes are canonical: it parses them and writes the value again, and refuses the bytes when the two differ. That
 * one comparison refuses a duplicated key, a key out of order, whitespace, a byte order mark, `1.0` or `1e2`, an
 * escape written another way and an integer past 2^53, so two parsers can never read different values from one text.
 */

/** A value JSON can hold. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** True when `s` holds a lone UTF-16 surrogate, which I-JSON (and so JCS) does not allow. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function write(value: unknown, depth: number): string {
  if (depth > 64) throw new Error("JSON nested deeper than 64 levels");
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new Error("A JSON string holds a lone surrogate");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => write(v, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A member whose value is undefined is left out, as JSON.stringify leaves it out.
    const keys = Object.keys(value).filter((k) => record[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => {
      if (hasLoneSurrogate(k)) throw new Error("A JSON key holds a lone surrogate");
      return `${JSON.stringify(k)}:${write(record[k], depth + 1)}`;
    }).join(",")}}`;
  }
  throw new Error(`Not a JSON value: ${typeof value}`);
}

/** The canonical text of a JSON value. Throws on a value JSON cannot hold (a non-finite number, a lone surrogate). */
export function canonicalJson(value: unknown): string {
  return write(value, 0);
}

/** The canonical UTF-8 bytes of a JSON value. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return utf8Encode(canonicalJson(value));
}

export type CanonicalJsonRefusal = "not-json" | "not-canonical";
export type CanonicalJsonReading = { ok: true; value: JsonValue } | { ok: false; reason: CanonicalJsonRefusal; detail?: string };

/**
 * Reads bytes that must be the canonical form of a JSON value: `not-json` when they are not UTF-8 JSON, `not-canonical`
 * when writing the value again gives other bytes.
 */
export function readCanonicalJson(bytes: Uint8Array): CanonicalJsonReading {
  let value: JsonValue;
  try {
    value = JSON.parse(utf8Decode(bytes)) as JsonValue;
  } catch (error) {
    return { ok: false, reason: "not-json", detail: error instanceof Error ? error.message : String(error) };
  }
  let again: Uint8Array;
  try {
    again = canonicalJsonBytes(value);
  } catch (error) {
    return { ok: false, reason: "not-canonical", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!bytesEqual(again, bytes)) return { ok: false, reason: "not-canonical" };
  return { ok: true, value };
}
