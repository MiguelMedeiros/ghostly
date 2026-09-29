import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VOICE_LIMITS, voicePeaksOf } from "@ghostly/core";
import { decodeWithFfmpeg, measureVoice } from "../src/voicePeaks";
// covers: headless.files

/**
 * `file send --voice` measures a file's waveform and length as the apps measure their own recordings. A WAV made
 * here must give exactly what the app's meter (`voicePeaksOf`, packages/core voice.ts) gives for the same samples;
 * the recordings in e2e/support/voice-fixtures (a 1.6 s tone swelling and fading every half second, #214) and the
 * same tone in Ogg and MP3 must show their three dips.
 */
const dir = mkdtempSync(join(tmpdir(), "ghostly-voice-"));
const recordings = join(import.meta.dirname, "../../../e2e/support/voice-fixtures");
const fixtures = join(import.meta.dirname, "fixtures");
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** A sound whose loudness steps through eight levels, then goes quiet: bars that differ from one another. */
function stepped(rate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const step = Math.floor((t / seconds) * 10);
    const gain = step >= 8 ? 0 : [0.05, 0.3, 0.1, 0.02, 0.2, 0.08, 0.15, 0.01][step]!;
    out[i] = gain * Math.sin(2 * Math.PI * 330 * t);
  }
  return out;
}

function wav(format: 1 | 3, bits: number, channels: number, rate: number, samples: number[]): Buffer {
  const width = bits / 8;
  const data = Buffer.alloc(samples.length * width);
  samples.forEach((s, i) => {
    if (format === 3) data.writeFloatLE(s, i * width);
    else data.writeInt16LE(s, i * width);
  });
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(format, 20); head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * channels * width, 28); head.writeUInt16LE(channels * width, 32); head.writeUInt16LE(bits, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

async function measured(path: string) {
  const result = await measureVoice(path);
  if (!("voice" in result)) throw new Error(result.problem);
  return result.voice;
}

/** The tone of the recordings: loud at 0, 0.5, 1 and 1.5 s, quiet between. */
function expectThreeDips(peaks: number[]) {
  expect(peaks).toHaveLength(VOICE_LIMITS.bars);
  expect(Math.max(...peaks)).toBe(255);
  // (Lossy coding moves the quiet bars a little: MP3's lowest is about 130, Opus's about 97.)
  const dips = peaks.map((p) => p < 170).filter((low, i, all) => low && !all[i - 1]).length;
  expect(dips).toBe(3);
  expect(peaks.slice(0, 4).every((p) => p > 200)).toBe(true);
}

describe("a voice note's waveform, measured from its file", () => {
  it("a 16-bit stereo WAV at 44.1 kHz: exactly the app's meter on the same samples", async () => {
    const rate = 44_100;
    const source = stepped(rate, 2.345);
    const ints = Array.from(source, (s) => Math.round(s * 32767));
    const path = join(dir, "stereo.wav");
    // Left and right the same: the channels averaged are the samples themselves.
    writeFileSync(path, wav(1, 16, 2, rate, ints.flatMap((s) => [s, s])));
    const voice = await measured(path);
    expect(voice.duration).toBe(2345);
    expect(voice.peaks).toEqual(voicePeaksOf(Float32Array.from(ints, (s) => s / 32768), rate));
    expect(new Set(voice.peaks).size).toBeGreaterThan(6);
    // Quiet at the end, as the sound is.
    expect(voice.peaks.slice(-10).every((p) => p === 0)).toBe(true);
  });

  it("a float WAV at 48 kHz", async () => {
    const source = stepped(48_000, 3);
    const path = join(dir, "float.wav");
    writeFileSync(path, wav(3, 32, 1, 48_000, [...source]));
    expect(await measured(path)).toEqual({ duration: 3000, peaks: voicePeaksOf(source, 48_000) });
  });

  it("Opus in WebM, as Chromium and the macOS WebView record it", async () => {
    for (const name of ["chromium.webm", "macos-wkwebview.webm"]) {
      const voice = await measured(join(recordings, name));
      expectThreeDips(voice.peaks);
      expect(voice.duration).toBeGreaterThan(1400);
      expect(voice.duration).toBeLessThan(1800);
    }
  });

  it("Opus in Ogg, and MP3", async () => {
    for (const name of ["tone.ogg", "tone.mp3"]) {
      const voice = await measured(join(fixtures, name));
      expectThreeDips(voice.peaks);
      expect(Math.abs(voice.duration - 1500)).toBeLessThan(60);
    }
  });

  // (Not the Ogg file: its last page says where the sound ends, RFC 7845, and ffmpeg keeps the padding after it.)
  it.skipIf(!hasFfmpeg)("decodes Opus as ffmpeg (libopus) does, bar for bar", async () => {
    const path = join(recordings, "chromium.webm");
    const reference = await decodeWithFfmpeg(path);
    expect(await measured(path)).toEqual({ duration: Math.round((reference.mono.length / reference.sampleRate) * 1000), peaks: voicePeaksOf(reference.mono, reference.sampleRate) });
  });

  it.skipIf(!hasFfmpeg)("AAC in MP4 through ffmpeg", async () => {
    const voice = await measured(join(recordings, "macos-wkwebview.m4a"));
    expectThreeDips(voice.peaks);
    expect(Math.abs(voice.duration - 1650)).toBeLessThan(100);
  });

  it("says why when it cannot read the sound", async () => {
    const path = join(dir, "noise.m4a");
    writeFileSync(path, Buffer.from("not a sound at all"));
    await expect(decodeWithFfmpeg(path, "ghostly-no-such-ffmpeg")).rejects.toThrow(/install ffmpeg/);
    const result = await measureVoice(path);
    expect(result).toEqual({ problem: expect.any(String) });
  });
});
