import { sha256 } from "@noble/hashes/sha2.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMALL_FILE_BYTES, blobDigest, digestText } from "../src/shared/fileBytes";
// covers: files.storage

/*
 * agents#1765: a file sent through the small path (at most 16 MiB, held in memory) was hashed with noble's SHA-256 on
 * the page's main thread: 16 long tasks of 65-90 ms for 16 MiB on a phone-class CPU, where crypto.subtle takes 62-80 ms.
 */
const bytes = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + (i >> 11)) & 0xff);
const noble = (data: Uint8Array) => digestText(sha256(data));

afterEach(() => vi.restoreAllMocks());

describe("a Blob's digest", () => {
  it("of a file at most SMALL_FILE_BYTES is the platform's, the same hash, read whole once", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    for (const size of [0, 1, 1_000_000, 3 * 1024 * 1024 + 7]) {
      const data = bytes(size), seen: number[] = [];
      expect(await blobDigest(new Blob([data as BlobPart]), (n) => seen.push(n)), String(size)).toBe(noble(data));
      expect(seen.at(-1) ?? 0).toBe(size);
    }
    expect(digest).toHaveBeenCalledTimes(4);
    expect(digest.mock.calls.every(([algorithm]) => algorithm === "SHA-256")).toBe(true);
  });

  it("of a larger one, or without crypto.subtle, is read a step at a time, as before", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const big = new Blob([new Uint8Array(SMALL_FILE_BYTES + 1) as BlobPart]);
    expect(await blobDigest(big)).toBe(noble(new Uint8Array(SMALL_FILE_BYTES + 1)));
    expect(digest).not.toHaveBeenCalled();
    vi.spyOn(globalThis, "crypto", "get").mockReturnValue({} as Crypto);
    const data = bytes(5000);
    expect(await blobDigest(new Blob([data as BlobPart]))).toBe(noble(data));
  });
});
