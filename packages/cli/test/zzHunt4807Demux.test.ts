import { describe, expect, it } from "vitest";
import { demuxOgg, demuxWebm } from "../src/voicePeaks";

const MB = 1024 * 1024;
const SIZE = Number(process.env.HUNT_MB ?? 64) * MB;

function webmVoid(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3, 0x80]);
  // Void elements (0xEC) of size 0: two bytes each.
  for (let at = 5; at + 1 < size; at += 2) { bytes[at] = 0xec; bytes[at + 1] = 0x80; }
  return bytes;
}

function oggEmptyPages(size: number): Uint8Array {
  const page = new Uint8Array(27 + 1 + 19);
  page.set([0x4f, 0x67, 0x67, 0x53]);
  page[26] = 1; page[27] = 19;
  page.set(new TextEncoder().encode("OpusHead"), 28);
  page[28 + 9] = 1;
  const empty = new Uint8Array(27);
  empty.set([0x4f, 0x67, 0x67, 0x53]);
  const bytes = new Uint8Array(size);
  bytes.set(page);
  for (let at = page.length; at + 27 <= size; at += 27) bytes.set(empty, at);
  return bytes;
}

describe("demux time on hostile shapes", () => {
  it("webm of void elements", () => {
    const bytes = webmVoid(SIZE);
    const t = performance.now();
    const out = demuxWebm(bytes);
    console.log(`webm void ${SIZE / MB} MiB: ${Math.round(performance.now() - t)} ms`, out?.frames.length);
    expect(out).toBeNull();
  });
  it("ogg of empty pages", () => {
    const bytes = oggEmptyPages(SIZE);
    const t = performance.now();
    const out = demuxOgg(bytes);
    console.log(`ogg empty pages ${SIZE / MB} MiB: ${Math.round(performance.now() - t)} ms`, out?.frames.length);
    expect(out).not.toBeNull();
  });
});
