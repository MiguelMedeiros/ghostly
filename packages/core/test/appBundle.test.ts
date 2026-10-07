import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  APP_BUNDLE_LIMITS, APP_BUNDLE_MAGIC, APP_PREFIXES, appDigest, buildAppBundle, canonicalJsonBytes, fromBase64Url, isAppLicense, isAppPath,
  isAppUrl, readAppBundle, toBase64Url, utf8Encode, type AppBundleRefusal, type AppManifest,
} from "../src/index";
import {
  DRAFT, ENTRY, appKey, appSigner, byPath, file, fill, fromSegments, handBundle, matchVectorFile, png, toSegments,
  type FileInput, type Segment,
} from "./appVectors";
// covers: apps.bundle

/*
 * The `.ghostlyapp` bundle (WISP 1200 · The package): the canonical manifest, the digest, the `ghostly-app/1`
 * signature and every bound, pinned by `vectors/app-bundle.json`, which this file builds from fixed labels. Write it
 * again with `APPS_VECTORS_WRITE=1 npx vitest run test/appBundle.test.ts`.
 */

const FILE = fileURLToPath(new URL("./vectors/app-bundle.json", import.meta.url));
const publisher = appSigner("publisher");
const other = appSigner("other publisher");

interface Valid { name: string; bytes: Segment[]; sha256: string; length: number; read: { digest: string; manifest: AppManifest } }
interface Invalid { name: string; refusal: AppBundleRefusal; note: string; bytes: Segment[] }
interface Vectors {
  about: Record<string, string>;
  inputs: { keys: Record<string, { label: string; key: string }>; magic: string };
  valid: Valid[];
  invalid: Invalid[];
}

const RAW = "https://raw.githubusercontent.com/ghostly-vectors/chess/HEAD/app.ghostlyapp";
const PINNED = `https://cdn.jsdelivr.net/gh/ghostly-vectors/chess@${"a1b2c3d4e5".repeat(4)}/app.ghostlyapp`;
const SCREENSHOT = png(1280, 720);
const ICON = png(256, 256);

/** A string of exactly `n` code points, with characters past one UTF-16 unit and past one byte. */
const text = (n: number, lines = false) => Array.from({ length: n }, (_, i) => (lines && i % 50 === 49 ? "\n" : ["a", "é", "♞", "😀"][i % 4]!)).join("");
/** A path of exactly 128 bytes. */
const LONG_PATH = `data/${"p".repeat(APP_BUNDLE_LIMITS.pathBytes - "data/".length - ".json".length)}.json`;

function limitFiles(): FileInput[] {
  const files: FileInput[] = [ENTRY, file("icon.png", png(256, 256, APP_BUNDLE_LIMITS.iconBytes)), file(LONG_PATH, "{}")];
  for (let i = 1; i <= APP_BUNDLE_LIMITS.screenshots; i++) files.push(file(`screenshots/${i}.png`, SCREENSHOT));
  for (let i = files.length; i < APP_BUNDLE_LIMITS.files; i++) files.push(file(`data/level-${String(i).padStart(2, "0")}.json`, `{"level":${i}}`));
  return files;
}
const LIMIT_FIELDS = {
  title: text(APP_BUNDLE_LIMITS.title),
  tagline: text(APP_BUNDLE_LIMITS.tagline),
  description: text(APP_BUNDLE_LIMITS.description, true),
  releaseNotes: text(APP_BUNDLE_LIMITS.releaseNotes),
  sources: Array.from({ length: APP_BUNDLE_LIMITS.sources }, (_, i) => `https://example.org/${i}/${"s".repeat(APP_BUNDLE_LIMITS.url - "https://example.org/0/".length)}`),
};

/** The 16 MiB bundle: the entry and one data file whose size makes the whole exactly the bound. */
async function largest(): Promise<Uint8Array> {
  let size = 16_000_000;
  for (;;) {
    const { bytes } = await buildAppBundle(DRAFT, [ENTRY, file("data/big.bin", fill(size))], publisher);
    if (bytes.length === APP_BUNDLE_LIMITS.bundleBytes) return bytes;
    size += APP_BUNDLE_LIMITS.bundleBytes - bytes.length;
  }
}

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const join = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const MAGIC = utf8Encode(APP_BUNDLE_MAGIC);

async function build(): Promise<Vectors> {
  const valid: Valid[] = [];
  const addValid = (name: string, bytes: Uint8Array) => {
    const read = readAppBundle(bytes);
    if (!read.ok) throw new Error(`${name}: ${read.reason} ${read.detail ?? ""}`);
    valid.push({ name, bytes: toSegments(bytes), sha256: bytesToHex(sha256(bytes)), length: bytes.length, read: { digest: read.bundle.digest, manifest: read.bundle.manifest } });
  };
  addValid("the entry only", (await buildAppBundle(DRAFT, [ENTRY], publisher)).bytes);
  addValid("an icon, screenshots, data files and every optional field", (await buildAppBundle({
    ...DRAFT, version: "1.2.0-beta.1+build.7", sequence: 7, permissions: ["chat", "name"], runtime: { host: ">=1.2.0", clients: ["web", "desktop", "extension"] },
    license: "(MIT OR Apache-2.0) AND LicenseRef-chess-art", description: "Chess for two.\nMoves are checked on both sides.",
    sources: [RAW, PINNED], proofs: [], homepage: "https://example.org/chess", support: "https://example.org/chess/issues", releaseNotes: "Castling fixed.",
  }, [ENTRY, file("icon.png", ICON), file("screenshots/1.png", SCREENSHOT), file("screenshots/2.jpg", fill(32, 7)), file("data/openings.json", "[\"e4\",\"d4\"]")], publisher)).bytes);
  addValid("every bound at its limit: 64 files, a 128-byte path, a 256 KiB icon, 8 screenshots, the longest texts and 8 sources", (await buildAppBundle({ ...DRAFT, ...LIMIT_FIELDS }, limitFiles(), publisher)).bytes);
  addValid("an app that asks for the internet", (await buildAppBundle({ ...DRAFT, permissions: ["internet"] }, [ENTRY], publisher)).bytes);
  addValid("a version with no permission and the proprietary licence", (await buildAppBundle({ ...DRAFT, permissions: [], license: "proprietary" }, [ENTRY], publisher)).bytes);
  const big = await largest();
  addValid("a whole bundle of exactly 16 MiB", big);

  const invalid: Invalid[] = [];
  const no = (name: string, refusal: AppBundleRefusal, note: string, bytes: Uint8Array) => invalid.push({ name, refusal, note, bytes: toSegments(bytes) });
  const hand = (fields: Record<string, unknown>, files: FileInput[] = [ENTRY], options?: Parameters<typeof handBundle>[2]) => handBundle({ ...DRAFT, ...fields }, files, options);
  const good = (await buildAppBundle(DRAFT, [ENTRY], publisher)).bytes;

  // The framing.
  no("one byte past 16 MiB", "too-large", "The size is checked before anything is read", join(big, new Uint8Array([0])));
  no("a wrong magic", "magic", "GHOSTLYAPP2", join(utf8Encode("GHOSTLYAPP2"), good.subarray(MAGIC.length)));
  no("an empty file", "truncated", "Nothing after nothing", new Uint8Array(0));
  no("the magic alone", "truncated", "No manifest length", MAGIC);
  no("a manifest length past 64 KiB", "manifest-too-large", "Refused from the length, before reading", join(MAGIC, u32(APP_BUNDLE_LIMITS.manifestBytes + 1), fill(16)));
  no("cut inside the manifest", "truncated", "Ends early", good.subarray(0, 40));
  no("cut inside the entry", "truncated", "The files' sizes ask for more bytes than are left", good.subarray(0, good.length - 1));
  no("a byte past the last file", "trailing-bytes", "No byte may follow the last file", join(good, new Uint8Array([0x0a])));

  // The manifest's bytes.
  const manifest = { ghostlyApp: 1, publisher: appKey("publisher"), files: [{ path: ENTRY.path, size: ENTRY.bytes.length, sha256: toBase64Url(sha256(ENTRY.bytes)) }], ...DRAFT };
  const canonical = new TextDecoder().decode(canonicalJsonBytes(manifest));
  no("a manifest with whitespace", "not-canonical", "Pretty-printed JSON", await hand({}, [ENTRY], { manifestBytes: utf8Encode(JSON.stringify(JSON.parse(canonical), null, 1)) }));
  no("a manifest with its keys out of order", "not-canonical", "`version` before `title`", await hand({}, [ENTRY], { manifestBytes: utf8Encode(JSON.stringify(manifest)) }));
  no("a duplicated key", "not-canonical", "`name` twice: the canonical form keeps one", await hand({}, [ENTRY], { manifestBytes: utf8Encode(canonical.replace("\"name\":\"chess\"", "\"name\":\"chess\",\"name\":\"chesz\"")) }));
  no("a number written as 1.0", "not-canonical", "\"sequence\":1.0", await hand({}, [ENTRY], { manifestBytes: utf8Encode(canonical.replace("\"sequence\":1", "\"sequence\":1.0")) }));
  no("a byte order mark", "not-canonical", "EF BB BF before the JSON", await hand({}, [ENTRY], { manifestBytes: join(new Uint8Array([0xef, 0xbb, 0xbf]), utf8Encode(canonical)) }));
  no("a manifest that is not UTF-8", "not-json", "A lone 0xFF byte", await hand({}, [ENTRY], { manifestBytes: new Uint8Array([0x7b, 0xff, 0x7d]) }));
  no("a manifest that is not JSON", "not-json", "Text", await hand({}, [ENTRY], { manifestBytes: utf8Encode("chess") }));

  // Keys.
  no("format version 2", "unsupported-format", "A later format raises ghostlyApp", await hand({ ghostlyApp: 2 }));
  no("an unknown key", "unknown-key", "`category` is a store's field, not a manifest's", await hand({ category: "games" }));
  no("a price", "reserved-key", "`price` is phase 2", await hand({ price: { amount: 1000, unit: "sat", seller: "https://example.org" } }));
  no("a recovery key", "reserved-key", "`recovery` is reserved", await hand({ recovery: appKey("recovery") }));
  const { title: _title, ...untitled } = DRAFT;
  no("no title", "missing-key", "`title` is required", await handBundle(untitled, [ENTRY]));
  no("publisher proofs", "proofs-unsupported", "Proofs come after phase 1; an empty list is allowed", await hand({ proofs: [{ kind: "github-ssh", login: "ana" }] }));

  // Fields.
  no("a publisher key that is not canonical z-base32", "bad-field", "The last character carries bits past the key", await handBundle({ ...DRAFT }, [ENTRY], { manifestBytes: canonicalJsonBytes({ ...manifest, publisher: `${appKey("publisher").slice(0, 51)}9` }) }));
  no("a name with a capital", "bad-field", "^[a-z][a-z0-9-]{0,31}$", await hand({ name: "Chess" }));
  no("a version that is not semantic", "bad-field", "1.0", await hand({ version: "1.0" }));
  no("sequence 0", "bad-field", "A sequence starts at 1", await hand({ sequence: 0 }));
  no("a sequence past 2^53", "bad-field", "Integers stay exact in every parser", await hand({ sequence: 2 ** 53 }));
  no("another kind", "bad-field", "`mini-app` only in phase 1", await hand({ kind: "theme" }));
  no("an empty title", "bad-field", "A title has at least one character", await hand({ title: "" }));
  no("a title one character too long", "bad-field", "41 code points", await hand({ title: text(APP_BUNDLE_LIMITS.title + 1) }));
  no("a title of two lines", "bad-field", "No control character", await hand({ title: "Chess\nfor two" }));
  no("a tagline one character too long", "bad-field", "81 code points", await hand({ tagline: text(APP_BUNDLE_LIMITS.tagline + 1) }));
  no("a description one character too long", "bad-field", "2001 code points", await hand({ description: text(APP_BUNDLE_LIMITS.description + 1) }));
  no("release notes one character too long", "bad-field", "501 code points", await hand({ releaseNotes: text(APP_BUNDLE_LIMITS.releaseNotes + 1) }));
  no("an unknown permission", "bad-field", "`network` is a later phase's", await hand({ permissions: ["chat", "network"] }));
  no("a permission twice", "bad-field", "Unique", await hand({ permissions: ["chat", "chat"] }));
  no("a runtime with no client", "bad-field", "At least one of web, desktop, extension", await hand({ runtime: { host: ">=1.2", clients: [] } }));
  no("a host range that is not >=", "bad-field", "^1.2", await hand({ runtime: { host: "^1.2", clients: ["web"] } }));
  no("a licence that is not an SPDX expression", "bad-field", "MIT AND", await hand({ license: "MIT AND" }));
  no("a source over http", "bad-field", "https only", await hand({ sources: ["http://example.org/app.ghostlyapp"] }));
  no("a jsDelivr source on a branch", "bad-field", "A jsDelivr URL names a full commit", await hand({ sources: ["https://cdn.jsdelivr.net/gh/ghostly-vectors/chess@main/app.ghostlyapp"] }));
  no("a jsDelivr source at latest", "bad-field", "A jsDelivr URL names a full commit", await hand({ sources: ["https://cdn.jsdelivr.net/gh/ghostly-vectors/chess@latest/app.ghostlyapp"] }));
  no("nine sources", "bad-field", "At most 8", await hand({ sources: Array.from({ length: 9 }, (_, i) => `https://example.org/${i}`) }));
  no("a homepage with a password", "bad-field", "No user or password in a URL", await hand({ homepage: "https://ana:secret@example.org/" }));

  // Files.
  const sixtyFive = [...limitFiles(), file("data/one-more.json", "{}")];
  no("65 files", "too-many-files", "At most 64", await hand({}, byPath(sixtyFive)));
  no("a path of 129 bytes", "bad-path", "At most 128 bytes", await hand({}, [file(`${LONG_PATH}x`, "{}"), ENTRY]));
  no("a path with ..", "bad-path", "No . or .. segment", await hand({}, [file("data/../index.html", "x"), ENTRY]));
  no("a path with an empty segment", "bad-path", "data//a.json", await hand({}, [file("data//a.json", "x"), ENTRY]));
  no("an absolute path", "bad-path", "/index.html", await hand({ entry: "/index.html" }, [file("/index.html", "x")]));
  no("a path with a space", "bad-path", "[A-Za-z0-9._-] per segment", await hand({}, [file("data/a b.json", "x"), ENTRY]));
  no("two paths equal ignoring case", "path-collision", "Index.html and index.html", await hand({}, [file("Index.html", "x"), ENTRY]));
  no("files out of order", "files-unsorted", "Sorted by path", await hand({}, [ENTRY, file("data/a.json", "{}")]));
  no("nine screenshots", "too-many-screenshots", "At most 8", await hand({}, byPath([ENTRY, ...Array.from({ length: 9 }, (_, i) => file(`screenshots/${i}.png`, SCREENSHOT))])));
  no("a screenshot that is not a picture type", "bad-path", "screenshots/ holds .png, .jpg or .webp", await hand({}, [ENTRY, file("screenshots/1.gif", SCREENSHOT)]));
  no("an icon one byte past 256 KiB", "bad-icon", "From the manifest's size", await hand({}, [file("icon.png", png(256, 256, APP_BUNDLE_LIMITS.iconBytes + 1)), ENTRY]));
  no("an icon that is not square", "bad-icon", "256 × 128", await hand({}, [file("icon.png", png(256, 128)), ENTRY]));
  no("an icon that is not a PNG", "bad-icon", "Zeros", await hand({}, [file("icon.png", fill(64)), ENTRY]));
  no("an entry that is not HTML", "bad-entry", "The entry is one .html file", await hand({ entry: "main.js" }, [ENTRY, file("main.js", "1")]));
  no("an entry the bundle does not hold", "bad-entry", "play.html is not in files", await hand({ entry: "play.html" }));
  no("a file one byte larger than listed", "trailing-bytes", "The signed size says 1 byte less than the bytes that follow", await hand({ files: [{ path: ENTRY.path, size: ENTRY.bytes.length - 1, sha256: toBase64Url(sha256(ENTRY.bytes)) }] }, [ENTRY]));
  no("a file one byte smaller than listed", "truncated", "The signed size says 1 byte more", await hand({ files: [{ path: ENTRY.path, size: ENTRY.bytes.length + 1, sha256: toBase64Url(sha256(ENTRY.bytes)) }] }, [ENTRY]));
  no("a wrong file hash", "file-hash", "The entry's bytes changed after signing", await hand({ files: [{ path: ENTRY.path, size: ENTRY.bytes.length, sha256: toBase64Url(sha256(utf8Encode("another entry"))) }] }, [file("index.html", ENTRY.bytes)]));
  const swapped = join(good.subarray(0, good.length - 1), new Uint8Array([good[good.length - 1]! ^ 1]));
  no("the entry's last byte changed", "file-hash", "One bit of the file", swapped);

  // The signature.
  no("a statement that is not canonical", "bad-signature-statement", "Spaces in the statement", await hand({}, [ENTRY], { statementBytes: utf8Encode(`{"alg": "ed25519", "key": "${appKey("publisher")}", "sig": "${"A".repeat(86)}"}`) }));
  no("a statement with another algorithm", "bad-signature-statement", "alg is ed25519", await hand({}, [ENTRY], { statementBytes: canonicalJsonBytes({ alg: "ed448", key: appKey("publisher"), sig: "A".repeat(86) }) }));
  no("a signature by another key, named", "signature-key", "The statement names a key that is not the publisher", await handBundle(manifest, [ENTRY], { signer: other }));
  no("a signature by another key, under the publisher's name", "bad-signature", "Signed by another key, with the publisher's key in the statement", await handBundle(manifest, [ENTRY], { signer: other, statementKey: appKey("publisher") }));
  no("a signature under another prefix", "bad-signature", "Signed as ghostly-store/1", await hand({}, [ENTRY], { prefix: APP_PREFIXES.store }));
  const flipped = new Uint8Array(good);
  const sigAt = MAGIC.length + 4 + new DataView(good.buffer).getUint32(MAGIC.length) + 4 + `{"alg":"ed25519","key":"${appKey("publisher")}","sig":"`.length;
  flipped[sigAt] = flipped[sigAt] === 0x41 ? 0x42 : 0x41;
  no("a bad signature", "bad-signature", "One character of the signature changed", flipped);
  // The same signature with S + L: a scalar that is not reduced is refused by every Ed25519 reader.
  const stmtAt = MAGIC.length + 4 + new DataView(good.buffer).getUint32(MAGIC.length);
  const statement = JSON.parse(new TextDecoder().decode(good.subarray(stmtAt + 4, stmtAt + 4 + new DataView(good.buffer).getUint32(stmtAt)))) as { alg: string; key: string; sig: string };
  const sig = fromBase64Url(statement.sig);
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]!);
  s += 2n ** 252n + 27742317777372353535851937790883648493n;
  for (let i = 0; i < 32; i++) { sig[32 + i] = Number(s & 0xffn); s >>= 8n; }
  no("a signature whose scalar is not reduced", "bad-signature", "S + L in place of S", await hand({}, [ENTRY], { statementBytes: canonicalJsonBytes({ ...statement, sig: toBase64Url(sig) }) }));

  return {
    about: {
      pins: "The .ghostlyapp bundle, the canonical manifest (RFC 8785), the digest and the ghostly-app/1 signature",
      wisp: "WISP 1200, The package and Test vectors",
      test: "packages/core/test/appBundle.test.ts (APPS_VECTORS_WRITE=1 writes this file again)",
      bytes: "A list of segments to concatenate: {hex} as is, {fill, size} one byte repeated",
    },
    inputs: { keys: { publisher: { label: "publisher", key: appKey("publisher") }, other: { label: "other publisher", key: appKey("other publisher") } }, magic: APP_BUNDLE_MAGIC },
    valid,
    invalid,
  };
}

describe("app bundle vectors", () => {
  it("match the checked-in file, and a reader reads each case as it says", { timeout: 60_000 }, async () => {
    const vectors = matchVectorFile(FILE, await build());
    expect(vectors.valid.length).toBeGreaterThanOrEqual(5);
    for (const v of vectors.valid) {
      const bytes = fromSegments(v.bytes);
      expect(bytes.length, v.name).toBe(v.length);
      expect(bytesToHex(sha256(bytes)), v.name).toBe(v.sha256);
      const read = readAppBundle(bytes);
      expect(read.ok, v.name).toBe(true);
      if (!read.ok) continue;
      expect(read.bundle.digest).toBe(v.read.digest);
      expect(read.bundle.manifest).toEqual(v.read.manifest);
      expect(appDigest(read.bundle.manifestBytes)).toBe(v.read.digest);
      // Every file's bytes come back by path, in the manifest's order.
      expect([...read.bundle.files.keys()]).toEqual(v.read.manifest.files.map((f) => f.path));
    }
    const names = new Set<string>();
    for (const v of vectors.invalid) {
      expect(names.has(v.name), `two cases named ${v.name}`).toBe(false);
      names.add(v.name);
      const read = readAppBundle(fromSegments(v.bytes));
      expect(read.ok ? "accepted" : read.reason, v.name).toBe(v.refusal);
    }
  });
});

describe("building a bundle", () => {
  it("sorts the files, signs, and reads back what it wrote", async () => {
    const built = await buildAppBundle(DRAFT, [file("data/b.json", "2"), ENTRY, file("data/a.json", "1")], publisher);
    expect(built.manifest.files.map((f) => f.path)).toEqual(["data/a.json", "data/b.json", "index.html"]);
    const read = readAppBundle(built.bytes);
    expect(read.ok && read.bundle.digest).toBe(built.digest);
    expect(read.ok && new TextDecoder().decode(read.bundle.files.get("data/b.json"))).toBe("2");
  });

  it("refuses to build what a client would refuse", async () => {
    await expect(buildAppBundle({ ...DRAFT, title: "" }, [ENTRY], publisher)).rejects.toThrow(/bad-field/);
    await expect(buildAppBundle(DRAFT, [file("main.html", "x")], publisher)).rejects.toThrow(/bad-entry/);
    await expect(buildAppBundle(DRAFT, [ENTRY, file("data/big.bin", fill(APP_BUNDLE_LIMITS.bundleBytes))], publisher)).rejects.toThrow(/too-large/);
  });

  it("gives a version the same digest however it is fetched", async () => {
    const a = await buildAppBundle(DRAFT, [ENTRY], publisher);
    const b = await buildAppBundle({ ...DRAFT }, [file("index.html", ENTRY.bytes)], publisher);
    expect(a.digest).toBe(b.digest);
    expect(bytesToHex(a.bytes)).toBe(bytesToHex(b.bytes));
  });
});

describe("app URLs, paths and licences", () => {
  it("takes https URLs and jsDelivr only at a full commit", () => {
    expect(isAppUrl(RAW)).toBe(true);
    expect(isAppUrl(PINNED)).toBe(true);
    for (const ref of ["main", "v1.0.0", "1", "^1.0", "latest", "a1b2c3d", "A1B2C3D4E5".repeat(4)]) {
      expect(isAppUrl(`https://cdn.jsdelivr.net/gh/o/r@${ref}/app.ghostlyapp`), ref).toBe(false);
    }
    expect(isAppUrl("https://cdn.jsdelivr.net/gh/o/r/app.ghostlyapp")).toBe(false);
    expect(isAppUrl(`https://fastly.jsdelivr.net/gh/o/r@${"a".repeat(40)}/app.ghostlyapp`)).toBe(false);
    expect(isAppUrl(`https://cdn.jsdelivr.net/npm/chess@${"a".repeat(40)}/app.ghostlyapp`)).toBe(false);
    expect(isAppUrl("http://example.org/")).toBe(false);
    expect(isAppUrl("javascript:alert(1)")).toBe(false);
    expect(isAppUrl(`https://example.org/${"x".repeat(APP_BUNDLE_LIMITS.url)}`)).toBe(false);
  });

  it("reads paths strictly", () => {
    for (const ok of ["index.html", "a/b/c.json", "screenshots/1.png", "-_.x"]) expect(isAppPath(ok), ok).toBe(true);
    for (const no of ["", "/a", "a/", "a//b", ".", "..", "a/./b", "a/../b", "a\\b", "é", "a b", "a:b", "x".repeat(129)]) expect(isAppPath(no), no).toBe(false);
  });

  it("reads SPDX expressions lightly", () => {
    for (const ok of ["MIT", "proprietary", "GPL-3.0-or-later", "Apache-2.0+", "MIT OR Apache-2.0", "(MIT OR Apache-2.0) AND BSD-2-Clause", "GPL-2.0-only WITH Classpath-exception-2.0", "LicenseRef-x"]) expect(isAppLicense(ok), ok).toBe(true);
    for (const no of ["", "MIT AND", "AND", "(MIT", "MIT)", "MIT WITH", "MIT, Apache-2.0", "x".repeat(129), "MIT OR OR BSD"]) expect(isAppLicense(no), no).toBe(false);
  });
});
