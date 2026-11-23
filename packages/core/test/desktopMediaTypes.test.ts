import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { safeBlobType } from "../src/files";
import { PLAYABLE_VIDEO } from "../src/video";
import { PLAYABLE_AUDIO } from "../src/voice";
// covers: files.audio.play, files.video.stream

/**
 * On Desktop a stored audio or video file plays from Rust's range server, which types it with `media_type`
 * (apps/desktop/src/file_stream.rs): a type in `MEDIA_TYPES` goes out as itself, anything else as opaque bytes,
 * which WKWebView does not play. The apps give a file a player by `PLAYABLE_AUDIO` / `PLAYABLE_VIDEO`, so the two
 * lists must be the same set, or a file gets a player and is then served as bytes.
 */
const rust = readFileSync(new URL("../../../apps/desktop/src/file_stream.rs", import.meta.url), "utf8");

function mediaTypes(): string[] {
  const list = /const MEDIA_TYPES: &\[&str\] = &\[([^\]]*)\];/.exec(rust)?.[1];
  if (list === undefined) throw new Error("MEDIA_TYPES not found in file_stream.rs");
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

/** Every type a `^top\/(a|b|c)$` pattern takes. */
function typesOf(pattern: RegExp): string[] {
  const parts = /^\^(\w+)\\\/\(([^()]+)\)\$$/.exec(pattern.source);
  if (!parts) throw new Error(`not a plain list of types: ${pattern.source}`);
  return parts[2]!.split("|").map((sub) => `${parts[1]}/${sub}`);
}

describe("Desktop serves every type the apps play as media", () => {
  const served = mediaTypes();
  const playable = [...typesOf(PLAYABLE_AUDIO), ...typesOf(PLAYABLE_VIDEO)];

  it("reads both lists", () => {
    expect(served.length).toBeGreaterThan(10);
    expect(playable).toContain("audio/x-wav");
    expect(playable).toContain("video/quicktime");
  });

  it("serves each playable type as media, not as bytes", () => {
    expect(playable.filter((type) => !served.includes(type))).toEqual([]);
  });

  it("serves nothing as media that the apps do not play", () => {
    expect(served.filter((type) => !playable.includes(type))).toEqual([]);
  });

  it("types each one as the Blob path does: the file's own type, never a renamed one", () => {
    // `media_type` returns the matching entry of MEDIA_TYPES, so an entry served is the type asked for; the Blob a
    // web app or `bytes: true` plays carries `safeBlobType` of the same type. Both hand WebKit the same string.
    for (const type of playable) expect(safeBlobType(type)).toBe(type);
    expect(rust).toMatch(/MEDIA_TYPES\s*\n?\s*\.iter\(\)\s*\n?\s*\.find\(\|known\| \*\*known == essence\)/);
  });
});
