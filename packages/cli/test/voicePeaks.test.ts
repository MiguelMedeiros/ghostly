import { execFileSync } from "node:child_process";
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VOICE_LIMITS, parseVoiceMeta, voicePeaksOf } from "@ghostly/core";
import { VoiceMeter, decodeWithFfmpeg, measureVoice } from "../src/voicePeaks";
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

  // The whole sound was decoded into memory first, and only then refused as too long: a 60-minute MP3 took 2.6 GiB in
  // the daemon (agents#878). The meter keeps the analyser's window only, and the decoding stops past the limit.
  it("the meter over pieces of any size reads exactly what the app's meter reads of the whole", () => {
    const rate = 44_100, left = stepped(rate, 2.345), right = left.map((s) => s * 0.5);
    for (const piece of [1, 7, 1000, 4096, left.length]) {
      const meter = new VoiceMeter();
      meter.start(rate);
      for (let at = 0; at < left.length; at += piece) meter.push([left.subarray(at, at + piece), right.subarray(at, at + piece)], Math.min(piece, left.length - at));
      const mono = new Float32Array(left.length);
      for (const channel of [left, right]) for (let i = 0; i < mono.length; i++) mono[i]! += channel[i]! / 2;
      expect(meter.result()).toEqual({ duration: 2345, peaks: voicePeaksOf(mono, rate) });
    }
  });

  /** The header of an 8 kHz, 8-bit mono WAV with `length` bytes of samples. */
  function head8k(length: number): Buffer {
    const head = Buffer.alloc(44);
    head.write("RIFF", 0); head.writeUInt32LE(36 + length, 4); head.write("WAVE", 8);
    head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
    head.writeUInt32LE(8_000, 24); head.writeUInt32LE(8_000, 28); head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34);
    head.write("data", 36); head.writeUInt32LE(length, 40);
    return head;
  }

  it("stops reading a sound longer than a voice note a little past the limit, and the send refuses its length", async () => {
    // 20 minutes of 8 kHz, 8-bit mono: a small file, longer than any voice note.
    const data = Buffer.alloc(8_000 * 20 * 60, 128);
    for (let i = 0; i < data.length; i += 97) data[i] = 200;
    const path = join(dir, "long.wav");
    writeFileSync(path, Buffer.concat([head8k(data.length), data]));
    const voice = await measured(path);
    expect(voice.duration).toBeGreaterThan(VOICE_LIMITS.maxDurationMs + 5_000);
    expect(voice.duration).toBeLessThanOrEqual(VOICE_LIMITS.maxDurationMs + 6_000);
    expect(parseVoiceMeta(voice, "audio/wav")).toBeUndefined();
  });

  // The whole file was read into the daemon's memory before its kind was known: +190 MiB for a 15-minute WAV, and
  // one past 256 MiB was refused as too large to decode (agents#1577). A WAV is read in pieces, as far as the meter goes.
  it("reads a WAV from the file in pieces, however large the file", async () => {
    const size = 300 * 1024 * 1024;
    const path = join(dir, "huge.wav");
    // All but the header a hole in the file: nothing on the disk.
    writeFileSync(path, head8k(size - 44));
    truncateSync(path, size);
    const voice = await measured(path);
    expect(voice.duration).toBeGreaterThan(VOICE_LIMITS.maxDurationMs + 5_000);
    expect(voice.duration).toBeLessThanOrEqual(VOICE_LIMITS.maxDurationMs + 6_000);
  });

  it.skipIf(!hasFfmpeg)("an MP3 and a sound through ffmpeg stop past the limit too", async () => {
    const mp3 = join(dir, "long.mp3"), flac = join(dir, "long.flac");
    for (const [out, codec] of [[mp3, ["-c:a", "libmp3lame", "-b:a", "8k"]], [flac, ["-c:a", "flac"]]] as const)
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=8000:duration=1200", "-ac", "1", ...codec, out]);
    for (const path of [mp3, flac]) {
      const voice = await measured(path);
      expect(voice.duration).toBeGreaterThan(VOICE_LIMITS.maxDurationMs + 5_000);
      expect(voice.duration).toBeLessThanOrEqual(VOICE_LIMITS.maxDurationMs + 6_000 + 20_000);
    }
  }, 60_000);

  it("says why when it cannot read the sound", async () => {
    const path = join(dir, "noise.m4a");
    writeFileSync(path, Buffer.from("not a sound at all"));
    await expect(decodeWithFfmpeg(path, "ghostly-no-such-ffmpeg")).rejects.toThrow(/install ffmpeg/);
    const result = await measureVoice(path);
    expect(result).toEqual({ problem: expect.any(String) });
  });
});
