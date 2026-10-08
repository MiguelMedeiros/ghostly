import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  appRef, buildAppBundle, canonicalJson, seedSigner, signAppRevocation, signAppStore, toZ32, utf8Encode, type AppManifestDraft, type AppStoreIndex,
  type Signer,
} from "@ghostly/core";
import { APP_FETCH_HOSTS, APP_FETCH_LIMITS } from "../src/engine/appFetch";
import { DEFAULT_STORE_KEY, DEFAULT_STORE_URL } from "../src/engine/appDefaults";
import { STORE_HOSTS, STORE_KEY, STORE_LIMITS, STORE_URL, readStore, slugOf, type StoreBytes } from "../../../apps/website/lib/storeRead";
import { APPS_RELEASE, versionAtLeast } from "../../../apps/website/lib/appsGate";
import * as sync from "../../../apps/website/scripts/sync-store.mjs";
// covers: apps.store

/*
 * The /apps pages on ghostly.tools show the official store as the app reads it: apps/website/lib/storeRead.ts checks
 * the store's bytes with the app's own readers (copied from packages/core by sync-store-core.mjs) and keeps only the
 * versions the app would install. This runs it on the site's test store (apps/website/e2e/fixtures/store), which it also
 * builds: write it again with `WEBSITE_STORE_FIXTURE_WRITE=1 npx vitest run test/websiteStore.test.ts`.
 */

const DIR = new URL("../../../apps/website/e2e/fixtures/store/", import.meta.url);
/** Test keys only: each seed is the SHA-256 of a fixed label. */
const signerOf = (label: string): Signer => seedSigner(sha256(utf8Encode(`ghostly website store fixture: ${label}`)));
const keyOf = (label: string) => toZ32(signerOf(label).publicKey);
/** The fixture's clock, 2026-10-08 00:00 UTC. */
const NOW = 1_791_417_600;
const DAY = 24 * 60 * 60;

/** A real PNG (a ghost-ish disc on a square), so a browser draws the icon the e2e checks. */
function icon(size: number): Uint8Array {
  const rows: number[] = [];
  for (let y = 0; y < size; y++) {
    rows.push(0);
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - size / 2, y - size / 2);
      rows.push(...(d < size * 0.36 ? [232, 237, 245, 255] : [13, 74, 92, 255]));
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...utf8Encode(type), ...data]);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(8 + data.length, crc(body));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, size);
  new DataView(header.buffer).setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Uint8Array.from(rows))), chunk("IEND", new Uint8Array())];
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

const page = (title: string) => ({ path: "index.html", bytes: utf8Encode(`<!doctype html><meta charset=utf-8><title>${title}</title><p>${title}</p>`) });
const base = (name: string, title: string): AppManifestDraft => ({
  name, version: "1.0.0", sequence: 1, kind: "mini-app", title, tagline: `${title}, for the site's tests`, entry: "index.html",
  permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT",
});

const RAW = "https://raw.githubusercontent.com/ghostly-fixtures";
const PINNED = "https://cdn.jsdelivr.net/gh/ghostly-fixtures/notes@0123456789abcdef0123456789abcdef01234567";

/** The test store: two apps shown, and one each removed, revoked, of another version, and from a host the app never reads. */
async function buildFixture() {
  const a = signerOf("publisher a");
  const b = signerOf("publisher b");
  const chess = await buildAppBundle({
    ...base("chess", "Test Chess"), version: "1.0.2", sequence: 3, tagline: "Play chess with a contact, live in your chat",
    description: "A test app for the site's store pages.\nTwo players, one board, moves sent over the chat.",
    homepage: `${RAW}/chess`, releaseNotes: "Clocks for both players.",
  }, [page("Test Chess"), { path: "icon.png", bytes: icon(64) }], a);
  const notes = await buildAppBundle({
    ...base("notes", "Test Notes"), permissions: ["chat", "internet", "name"], view: "full", license: "Apache-2.0",
    description: "Shared notes with a contact. It reaches a server of its own, so it asks for the internet.",
  }, [page("Test Notes")], b);
  const gone = await buildAppBundle(base("gone", "Removed App"), [page("Removed App")], a);
  const revoked = await buildAppBundle(base("revoked", "Revoked App"), [page("Revoked App")], b);
  const old = await buildAppBundle(base("older", "Older App"), [page("Older App")], a);
  const newer = await buildAppBundle({ ...base("older", "Older App"), version: "1.1.0", sequence: 2 }, [page("Older App")], a);
  const elsewhere = await buildAppBundle(base("elsewhere", "Elsewhere App"), [page("Elsewhere App")], b);

  const url = (name: string) => `${RAW}/${name}/HEAD/app.ghostlyapp`;
  const listing = (ref: string, bundle: { digest: string; manifest: { sequence: number; title: string; tagline: string } }, urls: string[], extra = {}) => ({
    ref, sequence: bundle.manifest.sequence, digest: bundle.digest, urls, title: bundle.manifest.title, tagline: bundle.manifest.tagline, ...extra,
  });
  const index: AppStoreIndex = {
    ghostlyStore: 1, key: keyOf("store"), name: "Test Store", description: "The site's test store. Nothing in it is real.", kind: "curated",
    sequence: 7, expires: NOW + 80 * DAY,
    apps: [
      listing(appRef(keyOf("publisher a"), "chess"), chess, [url("chess")], { category: "Games", developer: "Ghostly fixtures", repo: `${RAW}/chess`, support: `${RAW}/chess/issues` }),
      listing(appRef(keyOf("publisher b"), "notes"), notes, [PINNED + "/notes.ghostlyapp"], { category: "Tools" }),
      listing(appRef(keyOf("publisher a"), "gone"), gone, [url("gone")]),
      listing(appRef(keyOf("publisher b"), "revoked"), revoked, [url("revoked")]),
      // The listing names version 2; the URL serves version 1.
      listing(appRef(keyOf("publisher a"), "older"), newer, [url("older")]),
      listing(appRef(keyOf("publisher b"), "elsewhere"), elsewhere, ["https://example.com/elsewhere.ghostlyapp"]),
    ],
    removed: [{ ref: appRef(keyOf("publisher a"), "gone"), digest: gone.digest, reason: "Removed for the test", at: NOW - DAY }],
    revoked: [await signAppRevocation({ ghostlyRevoke: 1, app: appRef(keyOf("publisher b"), "revoked"), upTo: 1 }, b)],
  };
  const { indexBytes, sigBytes } = await signAppStore(index, signerOf("store"));
  const files: Record<string, Uint8Array> = {
    "chess.ghostlyapp": chess.bytes, "notes.ghostlyapp": notes.bytes, "gone.ghostlyapp": gone.bytes, "revoked.ghostlyapp": revoked.bytes,
    "older.ghostlyapp": old.bytes, "elsewhere.ghostlyapp": elsewhere.bytes,
  };
  const meta = {
    about: "The site's test store, made by packages/browser/test/websiteStore.test.ts from test keys. Nothing in it is real.",
    key: keyOf("store"),
    now: NOW,
    bundles: {
      [url("chess")]: "chess.ghostlyapp", [PINNED + "/notes.ghostlyapp"]: "notes.ghostlyapp", [url("gone")]: "gone.ghostlyapp",
      [url("revoked")]: "revoked.ghostlyapp", [url("older")]: "older.ghostlyapp", "https://example.com/elsewhere.ghostlyapp": "elsewhere.ghostlyapp",
    },
  };
  return { indexBytes, sigBytes, files, meta };
}

const read = (name: string) => new Uint8Array(readFileSync(new URL(name, DIR)));
function fixture(): { bytes: StoreBytes; key: string; now: number } {
  const meta = JSON.parse(readFileSync(new URL("fixture.json", DIR), "utf8")) as { key: string; now: number; bundles: Record<string, string> };
  return {
    bytes: { index: read("ghostly-store.json"), sig: read("ghostly-store.sig"), bundles: Object.fromEntries(Object.entries(meta.bundles).map(([u, f]) => [u, read(f)])) },
    key: meta.key,
    now: meta.now,
  };
}

describe("the site's test store", () => {
  it("is the one this test builds", async () => {
    const built = await buildFixture();
    if (process.env.WEBSITE_STORE_FIXTURE_WRITE === "1") {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(new URL("ghostly-store.json", DIR), built.indexBytes);
      writeFileSync(new URL("ghostly-store.sig", DIR), built.sigBytes);
      for (const [name, bytes] of Object.entries(built.files)) writeFileSync(new URL(name, DIR), bytes);
      writeFileSync(new URL("fixture.json", DIR), `${JSON.stringify(built.meta, null, 2)}\n`);
    }
    expect(existsSync(new URL("fixture.json", DIR)), "write it with WEBSITE_STORE_FIXTURE_WRITE=1").toBe(true);
    expect(read("ghostly-store.json")).toEqual(built.indexBytes);
    expect(read("ghostly-store.sig")).toEqual(built.sigBytes);
    for (const [name, bytes] of Object.entries(built.files)) expect(read(name), name).toEqual(bytes);
    expect(JSON.parse(readFileSync(new URL("fixture.json", DIR), "utf8"))).toEqual(built.meta);
  });
});

describe("the site reads a store as the app does", () => {
  it("holds the app's official store, its hosts and its bounds", () => {
    expect(STORE_URL).toBe(DEFAULT_STORE_URL);
    expect(STORE_KEY).toBe(DEFAULT_STORE_KEY);
    expect([...STORE_HOSTS]).toEqual([...APP_FETCH_HOSTS]);
    expect(STORE_LIMITS.indexBytes).toBe(APP_FETCH_LIMITS.storeIndexBytes);
    expect(STORE_LIMITS.sigBytes).toBe(APP_FETCH_LIMITS.sigBytes);
    // The build script reads with the same ones.
    expect(sync.STORE_URL).toBe(DEFAULT_STORE_URL);
    expect(sync.STORE_HOSTS).toEqual([...APP_FETCH_HOSTS]);
    expect(sync.LIMITS).toMatchObject({ indexBytes: STORE_LIMITS.indexBytes, sigBytes: STORE_LIMITS.sigBytes, bundleBytes: STORE_LIMITS.bundleBytes, apps: STORE_LIMITS.apps });
  });

  it("shows the verified versions, and leaves out removed, revoked, mismatched and foreign ones", () => {
    const { bytes, key, now } = fixture();
    const view = readStore(bytes, now, key);
    if (!view.ok) throw new Error(view.reason);
    expect(view).toMatchObject({ name: "Test Store", sequence: 7, expired: false });
    expect(view.apps.map((a) => a.slug)).toEqual([`chess.${keyOf("publisher a").slice(0, 16)}`, `notes.${keyOf("publisher b").slice(0, 16)}`]);
    const [chess, notes] = view.apps;
    expect(chess).toMatchObject({ title: "Test Chess", version: "1.0.2", sequence: 3, permissions: ["chat"], view: "chat", category: "Games", publisher: keyOf("publisher a") });
    expect(chess!.icon?.subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(chess!.fingerprint).toBe(keyOf("publisher a").slice(0, 16).match(/.{4}/g)!.join(" "));
    expect(notes).toMatchObject({ permissions: ["chat", "internet", "name"], view: "full", license: "Apache-2.0" });
    expect(notes!.icon).toBeUndefined();
    expect(notes!.url.startsWith("https://cdn.jsdelivr.net/")).toBe(true);
    expect(Object.fromEntries(view.skipped.map((s) => [s.ref.slice(53), s.reason]))).toEqual({
      gone: "removed", revoked: "revoked", older: "digest", elsewhere: "not-fetched",
    });
  });

  it("past `expires`, still shows the apps and says so", () => {
    const { bytes, key, now } = fixture();
    const view = readStore(bytes, now + 81 * DAY, key);
    expect(view.ok && view.expired && view.apps.length).toBe(2);
  });

  it("refuses the whole store on another key, a changed byte or a broken signature", () => {
    const { bytes, key, now } = fixture();
    expect(readStore(bytes, now, STORE_KEY)).toEqual({ ok: false, reason: "store-key" });
    const text = new TextDecoder().decode(bytes.index);
    expect(text).toContain('"sequence":7}');
    const index = utf8Encode(text.replace('"sequence":7}', '"sequence":8}'));
    expect(readStore({ ...bytes, index }, now, key)).toEqual({ ok: false, reason: "bad-signature" });
    const sig = utf8Encode(canonicalJson({ ...JSON.parse(new TextDecoder().decode(bytes.sig)), sig: "A".repeat(86) }));
    expect(readStore({ ...bytes, sig }, now, key)).toEqual({ ok: false, reason: "bad-signature" });
    expect(readStore({ ...bytes, index: utf8Encode("{}") }, now, key).ok).toBe(false);
  });

  it("leaves out an app whose bundle does not verify", () => {
    const { bytes, key, now } = fixture();
    const [chessUrl] = Object.keys(bytes.bundles);
    const broken = bytes.bundles[chessUrl!]!.slice();
    broken[broken.length - 1] ^= 1;
    const view = readStore({ ...bytes, bundles: { ...bytes.bundles, [chessUrl!]: broken } }, now, key);
    if (!view.ok) throw new Error(view.reason);
    expect(view.apps.map((a) => a.name)).toEqual(["notes"]);
    expect(view.skipped.find((s) => s.ref.endsWith("/chess"))?.reason).toBe("file-hash");
  });

  it("names an app by its store folder, and compares releases by number", () => {
    expect(slugOf(`${DEFAULT_STORE_KEY}/chess`)).toBe("chess.y379ia3t1urwudj8");
    expect(versionAtLeast("1.2.0", APPS_RELEASE)).toBe(true);
    expect(versionAtLeast("1.10.0", APPS_RELEASE)).toBe(true);
    expect(versionAtLeast("2.0.0", APPS_RELEASE)).toBe(true);
    expect(versionAtLeast("1.1.9", APPS_RELEASE)).toBe(false);
    expect(versionAtLeast("1.1.6", APPS_RELEASE)).toBe(false);
    expect(versionAtLeast("1.2.0-rc.1", APPS_RELEASE)).toBe(false);
    expect(versionAtLeast("", APPS_RELEASE)).toBe(false);
  });
});
