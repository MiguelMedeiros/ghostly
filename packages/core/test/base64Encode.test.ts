import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Base64 encoding is on every file transfer's path (each 16 KiB files/3 chunk is base64url), so it uses the runtime's
 * `Uint8Array.prototype.toBase64` where there is one and a table-based encoder where there is not (Node 22 and 24,
 * older WebViews). Both give exactly what the old `btoa` code gave: the wire does not change.
 */

type Bytes = typeof import("../src/bytes");
type Proto = { toBase64?: (this: Uint8Array, options?: { alphabet?: string; omitPadding?: boolean }) => string };
const proto = Uint8Array.prototype as Proto;
const held = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");

/** bytes.ts read fresh, with `toBase64` on the prototype as given (absent: `undefined`). */
async function loadWith(toBase64: Proto["toBase64"]): Promise<Bytes> {
  if (toBase64) Object.defineProperty(Uint8Array.prototype, "toBase64", { value: toBase64, configurable: true, writable: true });
  else delete proto.toBase64;
  vi.resetModules();
  return import("../src/bytes");
}

afterEach(() => {
  if (held) Object.defineProperty(Uint8Array.prototype, "toBase64", held);
  else delete proto.toBase64;
  vi.resetModules();
});

/** Every length from 0 to 300 (each remainder mod 3 many times), then a 16 KiB chunk and an odd 1 MiB. */
function samples(): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let n = 0; n <= 300; n++) out.push(Uint8Array.from({ length: n }, (_, i) => (i * 131 + n * 17) & 255));
  out.push(Uint8Array.from({ length: 16 * 1024 }, (_, i) => (i * 7) & 255));
  out.push(crypto.getRandomValues(new Uint8Array(65_536)));
  const big = new Uint8Array(1024 * 1024 + 1);
  for (let at = 0; at < big.length; at += 65_536) crypto.getRandomValues(big.subarray(at, at + 65_536));
  out.push(big);
  // A view into a larger buffer, as a file chunk read from a block is.
  out.push(big.subarray(5, 5 + 16 * 1024));
  return out;
}

const expected = (b: Uint8Array) => ({ std: Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64"), url: Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64url") });

describe("base64 encoding", () => {
  it("without a native encoder, the table-based one gives the same text as before, padded and unpadded", async () => {
    const { toBase64, toBase64Url, fromBase64, fromBase64Url, bytesEqual } = await loadWith(undefined);
    for (const b of samples()) {
      const want = expected(b);
      expect(toBase64(b)).toBe(want.std);
      expect(toBase64Url(b)).toBe(want.url);
      expect(bytesEqual(fromBase64(toBase64(b)), b)).toBe(true);
      expect(bytesEqual(fromBase64Url(toBase64Url(b)), b)).toBe(true);
    }
  });

  it("uses the runtime's Uint8Array.prototype.toBase64 where there is one", async () => {
    const native = vi.fn(function (this: Uint8Array, options?: { alphabet?: string; omitPadding?: boolean }) {
      const text = Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString(options?.alphabet === "base64url" ? "base64url" : "base64");
      return options?.alphabet === "base64url" && !options.omitPadding ? text.padEnd(Math.ceil(text.length / 4) * 4, "=") : text;
    });
    const { toBase64, toBase64Url } = await loadWith(native);
    const chunk = Uint8Array.from({ length: 16 * 1024 + 1 }, (_, i) => i & 255);
    expect(toBase64Url(chunk)).toBe(expected(chunk).url);
    expect(native).toHaveBeenLastCalledWith({ alphabet: "base64url", omitPadding: true });
    expect(toBase64(chunk)).toBe(expected(chunk).std);
    expect(native).toHaveBeenCalledTimes(2);
  });

  it.runIf(typeof held?.value === "function")("the runtime's own encoder gives the same text as before", async () => {
    const { toBase64, toBase64Url } = await loadWith(held!.value as Proto["toBase64"]);
    for (const b of samples()) {
      expect(toBase64(b)).toBe(expected(b).std);
      expect(toBase64Url(b)).toBe(expected(b).url);
    }
  });
});
