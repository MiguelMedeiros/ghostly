import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AVATAR_MAX_BYTES, IMAGE_HOSTS, IMAGE_REDIRECTS, avatarSource, decodeAvatar, fetchAvatar, PROFILE_AVATAR_SIDE, rasterDimensions } from "../src/profiles/public";
// covers: proofs.public-profile.picture, profiles.picture.sanitize

/**
 * Profile pictures (PUBLIC-PROFILES.md "Pictures"): which bytes are decoded, from which hosts, and why a picture is not
 * shown. The fixtures are real files (e2e/support/avatar-fixtures, a 240×180 gradient made with ImageMagick and
 * cwebp): PNG, JPEG, lossy WebP (`VP8 `), lossless WebP (`VP8L`), extended WebP with alpha (`VP8X`, what the Pubky
 * index serves) and a GIF. Decoding itself is the browser's: here it is stubbed, and every call is counted.
 */
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../../e2e/support/avatar-fixtures/${name}`, import.meta.url)));
const PNG = fixture("avatar.png"), JPEG = fixture("avatar.jpg"), GIF = fixture("avatar.gif");
const WEBP = { lossy: fixture("avatar-lossy.webp"), lossless: fixture("avatar-lossless.webp"), extended: fixture("avatar-extended.webp") };
const SVG = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
const JPEG_DATA = /^data:image\/jpeg;base64,/;

let decoded: ReturnType<typeof vi.fn>;
let drawn: unknown[][];
let canvasSide: number[];
function stubCanvas(blobSize = 4) {
  drawn = []; canvasSide = [];
  decoded = vi.fn(async (blob: Blob) => ({ width: 240, height: 180, type: blob.type, close() {} }));
  vi.stubGlobal("createImageBitmap", decoded);
  vi.stubGlobal("OffscreenCanvas", class {
    constructor(w: number) { canvasSide.push(w); }
    getContext() { return { drawImage: (...args: unknown[]) => drawn.push(args) }; }
    async convertToBlob() { return new Blob([new Uint8Array(blobSize).fill(255)], { type: "image/jpeg" }); }
  });
}
beforeEach(() => stubCanvas());
afterEach(() => vi.unstubAllGlobals());

/** A fetch whose answer says where it came from (`url`, `redirected`), as a browser's does. */
function answering(body: Uint8Array | null, { status = 200, url, redirected = false }: { status?: number; url?: string; redirected?: boolean } = {}) {
  return vi.fn(async (requested: string, _init?: RequestInit) => {
    const r = new Response(body as BodyInit | null, { status });
    Object.defineProperty(r, "url", { value: url ?? requested });
    Object.defineProperty(r, "redirected", { value: redirected });
    return r;
  });
}
const optionsOf = (f: ReturnType<typeof answering>) => f.mock.calls[0][1] as RequestInit;

describe("which pictures are decoded", () => {
  it("reads the dimensions of PNG, JPEG and every kind of WebP from the header, before any decoding", () => {
    expect(rasterDimensions(PNG)).toEqual({ width: 240, height: 180, mime: "image/png" });
    expect(rasterDimensions(JPEG)).toEqual({ width: 240, height: 180, mime: "image/jpeg" });
    for (const webp of Object.values(WEBP)) expect(rasterDimensions(webp)).toEqual({ width: 240, height: 180, mime: "image/webp" });
    for (const other of [GIF, SVG, WEBP.lossy.slice(0, 20)]) expect(rasterDimensions(other)).toBeUndefined();
  });

  it("PNG, JPEG and WebP become a small square JPEG from the middle of the picture, never stretched", async () => {
    for (const bytes of [PNG, JPEG, ...Object.values(WEBP)]) {
      decoded.mockClear();
      const r = await decodeAvatar(bytes, PROFILE_AVATAR_SIDE);
      expect(r.avatar).toMatch(JPEG_DATA);
      expect(r.miss).toBeUndefined();
      expect(decoded).toHaveBeenCalledTimes(1);
    }
    expect(new Set(canvasSide)).toEqual(new Set([PROFILE_AVATAR_SIDE]));
    // 240×180: the middle 180×180 square, drawn onto the whole canvas.
    expect(drawn[0].slice(1)).toEqual([30, 0, 180, 180, 0, 0, PROFILE_AVATAR_SIDE, PROFILE_AVATAR_SIDE]);
    expect((decoded.mock.calls.at(-1)![0] as Blob).type).toBe("image/webp");
  });

  it("a GIF, an SVG, a page or anything else is never decoded, and says what it was", async () => {
    expect(await decodeAvatar(GIF)).toEqual({ miss: "it is a GIF; only PNG, JPEG and WebP pictures are shown" });
    expect(await decodeAvatar(SVG)).toEqual({ miss: "it is an SVG; only PNG, JPEG and WebP pictures are shown" });
    expect((await decodeAvatar(new TextEncoder().encode("<!doctype html><p>hi"))).miss).toContain("a web page");
    expect(decoded).not.toHaveBeenCalled();
  });

  it("too many bytes, or too many pixels by the header, is refused before decoding", async () => {
    expect((await decodeAvatar(new Uint8Array(AVATAR_MAX_BYTES + 1))).miss).toBe("it is larger than 2 MiB");
    const huge = WEBP.extended.slice();
    huge.set([0xff, 0x0f, 0x00], 24); // canvas width 4096
    expect((await decodeAvatar(huge)).miss).toBe("it is 4096 × 180 pixels, more than this app decodes");
    expect(decoded).not.toHaveBeenCalled();
  });

  it("a picture still too large once resized is not kept; one the browser cannot decode says so", async () => {
    stubCanvas(40 * 1024);
    expect((await decodeAvatar(PNG)).miss).toBe("it stays too large once resized");
    stubCanvas();
    decoded.mockRejectedValueOnce(new DOMException("broken", "InvalidStateError"));
    expect((await decodeAvatar(PNG)).miss).toBe("it could not be decoded");
  });
});

describe("where pictures are fetched from", () => {
  it("only https on the fixed hosts; the reason names the host, never the identity", () => {
    expect(avatarSource("https://evil.test/me.png")).toEqual({ miss: "it is on evil.test, a host this app does not load pictures from" });
    expect(avatarSource("https://image.nostr.build.evil.test/a.png")).toMatchObject({ miss: expect.stringContaining("image.nostr.build.evil.test") });
    for (const bad of ["http://image.nostr.build/a.png", "data:image/svg+xml,<svg/>", "not a url", "https://image.nostr.build:8443/a.png", "https://u:p@image.nostr.build/a.png"]) expect(avatarSource(bad)).toHaveProperty("miss");
    expect(avatarSource("https://m.primal.net/Ab.jpg")).toMatchObject({ url: "https://m.primal.net/Ab.jpg", host: "m.primal.net" });
    // Every redirecting host is itself on the list; the places it redirects to are not asked directly.
    for (const [host, to] of Object.entries(IMAGE_REDIRECTS)) { expect(IMAGE_HOSTS.has(host)).toBe(true); for (const t of to) expect(IMAGE_HOSTS.has(t)).toBe(false); }
  });

  it("nostr.build short links are read where they redirect, since the redirect has no CORS header", async () => {
    const f = answering(PNG);
    for (const url of ["https://nostr.build/i/abc.jpg", "https://cdn.nostr.build/i/abc.jpg"]) expect(avatarSource(url)).toMatchObject({ url: "https://image.nostr.build/abc.jpg" });
    const r = await fetchAvatar("https://nostr.build/i/abc.jpg", { fetcher: f as unknown as typeof fetch });
    expect(r.avatar).toMatch(JPEG_DATA);
    expect(f.mock.calls[0][0]).toBe("https://image.nostr.build/abc.jpg");
    expect(r.hosts).toEqual(["image.nostr.build"]);
  });

  it("a picture on another host is never fetched", async () => {
    const f = answering(PNG);
    const r = await fetchAvatar("https://tracker.example/pixel.png", { fetcher: f as unknown as typeof fetch });
    expect(r).toEqual({ miss: "it is on tracker.example, a host this app does not load pictures from", hosts: [] });
    expect(f).not.toHaveBeenCalled();
  });

  it("asks without credentials, cookies or referrer, refusing redirects", async () => {
    const f = answering(WEBP.extended);
    const r = await fetchAvatar("https://image.nostr.build/a.webp", { fetcher: f as unknown as typeof fetch, side: PROFILE_AVATAR_SIDE });
    expect(r.avatar).toMatch(JPEG_DATA);
    expect(optionsOf(f)).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store" });
  });

  it("a redirect from a host that is not expected to redirect is refused (the browser's redirect: error)", async () => {
    const f = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const r = await fetchAvatar("https://i.nostr.build/a.png", { fetcher: f as unknown as typeof fetch });
    expect(r.avatar).toBeUndefined();
    expect(r.miss).toBe("i.nostr.build could not be reached, or redirected elsewhere");
    // Even if a fetch followed it anyway, an answer from another address is not used.
    const followed = answering(PNG, { url: "https://evil.test/a.png", redirected: true });
    expect(await fetchAvatar("https://i.nostr.build/a.png", { fetcher: followed as unknown as typeof fetch })).toEqual({ miss: "i.nostr.build redirected it to evil.test", hosts: ["i.nostr.build"] });
    expect(decoded).not.toHaveBeenCalled();
  });

  it("Primal's hosts redirect to Primal's storage: followed there, and refused anywhere else", async () => {
    const ok = answering(JPEG, { url: "https://r2a.primal.net/uploads2/a/b.jpg", redirected: true });
    const good = await fetchAvatar("https://blossom.primal.net/abc.jpg", { fetcher: ok as unknown as typeof fetch });
    expect(good.avatar).toMatch(JPEG_DATA);
    expect(good.hosts).toEqual(["blossom.primal.net", "r2a.primal.net"]);
    expect(optionsOf(ok).redirect).toBe("follow");
    const bad = answering(JPEG, { url: "https://elsewhere.example/b.jpg", redirected: true });
    expect(await fetchAvatar("https://m.primal.net/Ab.jpg", { fetcher: bad as unknown as typeof fetch })).toEqual({ miss: "m.primal.net redirected it to elsewhere.example", hosts: ["m.primal.net"] });
  });

  it("a failed answer, an oversized download and an unreadable picture each say why", async () => {
    expect((await fetchAvatar("https://pfp.nostr.build/a.png", { fetcher: answering(null, { status: 404 }) as unknown as typeof fetch })).miss).toBe("pfp.nostr.build answered 404");
    const big = answering(new Uint8Array(AVATAR_MAX_BYTES + 10));
    expect((await fetchAvatar("https://pfp.nostr.build/a.png", { fetcher: big as unknown as typeof fetch })).miss).toContain("larger than 2 MiB");
    expect((await fetchAvatar("https://pfp.nostr.build/a.gif", { fetcher: answering(GIF) as unknown as typeof fetch })).miss).toContain("a GIF");
  });
});
