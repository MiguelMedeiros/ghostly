// covers: chat.link-preview.compose, chat.link-preview.render
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_LIMITS } from "@ghostly/core";
import { makeLinkPreview, readPicture } from "../../lib/linkPreviewFetch";
import { pngHead } from "../pngHead";

const CHUNK = 64 * 1024;
const MiB = 1024 * 1024;

/** An answer's body in these first chunks, then `tail` more bytes: what was pulled from it, and whether it was cancelled. */
function served(head: Uint8Array[], tail: number) {
  const chunks = [...head, ...Array.from({ length: Math.ceil(tail / CHUNK) }, (_, i) => new Uint8Array(Math.min(CHUNK, tail - i * CHUNK)))];
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (!next) return controller.close();
      seen.pulled += next.length;
      controller.enqueue(next);
    },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, seen };
}

const png = async (width: number, height: number) => new Uint8Array(await pngHead(width, height).arrayBuffer());
const html = new TextEncoder().encode("<!doctype html><html><head><title>Not a picture</title>");
const ogPage = `<html><head><meta property="og:title" content="Ghosts are real">
  <meta property="og:image" content="https://news.example/p.png"></head><body></body></html>`;

function answers(picture: ReadableStream<Uint8Array>, type = "image/png") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).endsWith(".png")
    ? new Response(picture, { headers: { "content-type": type } })
    : new Response(ogPage, { headers: { "content-type": "text/html" } }));
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("a link's picture is read only as far as its first bytes take it", () => {
  it("stops at a PNG head that says a size no preview takes", async () => {
    const { body, seen } = served([await png(23_000, 23_000)], 4 * MiB);
    answers(body);
    expect(await readPicture("https://pics.example/huge.png", new AbortController().signal)).toBeNull();
    expect(seen.pulled).toBeLessThanOrEqual(IMAGE_LIMITS.headBytes);
    expect(seen.cancelled).toBe(true);
  });

  it("stops at first bytes that are no picture at all", async () => {
    const { body, seen } = served([html], 4 * MiB);
    answers(body);
    expect(await readPicture("https://pics.example/page.png", new AbortController().signal)).toBeNull();
    expect(seen.pulled).toBeLessThanOrEqual(IMAGE_LIMITS.headBytes);
    expect(seen.cancelled).toBe(true);
  });

  it("stops at a page's picture that no preview takes, and the preview goes without it", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const { body, seen } = served([await png(23_000, 23_000)], 4 * MiB);
    answers(body);
    const preview = await makeLinkPreview("https://news.example/story", new AbortController().signal);
    expect(preview).toMatchObject({ t: "Ghosts are real" });
    expect(preview!.i).toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
    expect(seen.pulled).toBeLessThanOrEqual(IMAGE_LIMITS.headBytes);
    expect(seen.cancelled).toBe(true);
  });

  it("reads a picture whose size comes only in a later chunk, and the whole of one a preview takes", async () => {
    // A JPEG: its start and an APP0 segment, then (in the next chunk) the frame header saying 1200 × 630.
    const start = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Uint8Array(14)]);
    const frame = new Uint8Array([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x76, 0x04, 0xb0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    const { body, seen } = served([start, frame], MiB);
    answers(body, "image/jpeg");
    const picture = await readPicture("https://pics.example/fine.png", new AbortController().signal);
    expect(picture?.type).toBe("image/jpeg");
    expect(picture?.size).toBe(start.length + frame.length + MiB);
    expect(seen.cancelled).toBe(false);
  });
});
