import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAppBundle, seedSigner, toZ32, utf8Encode } from "@ghostly/core";
import { CHESS_PUBLISHER, FIXTURE_DIR, FIXTURE_ENTRY, FIXTURE_MANIFEST, ROOT, fromBundle, isPinnedUrl } from "../refresh-chess-fixture.mjs";
// covers: apps.chess

/*
 * e2e/fixtures/chess, the pinned Chess the end-to-end tests run (tools/scripts/refresh-chess-fixture.mjs writes it
 * from the bundle Chess's publisher signed in Chess's own repository): chess.json matches index.html.txt and
 * ghostly-app.json and names a bundle pinned to a commit, and the page is one self-contained file that carries what the
 * e2e helpers read. No network here: `refresh-chess-fixture.mjs --check` fetches that bundle and compares the bytes.
 * e2e/fixtures/chess/1.0.2, the last Chess built in this repository, is kept as it was for the update test.
 */

interface Meta {
  name: string; version: string; entry: string; bytes: number; sha256: string; manifestSha256: string;
  from: { source?: string; inputs?: string; bundle?: string; ref?: string; sequence?: number; digest?: string };
}

const dir = join(ROOT, FIXTURE_DIR);
const page = readFileSync(join(dir, FIXTURE_ENTRY), "utf8");
const metaOf = (folder: string) => JSON.parse(readFileSync(join(folder, "chess.json"), "utf8")) as Meta;
const meta = metaOf(dir);

describe.each([["the Chess fixture", dir], ["the Chess 1.0.2 fixture", join(dir, "1.0.2")]])("%s", (_name, folder) => {
  const meta = metaOf(folder);

  it("is the page chess.json describes", () => {
    const bytes = readFileSync(join(folder, FIXTURE_ENTRY));
    expect(meta).toMatchObject({ name: "chess", entry: "index.html", bytes: bytes.length });
    expect(meta.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("carries the manifest chess.json describes, for the same name and version", () => {
    const bytes = readFileSync(join(folder, FIXTURE_MANIFEST));
    expect(meta.manifestSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({ name: meta.name, version: meta.version, entry: "index.html", kind: "mini-app" });
  });
});

describe("the Chess fixture", () => {
  it("came from a bundle Chess's key signed, at a URL that names one commit", () => {
    expect(meta.from.source).toBeUndefined();
    expect(isPinnedUrl(meta.from.bundle!), meta.from.bundle).toBe(true);
    expect(meta.from.ref).toBe(`${CHESS_PUBLISHER}/chess`);
    expect(meta.from.sequence).toBeGreaterThan(0);
    expect(meta.from.digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is a later version than the 1.0.2 kept beside it, and asks for `name` on top of what that one asks", () => {
    const manifest = (folder: string) => JSON.parse(readFileSync(join(folder, FIXTURE_MANIFEST), "utf8")) as { version: string; permissions: string[] };
    const [now, before] = [manifest(dir), manifest(join(dir, "1.0.2"))];
    expect(before).toMatchObject({ version: "1.0.2", permissions: ["chat"] });
    expect(Number(now.version.split(".")[0])).toBeGreaterThan(1);
    expect(now.permissions).toEqual(["chat", "name"]);
  });

  it("is one HTML file with its script and styles inline", () => {
    expect(page).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(page).not.toMatch(/<link\b/i);
    expect(page).not.toMatch(/\b(?:src|href|srcset|action|poster)\s*=/i);
    expect(page).not.toMatch(/type="module"/);
    expect(page.match(/<script\b/g)).toHaveLength(1);
    expect(page.match(/<style\b/g)).toHaveLength(1);
  });

  it("names no address and no way to reach the network outside its license notices", () => {
    const start = page.indexOf("/*!");
    const code = start < 0 ? page : page.slice(0, start) + page.slice(page.indexOf("*/", start) + 2);
    // The SVG namespace its drawn pieces are made in is a name, never fetched.
    expect(code.replaceAll("http://www.w3.org/2000/svg", "")).not.toMatch(/\b(?:https?|wss?):\/\//i);
    expect(code).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|RTCPeerConnection)\b/);
    expect(code).not.toMatch(/\bimport\s*\(/);
  });

  it("runs under the runner's lock: no inline event handler, no script made after start", () => {
    expect(page).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/createElement\(\s*["'`]script["'`]/);
  });

  it("carries the DOM the e2e helpers read (e2e/support/chessApp.ts)", () => {
    for (const name of ["board", "side", "status", "selected", "last", "setup", "invite-btn", "invitation", "accept-invite"]) expect(page).toContain(name);
    expect(page).toContain("dataset.square");
    expect(page).toContain("dataset.piece");
    expect(page).toContain("You play");
  });

  it("stays small", () => {
    expect(Buffer.byteLength(page)).toBeLessThan(320 * 1024);
  });
});

describe("refresh-chess-fixture.mjs", () => {
  let tmp: string;
  const signer = seedSigner(sha256(utf8Encode("ghostly chess fixture test: publisher")));
  const draft = (name: string) => ({
    name, version: "1.2.3", sequence: 4, kind: "mini-app" as const, title: "Chess", tagline: "Play chess with a contact",
    description: "Test.", entry: "index.html", permissions: ["chat" as const], runtime: { host: ">=1.2", clients: ["web" as const] }, license: "MIT",
  });

  beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "chess-fixture-")); });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  async function bundle(name = "chess"): Promise<string> {
    const made = await buildAppBundle(draft(name), [{ path: "index.html", bytes: utf8Encode("<!doctype html><title>Chess</title>") }], signer);
    const file = join(tmp, `${name}-${Math.random().toString(36).slice(2)}.ghostlyapp`);
    writeFileSync(file, made.bytes);
    return file;
  }

  it("takes the entry out of a bundle signed by the key it asks for", async () => {
    const file = await bundle();
    const publisher = toZ32(signer.publicKey);
    const got = await fromBundle(file, publisher);
    expect(got.html.toString("utf8")).toBe("<!doctype html><title>Chess</title>");
    expect(got.meta).toMatchObject({ name: "chess", version: "1.2.3", from: { ref: `${publisher}/chess`, sequence: 4 } });
  });

  it("refuses a bundle another key signed, one that is not Chess, and one changed after signing", async () => {
    await expect(fromBundle(await bundle())).rejects.toThrow(/not Chess's publisher key/);
    await expect(fromBundle(await bundle("checkers"), toZ32(signer.publicKey))).rejects.toThrow(/not "chess"/);
    const file = await bundle();
    const bytes = readFileSync(file);
    bytes[bytes.length - 3] ^= 1;
    writeFileSync(file, bytes);
    await expect(fromBundle(file, toZ32(signer.publicKey))).rejects.toThrow(/not a valid bundle: file-hash/);
  });

  it("takes only a URL that names one commit", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(isPinnedUrl(`https://raw.githubusercontent.com/MiguelMedeiros/ghostly-chess/${commit}/app.ghostlyapp`)).toBe(true);
    expect(isPinnedUrl(`https://cdn.jsdelivr.net/gh/MiguelMedeiros/ghostly-chess@${commit}/app.ghostlyapp`)).toBe(true);
    for (const url of [
      "https://raw.githubusercontent.com/MiguelMedeiros/ghostly-chess/HEAD/app.ghostlyapp",
      "https://raw.githubusercontent.com/MiguelMedeiros/ghostly-chess/main/app.ghostlyapp",
      "https://cdn.jsdelivr.net/gh/MiguelMedeiros/ghostly-chess@main/app.ghostlyapp",
      `http://raw.githubusercontent.com/MiguelMedeiros/ghostly-chess/${commit}/app.ghostlyapp`,
      `https://raw.githubusercontent.com:8443/MiguelMedeiros/ghostly-chess/${commit}/app.ghostlyapp`,
      `https://github.com/MiguelMedeiros/ghostly-chess/releases/download/${commit}/app.ghostlyapp`,
    ]) expect(isPinnedUrl(url), url).toBe(false);
    await expect(fromBundle("https://raw.githubusercontent.com/MiguelMedeiros/ghostly-chess/HEAD/app.ghostlyapp")).rejects.toThrow(/does not name one commit/);
  });
});
