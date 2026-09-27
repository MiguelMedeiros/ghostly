import { describe, expect, it } from "vitest";
import { toBase64Url } from "../src/bytes";
import { safeBlobType } from "../src/files";
import { VIDEO_LIMITS, formatVideoDuration, isPlayableVideoType, isVideoMime, parseVideoMeta } from "../src/video";
import { fileMessageText } from "../src/voice";
// covers: files.video.meta

/** Bytes that start like a JPEG. */
const jpeg = (size: number) => { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff, 0xe0]); return toBase64Url(bytes); };

describe("video metadata", () => {
  it("keeps a video's length, size and poster", () => {
    const poster = jpeg(4000);
    expect(parseVideoMeta({ duration: 12_345, width: 1920, height: 1080, poster }, "video/mp4")).toEqual({ duration: 12_345, width: 1920, height: 1080, poster });
    expect(parseVideoMeta({ duration: 1, width: 1, height: 1 }, "video/webm")).toEqual({ duration: 1, width: 1, height: 1 });
    // No type to check against: the caller checks it.
    expect(parseVideoMeta({ duration: 1000, width: 2, height: 2 })).toEqual({ duration: 1000, width: 2, height: 2 });
  });

  it("drops a description of anything but a video", () => {
    for (const mime of ["application/octet-stream", "image/png", "audio/mp4", "text/html"])
      expect(parseVideoMeta({ duration: 1000, width: 2, height: 2 }, mime)).toBeUndefined();
    // Any video type gets its description (and its bubble); whether it plays is the player's question.
    expect(parseVideoMeta({ duration: 1000, width: 2, height: 2 }, "video/x-matroska")).toBeDefined();
  });

  it("drops malformed descriptions instead of refusing the file", () => {
    for (const bad of [null, "x", [], { duration: 0, width: 1, height: 1 }, { duration: -1, width: 1, height: 1 }, { duration: 1.5, width: 1, height: 1 },
      { duration: VIDEO_LIMITS.maxDurationMs + 1, width: 1, height: 1 }, { duration: 1000, width: 0, height: 1 }, { duration: 1000, width: 1, height: VIDEO_LIMITS.maxEdge + 1 },
      { duration: 1000, width: "1", height: 1 }, { duration: 1000 }])
      expect(parseVideoMeta(bad, "video/mp4")).toBeUndefined();
  });

  it("drops a poster that is too large, not a JPEG or not base64url, and keeps the rest", () => {
    const base = { duration: 1000, width: 320, height: 180 };
    const png = toBase64Url(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    for (const poster of [jpeg(VIDEO_LIMITS.maxPosterBytes + 1), png, "not base64!", "", 5, { x: 1 }])
      expect(parseVideoMeta({ ...base, poster }, "video/mp4")).toEqual(base);
    expect(parseVideoMeta({ ...base, poster: jpeg(VIDEO_LIMITS.maxPosterBytes) }, "video/mp4")?.poster).toBeDefined();
  });

  it("serves playable video with its type, and anything else as bytes", () => {
    for (const mime of ["video/mp4", "video/webm", "video/quicktime", "video/ogg", "video/x-m4v"]) expect(safeBlobType(mime)).toBe(mime);
    expect(safeBlobType("video/MP4")).toBe("video/mp4");
    expect(safeBlobType("video/x-matroska")).toBe("application/octet-stream");
    expect(safeBlobType("video/mp4; codecs=avc1")).toBe("application/octet-stream");
  });

  it("knows a video by its type", () => {
    expect(isVideoMime("video/mp4")).toBe(true);
    expect(isVideoMime("VIDEO/webm; codecs=vp9")).toBe(true);
    expect(isVideoMime("audio/mp4")).toBe(false);
    // Shown as a video only when a player may be handed it; Matroska is a file.
    expect(isPlayableVideoType("video/mp4")).toBe(true);
    expect(isPlayableVideoType("video/QuickTime")).toBe(true);
    expect(isPlayableVideoType("video/x-matroska")).toBe(false);
  });

  it("reads its length as a player does, and says it in the chat list", () => {
    expect(formatVideoDuration(7_900)).toBe("0:07");
    expect(formatVideoDuration(765_000)).toBe("12:45");
    expect(formatVideoDuration(3_723_000)).toBe("1:02:03");
    expect(formatVideoDuration(NaN)).toBe("0:00");
    expect(fileMessageText({ name: "clip.mp4", video: { duration: 42_000, width: 2, height: 2 } })).toBe("🎬 Video (0:42)");
    expect(fileMessageText({ name: "clip.mp4" })).toBe("📎 clip.mp4");
  });
});
