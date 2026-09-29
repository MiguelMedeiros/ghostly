import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeToWav, encodeWav } from "../../lib/voiceDecode";
import { decoder, installFakeDecoder } from "./fakeMedia";

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
    const wav = await decodeToWav(new Blob(["opus"], { type: "audio/webm" }));
    const view = await header(wav!);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(20_000 * 2);
  });

  it("is null when Web Audio cannot decode it either, or there is no Web Audio", async () => {
    decoder.decodes = false;
    expect(await decodeToWav(new Blob(["?"]))).toBeNull();
    vi.stubGlobal("OfflineAudioContext", undefined);
    decoder.decodes = true;
    expect(await decodeToWav(new Blob(["opus"]))).toBeNull();
  });
});
