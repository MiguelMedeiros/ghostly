import { beforeEach, describe, expect, it, vi } from "vitest";
import { isConvertibleVideo, mp4Name, planVideo, prepareVideo, transcodeBitrate, type VideoProbe } from "../../lib/videoSend";
import { BlobParts } from "../../lib/videoConvert";

// covers: files.video.convert

/** What the fake mediabunny reads and does: set per test. */
const fake = vi.hoisted(() => ({
  format: "video/quicktime" as string | null,
  video: null as null | { type: string; codec: string; codedWidth: number; codedHeight: number; canDecode: () => Promise<boolean> },
  audio: null as null | { type: string; codec: string },
  canEncode: true,
  /** Tracks the conversion would drop. */
  dropped: [] as unknown[],
  /** Throws midway when set. */
  failure: null as Error | null,
  /** `execute` waits for this, when set, until cancelled. */
  hold: false,
  inits: [] as Record<string, unknown>[],
}));

vi.mock("mediabunny", () => {
  class ConversionCanceledError extends Error {}
  class BlobSource { constructor(readonly blob: Blob) {} }
  class Quality { constructor(readonly options: unknown) {} }
  class Mp4OutputFormat {}
  class StreamTarget { constructor(readonly writable: WritableStream<{ type: "write"; data: Uint8Array; position: number }>) {} }
  class Output { target: StreamTarget; constructor(options: { target: StreamTarget }) { this.target = options.target; } }
  class Input {
    async getFormat() { if (!fake.format) throw new Error("unsupported input format"); return { mimeType: fake.format }; }
    async getPrimaryVideoTrack() { return fake.video; }
    async getPrimaryAudioTrack() { return fake.audio; }
    dispose() {}
  }
  class Conversion {
    onProgress?: (progress: number) => void;
    utilizedTracks: unknown[];
    discardedTracks: { track: { type: string }; reason: string }[];
    isValid: boolean;
    private cancelled = false;
    private release = () => {};
    private constructor(private readonly options: { output: Output }) {
      const tracks = [fake.video, fake.audio].filter(Boolean);
      this.utilizedTracks = tracks.filter((t) => !fake.dropped.includes(t));
      this.discardedTracks = tracks.filter((t) => fake.dropped.includes(t)).map((t) => ({ track: t as { type: string }, reason: "no_encodable_target_codec" }));
      this.isValid = this.utilizedTracks.length > 0;
    }
    static async init(options: Record<string, unknown>) { fake.inits.push(options); return new Conversion(options as { output: Output }); }
    async execute() {
      this.onProgress?.(0.4);
      if (fake.hold) await new Promise<void>((resolve) => { this.release = resolve; });
      if (this.cancelled) throw new ConversionCanceledError("cancelled");
      if (fake.failure) throw fake.failure;
      const writer = this.options.output.target.writable.getWriter();
      // As an MP4 is written: a header with its size unknown, the samples, then the size patched in.
      await writer.write({ type: "write", data: new TextEncoder().encode("HEAD????"), position: 0 });
      await writer.write({ type: "write", data: new TextEncoder().encode("samples"), position: 8 });
      await writer.write({ type: "write", data: new TextEncoder().encode("0015"), position: 4 });
      writer.releaseLock();
      this.onProgress?.(1);
    }
    async cancel() { this.cancelled = true; this.release(); }
  }
  return {
    BlobSource, canEncodeVideo: async () => fake.canEncode, Conversion, ConversionCanceledError, Input, MP4: {}, Mp4OutputFormat,
    Output, QTFF: {}, Quality, StreamTarget,
  };
});

const probe = (over: Partial<VideoProbe>): VideoProbe => ({ container: "mov", video: "avc", width: 1920, height: 1080, ...over });
const yes = { decode: true, encode: true };
const mov = (name = "IMG_0001.MOV", type = "video/quicktime") => new File(["iphone video"], name, { type });
const track = (codec: string) => ({ type: "video", codec, codedWidth: 1920, codedHeight: 1080, canDecode: async () => true });

beforeEach(() => {
  Object.assign(fake, { format: "video/quicktime", video: track("avc"), audio: { type: "audio", codec: "aac" }, canEncode: true, dropped: [], failure: null, hold: false, inits: [] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("what a chosen video becomes", () => {
  it("H.264 in a .mov is repackaged into an MP4, not re-encoded", () => {
    expect(planVideo(probe({ container: "mov", video: "avc" }))).toEqual({ kind: "remux" });
  });

  it("H.264 already in an MP4 (or no video track at all) goes as it is", () => {
    expect(planVideo(probe({ container: "mp4", video: "avc" }))).toEqual({ kind: "keep" });
    expect(planVideo(probe({ container: "mov", video: null }))).toEqual({ kind: "keep" });
    expect(planVideo(probe({ container: "mp4", video: "vp9" }))).toEqual({ kind: "keep" });
  });

  it("HEVC, in either container, is re-encoded to H.264 where this device can decode it and encode H.264", () => {
    expect(planVideo(probe({ video: "hevc" }), yes)).toEqual({ kind: "transcode", bitrate: 8_000_000 });
    expect(planVideo(probe({ container: "mp4", video: "hevc", width: 1280, height: 720 }), yes)).toEqual({ kind: "transcode", bitrate: Math.round(8_000_000 * (1280 * 720) / (1920 * 1080)) });
    // ProRes in a .mov plays nowhere but Apple's: the same.
    expect(planVideo(probe({ video: "prores" }), yes).kind).toBe("transcode");
  });

  it("HEVC this device cannot decode, or cannot encode H.264 for, goes as it is, with the note", () => {
    expect(planVideo(probe({ video: "hevc" }), { decode: false, encode: true })).toEqual({ kind: "asIs" });
    expect(planVideo(probe({ video: "hevc" }), { decode: true, encode: false })).toEqual({ kind: "asIs" });
    expect(planVideo(probe({ video: "hevc" }))).toEqual({ kind: "asIs" });
  });

  it("the bitrate follows the picture's area, within 2 and 20 Mbit/s", () => {
    expect(transcodeBitrate(1920, 1080)).toBe(8_000_000);
    expect(transcodeBitrate(3840, 2160)).toBe(20_000_000);
    expect(transcodeBitrate(320, 240)).toBe(2_000_000);
  });

  it("only QuickTime and MP4 videos are looked into, by type or by name when there is no type", () => {
    expect(isConvertibleVideo(mov())).toBe(true);
    expect(isConvertibleVideo(mov("a.mp4", "video/mp4"))).toBe(true);
    expect(isConvertibleVideo(mov("clip.MOV", ""))).toBe(true);
    expect(isConvertibleVideo(mov("clip.webm", "video/webm"))).toBe(false);
    expect(isConvertibleVideo(mov("notes.pdf", "application/pdf"))).toBe(false);
    expect(mp4Name("IMG_0001.MOV")).toBe("IMG_0001.mp4");
    expect(mp4Name("holiday.final.mov")).toBe("holiday.final.mp4");
    expect(mp4Name(".mov")).toBe("video.mp4");
  });
});

describe("prepareVideo", () => {
  it("an H.264 .mov comes back as <name>.mp4, video/mp4, the samples copied (no codec asked for)", async () => {
    const progress: number[] = [];
    const sent = await prepareVideo(mov(), { onProgress: (p) => progress.push(p) });
    expect(sent.asIs).toBeUndefined();
    expect(sent.file.name).toBe("IMG_0001.mp4");
    expect(sent.file.type).toBe("video/mp4");
    // The size written back into its header, where the converter put it.
    expect(await sent.file.text()).toBe("HEAD0015samples");
    expect(fake.inits).toHaveLength(1);
    expect(fake.inits[0]).toMatchObject({ tracks: "primary", video: {} });
    expect(fake.inits[0]!.audio).toBeUndefined();
    expect(progress).toEqual([0.4, 1]);
  });

  it("HEVC this device decodes is re-encoded to H.264 at its bitrate, the audio left to be copied", async () => {
    fake.video = track("hevc");
    const sent = await prepareVideo(mov());
    expect(sent.file.name).toBe("IMG_0001.mp4");
    expect(fake.inits[0]!.video).toMatchObject({ codec: "avc", forceTranscode: true, quality: { options: { bitrate: 8_000_000 } } });
    expect(fake.inits[0]!.audio).toBeUndefined();
  });

  it("HEVC with no decoder here, or no H.264 encoder, is the chosen file, with the note", async () => {
    fake.video = { ...track("hevc"), canDecode: async () => false };
    const chosen = mov();
    expect(await prepareVideo(chosen)).toEqual({ file: chosen, asIs: true });
    fake.video = track("hevc");
    fake.canEncode = false;
    expect(await prepareVideo(chosen)).toEqual({ file: chosen, asIs: true });
    expect(fake.inits).toHaveLength(0);
  });

  it("an error midway, or audio it would have to drop, sends the chosen file, with the note", async () => {
    const chosen = mov();
    fake.failure = new Error("Decoding error.");
    expect(await prepareVideo(chosen)).toEqual({ file: chosen, asIs: true });
    fake.failure = null;
    fake.dropped = [fake.audio];
    expect(await prepareVideo(chosen)).toEqual({ file: chosen, asIs: true });
  });

  it("an MP4 that is H.264, or a file it cannot read as MP4, goes as it is without a note; an unreadable .mov has one", async () => {
    fake.format = "video/mp4";
    const mp4 = mov("clip.mp4", "video/mp4");
    expect(await prepareVideo(mp4)).toEqual({ file: mp4 });
    fake.format = null;
    expect(await prepareVideo(mp4)).toEqual({ file: mp4 });
    const chosen = mov();
    expect(await prepareVideo(chosen)).toEqual({ file: chosen, asIs: true });
    expect(fake.inits).toHaveLength(0);
  });

  it("Cancel stops the conversion: it rejects with an AbortError and nothing is sent", async () => {
    fake.video = track("hevc");
    fake.hold = true;
    const stopper = new AbortController();
    let outcome: unknown = "pending";
    const started = new Promise<void>((resolve) => {
      prepareVideo(mov(), { signal: stopper.signal, onProgress: () => resolve() }).then(
        (sent) => { outcome = sent; },
        (error: unknown) => { outcome = error; },
      );
    });
    await started;
    stopper.abort();
    await vi.waitFor(() => expect(outcome).toBeInstanceOf(DOMException));
    expect((outcome as DOMException).name).toBe("AbortError");
  });

  it("files that are not QuickTime or MP4 videos are not looked into", async () => {
    const webm = mov("clip.webm", "video/webm");
    expect(await prepareVideo(webm)).toEqual({ file: webm });
    expect(fake.inits).toHaveLength(0);
  });
});

describe("BlobParts", () => {
  it("appends, and a write back into what was written replaces that range, across parts", async () => {
    const parts = new BlobParts();
    const bytes = (s: string) => new TextEncoder().encode(s);
    parts.write(0, bytes("aaaa"));
    parts.write(4, bytes("bbbb"));
    parts.write(8, bytes("cccc"));
    parts.write(2, bytes("XXXXXX"));
    parts.write(0, bytes("Z"));
    const file = parts.file("out.mp4");
    expect(await file.text()).toBe("ZaXXXXXXcccc");
    expect(file.type).toBe("video/mp4");
  });

  it("keeps its own copy of what it is handed (the writer may reuse its buffer)", async () => {
    const parts = new BlobParts();
    const buffer = new TextEncoder().encode("abcd");
    parts.write(0, buffer);
    buffer.fill(0);
    expect(await parts.file("x.mp4").text()).toBe("abcd");
  });
});
