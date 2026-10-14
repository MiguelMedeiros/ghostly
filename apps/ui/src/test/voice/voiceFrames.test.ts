import { describe, expect, it } from "vitest";
import { countedRecording, opusSamples } from "../../lib/voiceFrames";
import { recording } from "./fakeMedia";

// covers: files.voice.play

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const box = (type: string, ...parts: Uint8Array[]) => {
  const body = concat(...parts);
  return concat(u32(8 + body.length), new TextEncoder().encode(type), body);
};

/** ADTS frames of AAC-LC, mono, at `rate` (an index: 11 is 8 kHz), each `payload` bytes. */
function adts(frames: number, rate = 11, payload = 1): Uint8Array {
  const length = 7 + payload;
  const frame = new Uint8Array(length);
  frame.set([0xff, 0xf1, (1 << 6) | (rate << 2), (1 << 6) | (length >> 11), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc]);
  const out = new Uint8Array(length * frames);
  for (let i = 0; i < frames; i++) out.set(frame, i * length);
  return out;
}

/** An Ogg stream: OpusHead, OpusTags, then `packets` (each in a page of its own). */
function ogg(packets: Uint8Array[], channels = 1): Uint8Array {
  const head = concat(new TextEncoder().encode("OpusHead"), new Uint8Array([1, channels, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]));
  const page = (packet: Uint8Array) => {
    const lacing: number[] = [];
    let left = packet.length;
    while (left >= 255) { lacing.push(255); left -= 255; }
    lacing.push(left);
    return concat(new TextEncoder().encode("OggS"), new Uint8Array(22), new Uint8Array([lacing.length, ...lacing]), packet);
  };
  return concat(page(head), page(new TextEncoder().encode("OpusTags\0\0\0\0\0\0\0\0")), ...packets.map(page));
}

describe("countedRecording", () => {
  it("counts and rebuilds what every Ghostly records, at the length Web Audio decodes it", async () => {
    // Durations as Chromium decodes the originals (AAC and Ogg are rebuilt without the encoder's priming trim).
    const cases = [["chromium.webm", 1.5], ["macos-wkwebview.webm", 1.7075], ["macos-wkwebview.m4a", 1.7067], ["tone.ogg", 1.52]] as const;
    for (const [name, seconds] of cases) {
      const counted = countedRecording(recording(name), 20);
      expect(counted?.seconds, name).toBeCloseTo(seconds, 3);
      // What the decoder gets reads back as exactly the length counted.
      const again = countedRecording(await bytesOf(counted!.blob), 20);
      expect(again?.seconds, name).toBe(counted!.seconds);
    }
  });

  it("reads an MP4 whose samples are stored in the movie, chunk by chunk, as well as a fragmented one", async () => {
    const stream = await bytesOf(countedRecording(recording("macos-wkwebview.m4a"), 20)!.blob);
    const frames: Uint8Array[] = [];
    for (let at = 0; at < stream.length;) {
      const length = ((stream[at + 3]! & 3) << 11) | (stream[at + 4]! << 3) | (stream[at + 5]! >> 5);
      frames.push(stream.subarray(at + 7, at + length));
      at += length;
    }
    const sizes = frames.map((frame) => frame.length);
    // AAC-LC, 48 kHz, stereo (as recorded): 0x11 0x90. Two chunks of 30 samples, then the rest in a third.
    const esds = box("esds", u32(0), new Uint8Array([0x03, 25, 0, 1, 0, 0x04, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 2, 0x11, 0x90, 0x06, 1, 2]));
    const mp4a = box("mp4a", new Uint8Array(6), new Uint8Array([0, 1]), new Uint8Array(8), new Uint8Array([0, 2, 0, 16, 0, 0, 0, 0, 0xbb, 0x80, 0, 0]), esds);
    const ftyp = box("ftyp", new TextEncoder().encode("M4A "), u32(0));
    const moov = (offset: number) => box("moov", box("trak", box("mdia", box("minf", box("stbl",
      box("stsd", u32(0), u32(1), mp4a),
      box("stsz", u32(0), u32(0), u32(frames.length), ...sizes.map(u32)),
      box("stsc", u32(0), u32(2), u32(1), u32(30), u32(1), u32(3), u32(frames.length - 60), u32(1)),
      box("stco", u32(0), u32(3), u32(offset), u32(offset + sizes.slice(0, 30).reduce((a, b) => a + b, 0)), u32(offset + sizes.slice(0, 60).reduce((a, b) => a + b, 0))),
    )))));
    const head = ftyp.length + moov(0).length + 8;
    const file = concat(ftyp, moov(head), box("mdat", ...frames));
    const counted = countedRecording(file, 20);
    expect(counted?.seconds).toBeCloseTo(1.7067, 3);
    expect(await bytesOf(counted!.blob)).toEqual(stream);
  });

  it("refuses a recording that plays longer than allowed, however few bytes it takes", () => {
    // An hour of AAC at 8 kHz in 2.5 MB of 8-byte frames: gigabytes once Web Audio decodes it.
    const hour = adts(Math.ceil((3600 * 8000) / 1024));
    expect(hour.length).toBeLessThan(2_600_000);
    expect(countedRecording(hour, 6)).toBeNull();
    expect(countedRecording(hour, 3700)?.seconds).toBeCloseTo(3600, 0);
    // An hour of Opus in 120 ms packets of two bytes.
    const packets = Array.from({ length: 30_000 }, () => new Uint8Array([0x1b, 0x02]));
    expect(opusSamples(packets[0]!)).toBe(5760);
    expect(countedRecording(ogg(packets), 6)).toBeNull();
    expect(countedRecording(ogg(packets), 3700)?.seconds).toBeCloseTo(3600, 0);
  });

  it("refuses what it cannot count: other formats, more channels than a voice, trailing bytes", () => {
    expect(countedRecording(new TextEncoder().encode("opus"), 20)).toBeNull();
    expect(countedRecording(new Uint8Array([0xff, 0xe3, 0x18, 0xc4, ...new Uint8Array(68)]), 20)).toBeNull(); // MP3
    const sixChannels = adts(10);
    for (let i = 0; i < 10; i++) { sixChannels[i * 8 + 2] |= 1; sixChannels[i * 8 + 3] = (sixChannels[i * 8 + 3]! & 0x3f) | (2 << 6); }
    expect(countedRecording(sixChannels, 20)).toBeNull();
    expect(countedRecording(ogg([new Uint8Array([0x1b, 0x02])], 6), 20)).toBeNull();
    expect(countedRecording(concat(adts(10), new Uint8Array([1, 2, 3])), 20)).toBeNull();
  });
});
