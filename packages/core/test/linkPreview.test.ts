import { describe, expect, it } from "vitest";
import { LINK_PREVIEW_LIMITS, canonicalUrl, linksIn, parseLinkPreview, sanitizePreviewImage, type LinkPreview } from "../src/linkPreview";
import { MAX_PAIRED_MESSAGE_FRAME, pairedMessageFrame } from "../src/ghostlink";
// covers: chat.link-preview.wire

/** Just enough JPEG for its header: SOI, a baseline frame header, then scan data padded to `padding` bytes. */
function jpeg(width: number, height: number, padding = 0): string {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const bytes = [0xff, 0xd8, ...sof, 0xff, 0xda, 0x00, 0x02, ...new Array(padding).fill(0), 0xff, 0xd9];
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return "data:image/jpeg;base64," + btoa(binary);
}

describe("canonicalUrl", () => {
  it("drops tracking parameters and keeps the others as written", () => {
    expect(canonicalUrl("https://news.example/a?utm_source=x&id=7&utm_medium=y&fbclid=abc#top")).toBe("https://news.example/a?id=7#top");
    expect(canonicalUrl("https://youtu.be/dQw4w9WgXcQ?si=share123")).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(canonicalUrl("https://x.example/?q=a%20b&GCLID=1&page=2")).toBe("https://x.example/?q=a%20b&page=2");
    expect(canonicalUrl("https://Example.COM/Path")).toBe("https://example.com/Path");
  });

  it("names only http(s) links without credentials", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x.example/", "https://user:pw@x.example/", "not a url", `https://x.example/${"a".repeat(5000)}`])
      expect(canonicalUrl(bad), bad.slice(0, 30)).toBeNull();
  });
});

describe("linksIn", () => {
  it("finds the links of a text as the bubble ends them", () => {
    expect(linksIn("see (https://a.example/x), and https://b.example/y.")).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(linksIn("no links here")).toEqual([]);
  });
});

describe("sanitizePreviewImage", () => {
  it("keeps a small JPEG and refuses anything else", () => {
    const good = jpeg(320, 180);
    expect(sanitizePreviewImage(good)).toBe(good);
    for (const bad of [
      undefined, 42, "https://tracker.example/pixel.jpg",
      "data:image/png;base64," + btoa("\x89PNG\r\n\x1a\n"),
      "data:image/svg+xml;base64," + btoa("<svg onload=alert(1)>"),
      "data:image/jpeg;base64,not base64!",
      jpeg(4096, 4096), // a tiny file declaring a huge picture
      jpeg(0, 10),
      jpeg(320, 180, LINK_PREVIEW_LIMITS.imageBytes), // over the byte cap
    ]) expect(sanitizePreviewImage(bad), String(bad).slice(0, 40)).toBeUndefined();
  });
});

describe("parseLinkPreview", () => {
  const text = "look at https://news.example/story?utm_source=feed&id=9 !";
  const preview: LinkPreview = { u: "https://news.example/story?id=9", t: "A story", d: "What happened", s: "News", i: jpeg(320, 180) };

  it("keeps a preview of one of the text's links, compared without tracking parameters", () => {
    expect(parseLinkPreview(preview, text)).toEqual(preview);
    expect(parseLinkPreview({ ...preview, u: "https://news.example/story?id=9&utm_campaign=z" }, text)).toEqual(preview);
  });

  it("drops a preview whose link is not in the text, so a card never points elsewhere", () => {
    expect(parseLinkPreview({ ...preview, u: "https://bank.example/login" }, text)).toBeUndefined();
    expect(parseLinkPreview({ ...preview, u: "https://news.example/story?id=10" }, text)).toBeUndefined();
    expect(parseLinkPreview({ ...preview, u: "javascript:alert(1)" }, "javascript:alert(1)")).toBeUndefined();
  });

  it("drops what is not an object, and a card with nothing but the link", () => {
    for (const bad of [null, "x", 3, [preview], { t: "no link" }, { u: 42 }, { u: preview.u }, { u: preview.u, s: "Only a site" }])
      expect(parseLinkPreview(bad, text)).toBeUndefined();
  });

  it("cuts long texts, flattens them to one line, and drops a bad thumbnail but keeps the rest", () => {
    const parsed = parseLinkPreview({
      ...preview, t: "T".repeat(500), d: "line one\n\n‮line\u0000two", s: 7, i: "data:image/png;base64,AAAA", extra: "ignored",
    }, text)!;
    expect(parsed.t).toHaveLength(LINK_PREVIEW_LIMITS.titleChars);
    expect(parsed.t!.endsWith("…")).toBe(true);
    expect(parsed.d).toBe("line one line two");
    expect(parsed).not.toHaveProperty("s");
    expect(parsed).not.toHaveProperty("i");
    expect(parsed).not.toHaveProperty("extra");
  });
});

describe("the paired-message frame", () => {
  const id = "A".repeat(22);
  const preview: LinkPreview = { u: "https://news.example/", t: "News", i: jpeg(320, 180, 15_000) };

  it("carries the preview as `pv`, next to the fields older apps read", () => {
    const frame = JSON.parse(pairedMessageFrame(id, 5, "https://news.example/", preview));
    expect(frame).toEqual({ t: "paired-message", id, ts: 5, m: "https://news.example/", pv: preview });
    // What an app before previews reads of it is exactly the frame it always got.
    const { t, id: fid, ts, m } = frame;
    expect(JSON.parse(pairedMessageFrame(id, 5, "https://news.example/"))).toEqual({ t, id: fid, ts, m });
    expect(parseLinkPreview(frame.pv, frame.m)).toEqual(preview);
  });

  it("leaves the preview out when the frame would pass what a session takes", () => {
    // Control characters are escaped to six characters each on the wire: 6,000 bytes of text, 36,000 in the frame.
    const long = "https://news.example/ " + "\u0001".repeat(6_000);
    const frame = pairedMessageFrame(id, 5, long, { ...preview, i: jpeg(320, 180, LINK_PREVIEW_LIMITS.imageBytes - 100) });
    expect(frame.length).toBeLessThanOrEqual(MAX_PAIRED_MESSAGE_FRAME);
    expect(JSON.parse(frame)).not.toHaveProperty("pv");
    // A 16 KiB ASCII text with the largest preview still fits.
    const full = pairedMessageFrame(id, 5, "https://news.example/ " + "a".repeat(16_000), { ...preview, i: jpeg(320, 180, LINK_PREVIEW_LIMITS.imageBytes - 100) });
    expect(JSON.parse(full)).toHaveProperty("pv");
  });
});
