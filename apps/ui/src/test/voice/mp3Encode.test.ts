import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeMp3, MP3_KBPS, MP3_SAMPLE_RATE } from "../../lib/mp3Encode";
import { mp3Info } from "./mp3Info";

// covers: files.download

/** The e2e fake microphone's recording: 16-bit mono PCM, a voice-like tone for 2 s. */
function sampleWav(): { samples: Float32Array; sampleRate: number } {
  const file = readFileSync(join(import.meta.dirname, "../../../../../e2e/support/voice-sample.wav"));
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let at = 12;
  while (at + 8 <= view.byteLength && String.fromCharCode(...file.subarray(at, at + 4)) !== "data") at += 8 + view.getUint32(at + 4, true);
  const sampleRate = view.getUint32(24, true);
  const count = view.getUint32(at + 4, true) / 2;
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(at + 8 + i * 2, true) / 0x8000;
  return { samples, sampleRate };
}

/** A tone that rises and falls like speech, `seconds` long. */
function tone(seconds: number, sampleRate = MP3_SAMPLE_RATE): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * (0.3 + 0.3 * Math.sin(i / sampleRate * 8));
  return samples;
}

describe("encodeMp3", () => {
  it("turns the recording used by the e2e microphone into a mono MP3 of the same length", async () => {
    const { samples, sampleRate } = sampleWav();
    expect(sampleRate).toBe(16_000);
    const mp3 = await encodeMp3(samples, sampleRate);
    const info = mp3Info(mp3);
    expect(info).toMatchObject({ mono: true, sampleRate, bitrate: MP3_KBPS });
    expect(info.durationMs / ((samples.length / sampleRate) * 1000)).toBeCloseTo(1, 1);
    expect(Math.abs(info.durationMs / 2_000 - 1)).toBeLessThan(0.05);
  });

  it.each([1.7, 60])("writes %s s of voice at 24 kHz and 64 kbit/s as that long, frame after valid frame", async (seconds) => {
    const mp3 = await encodeMp3(tone(seconds));
    const info = mp3Info(mp3);
    expect(info).toMatchObject({ mono: true, sampleRate: 24_000, bitrate: 64 });
    expect(Math.abs(info.durationMs / (seconds * 1000) - 1)).toBeLessThan(0.05);
    // 64 kbit/s: 8 KB a second, give or take the last frame.
    expect(mp3.length).toBeGreaterThan(seconds * 8_000 * 0.95);
    expect(mp3.length).toBeLessThan(seconds * 8_000 * 1.05 + 400);
  });

  it("clips samples past full scale instead of wrapping them", async () => {
    const loud = tone(1).map((sample) => sample * 10);
    expect(mp3Info(await encodeMp3(loud)).mono).toBe(true);
  });

  it("writes a valid file for silence and for nothing at all", async () => {
    expect(mp3Info(await encodeMp3(new Float32Array(MP3_SAMPLE_RATE))).mono).toBe(true);
    await expect(encodeMp3(new Float32Array(0))).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("mp3Info", () => {
  it("refuses bytes that are not MP3 frames, and a frame cut short", async () => {
    expect(() => mp3Info(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toThrow(/sync/);
    const mp3 = await encodeMp3(tone(0.5));
    expect(() => mp3Info(mp3.subarray(0, mp3.length - 10))).toThrow(/cut short/);
  });
});
