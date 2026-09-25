import { describe, expect, it } from "vitest";
import { safeBlobType } from "../src/files";
import {
  VOICE_LIMITS,
  baseMime,
  downsamplePeaks,
  formatVoiceDuration,
  parseVoiceMeta,
  recordingMime,
  voiceFileName,
} from "../src/voice";
// covers: files.voice.meta

describe("voice metadata", () => {
  const peaks = Array.from({ length: 64 }, (_, i) => i * 4);

  it("keeps a sound description of an audio file", () => {
    expect(parseVoiceMeta({ duration: 12_345, peaks }, "audio/webm")).toEqual({ duration: 12_345, peaks });
    expect(parseVoiceMeta({ duration: 1, peaks: [0] }, "audio/mp4")).toEqual({ duration: 1, peaks: [0] });
    // No type to check against: the caller checks it.
    expect(parseVoiceMeta({ duration: 1000, peaks: [255] })).toEqual({ duration: 1000, peaks: [255] });
  });

  it("copies the peaks, so a caller cannot change what was checked", () => {
    const input = { duration: 1000, peaks: [1, 2, 3] };
    const parsed = parseVoiceMeta(input)!;
    input.peaks.push(999);
    expect(parsed.peaks).toEqual([1, 2, 3]);
  });

  it("drops a description of anything but playable audio", () => {
    for (const mime of ["application/octet-stream", "image/png", "text/html", "audio/x-evil", "video/webm"])
      expect(parseVoiceMeta({ duration: 1000, peaks }, mime)).toBeUndefined();
  });

  it("drops malformed descriptions instead of refusing the file", () => {
    const bad: unknown[] = [
      null, "voice", 42, [], { peaks },
      { duration: 0, peaks }, { duration: -5, peaks }, { duration: 1.5, peaks }, { duration: Number.NaN, peaks },
      { duration: VOICE_LIMITS.maxDurationMs + 60_000, peaks },
      { duration: 1000 }, { duration: 1000, peaks: [] }, { duration: 1000, peaks: "0123" },
      { duration: 1000, peaks: new Array(VOICE_LIMITS.maxBars + 1).fill(1) },
      { duration: 1000, peaks: [256] }, { duration: 1000, peaks: [-1] }, { duration: 1000, peaks: [1.5] }, { duration: 1000, peaks: ["7"] },
    ];
    for (const value of bad) expect(parseVoiceMeta(value, "audio/webm"), JSON.stringify(value)).toBeUndefined();
  });

  it("allows a recorder that stops a moment after the limit", () => {
    expect(parseVoiceMeta({ duration: VOICE_LIMITS.maxDurationMs + 900, peaks: [1] }, "audio/webm")).toBeDefined();
  });
});

describe("waveform peaks", () => {
  it("draws the loudest sample of each stretch, the loudest bar at full height", () => {
    const levels = [0.1, 0.2, 0.4, 0.1, 0.05, 0.05, 0.3, 0.2];
    expect(downsamplePeaks(levels, 4)).toEqual([128, 255, 32, 191]);
  });

  it("gives exactly the bars asked for, whatever the number of samples", () => {
    for (const samples of [1, 3, 63, 64, 65, 1000, 12_345]) {
      const levels = Array.from({ length: samples }, (_, i) => (i % 7) / 10);
      const bars = downsamplePeaks(levels);
      expect(bars).toHaveLength(VOICE_LIMITS.bars);
      expect(bars.every((bar) => Number.isInteger(bar) && bar >= 0 && bar <= 255)).toBe(true);
    }
  });

  it("stretches a short recording instead of leaving empty bars", () => {
    expect(downsamplePeaks([0.5, 1], 4)).toEqual([128, 128, 255, 255]);
  });

  it("keeps silence flat rather than amplifying the noise floor", () => {
    const quiet = downsamplePeaks([0.001, 0.002, 0.001, 0.002], 4);
    expect(Math.max(...quiet)).toBeLessThan(40);
    expect(downsamplePeaks([], 8)).toEqual(new Array(8).fill(0));
  });

  it("ignores values a meter should never produce", () => {
    expect(downsamplePeaks([Number.NaN, 2, -1, Number.POSITIVE_INFINITY], 4)).toEqual([0, 255, 0, 0]);
  });

  it("bounds the number of bars to what a peer accepts", () => {
    expect(downsamplePeaks([0.5], 10_000)).toHaveLength(VOICE_LIMITS.maxBars);
    expect(downsamplePeaks([0.5], 0)).toHaveLength(1);
    // What is drawn is always what a peer takes.
    expect(parseVoiceMeta({ duration: 1000, peaks: downsamplePeaks([0.3, 0.9, 0.1]) }, "audio/webm")).toBeDefined();
  });
});

describe("recording type", () => {
  const only = (...types: string[]) => (type: string) => types.includes(type);

  it("records opus in WebM where the engine can (Chromium, Firefox, Safari 18.4+)", () => {
    expect(recordingMime(only("audio/webm;codecs=opus", "audio/webm", "audio/mp4"))).toEqual({ recorder: "audio/webm;codecs=opus", file: "audio/webm" });
  });

  it("falls back to AAC in MP4 on older WebKit (WKWebView)", () => {
    expect(recordingMime(only("audio/mp4"))).toEqual({ recorder: "audio/mp4", file: "audio/mp4" });
    expect(recordingMime(only("audio/mp4;codecs=mp4a.40.2", "audio/mp4"))).toEqual({ recorder: "audio/mp4;codecs=mp4a.40.2", file: "audio/mp4" });
  });

  it("takes Ogg opus before MP4", () => {
    expect(recordingMime(only("audio/ogg;codecs=opus", "audio/mp4"))).toEqual({ recorder: "audio/ogg;codecs=opus", file: "audio/ogg" });
  });

  it("has nothing to offer an engine that records none of them", () => {
    expect(recordingMime(() => false)).toBeNull();
    expect(recordingMime(() => { throw new Error("no"); })).toBeNull();
  });

  it("sends a type that the file layer keeps and serves as playable", () => {
    for (const type of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"]) {
      const file = recordingMime(only(type))!.file;
      expect(safeBlobType(file)).toBe(file);
      expect(parseVoiceMeta({ duration: 1, peaks: [1] }, file)).toBeDefined();
    }
  });

  it("strips parameters and case", () => {
    expect(baseMime("Audio/WebM; codecs=opus")).toBe("audio/webm");
  });
});

describe("names and times", () => {
  it("names the file for saving, with an extension for its type", () => {
    const ts = new Date(2026, 8, 25, 7, 5, 9).getTime();
    expect(voiceFileName("audio/webm", ts)).toBe("Voice message 2026-09-25 07.05.09.webm");
    expect(voiceFileName("audio/mp4", ts)).toMatch(/\.m4a$/);
    expect(voiceFileName("audio/ogg", ts)).toMatch(/\.ogg$/);
    expect(voiceFileName("audio/unknown", ts)).toMatch(/\.audio$/);
  });

  it("shows minutes and seconds", () => {
    expect(formatVoiceDuration(0)).toBe("0:00");
    expect(formatVoiceDuration(999)).toBe("0:00");
    expect(formatVoiceDuration(7_400)).toBe("0:07");
    expect(formatVoiceDuration(765_000)).toBe("12:45");
    expect(formatVoiceDuration(VOICE_LIMITS.maxDurationMs)).toBe("15:00");
    expect(formatVoiceDuration(-3)).toBe("0:00");
    expect(formatVoiceDuration(Number.NaN)).toBe("0:00");
  });
});

describe("served types", () => {
  it("serves recorded audio with its type, and nothing that could run", () => {
    for (const type of ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac", "audio/wav"]) expect(safeBlobType(type)).toBe(type);
    for (const type of ["audio/svg+xml", "audio/html", "text/html", "video/webm"]) expect(safeBlobType(type)).toBe("application/octet-stream");
  });
});
