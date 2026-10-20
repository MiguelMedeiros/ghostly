import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeToWav, encodeWav } from "../../lib/voiceDecode";
import { decoder, installFakeDecoder, recording } from "./fakeMedia";

// covers: files.voice.play

const header = async (blob: Blob) => new DataView(await blob.arrayBuffer());
const text = (view: DataView, at: number, length: number) => String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(at + i)));

describe("encodeWav", () => {
  it("writes a 16-bit mono PCM WAV any engine plays", async () => {
    const blob = encodeWav(new Float32Array([0, 1, -1, 0.5, 2]), 16_000);
    expect(blob.type).toBe("audio/wav");
    const view = await header(blob);
    expect(text(view, 0, 4)).toBe("RIFF");
    expect(text(view, 8, 8)).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(10);
    expect(view.byteLength).toBe(54);
    // Full scale both ways, and out-of-range samples clipped rather than wrapped.
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 16383, 32767]);
  });
});

describe("decodeToWav", () => {
  beforeEach(() => installFakeDecoder());
  afterEach(() => vi.unstubAllGlobals());

  it("renders what Web Audio decodes as 16 kHz mono", async () => {
    decoder.seconds = 1.25;
    const wav = await decodeToWav(new Blob([recording("chromium.webm")], { type: "audio/webm" }));
    const view = await header(wav!);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(20_000 * 2);
  });

  it("is null when Web Audio cannot decode it either, or there is no Web Audio", async () => {
    decoder.decodes = false;
    expect(await decodeToWav(new Blob(["?"]))).toBeNull();
    vi.stubGlobal("OfflineAudioContext", undefined);
    decoder.decodes = true;
    expect(await decodeToWav(new Blob([recording("chromium.webm")]))).toBeNull();
  });

  it("decodes nothing that plays longer than its description says, or than the longest recording", async () => {
    // A few seconds' worth of bytes may hold an hour at a low enough bitrate: here, 8-byte AAC frames at 8 kHz.
    const frame = [0xff, 0xf1, (1 << 6) | (11 << 2), (1 << 6), 1, 0x1f, 0xfc, 0];
    const hour = new Uint8Array(Array.from({ length: Math.ceil((3600 * 8000) / 1024) }, () => frame).flat());
    expect(await decodeToWav(new Blob([hour], { type: "audio/aac" }), 1_000)).toBeNull();
    expect(await decodeToWav(new Blob([hour], { type: "audio/aac" }))).toBeNull();
    expect(decoder.decoded).toHaveLength(0);
    // One that is as long as it says is decoded, and only its frames reach the decoder.
    const webm = recording("chromium.webm");
    expect(await decodeToWav(new Blob([webm], { type: "audio/webm" }), 1_500)).not.toBeNull();
    expect(decoder.decoded).toHaveLength(1);
    expect(new Uint8Array(decoder.decoded[0]!)).not.toEqual(webm);
  });

  it("decodes something that is not a recording it can count not at all", async () => {
    expect(await decodeToWav(new Blob(["opus"], { type: "audio/webm" }))).toBeNull();
    expect(decoder.decoded).toHaveLength(0);
  });
});
