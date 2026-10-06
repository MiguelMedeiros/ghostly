import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAppBundle, type AppManifest } from "@ghostly/core";
import { verifyApp } from "../src/apps";
import { CliError } from "../src/errors";
import { error, ghostly, ok } from "./support/cli";
// covers: apps.bundle, apps.store

/*
 * The publisher tools of WISP 1200 against the core's test vectors (packages/core/test/vectors): `app publish` makes
 * each valid bundle byte for byte from its files and the vector's key, `app verify` refuses each invalid one with the
 * vector's code, and `store sign` makes the vector's signed index. Ed25519 is deterministic, so a byte-equal bundle
 * proves the manifest, the order, the signature and the framing all match the core.
 */

const VECTORS = resolve(import.meta.dirname, "../../core/test/vectors");
type Segment = { hex: string } | { fill: string; size: number };
const bundleVectors = JSON.parse(readFileSync(join(VECTORS, "app-bundle.json"), "utf8")) as {
  valid: { name: string; bytes: Segment[]; sha256: string; length: number; read: { digest: string; manifest: AppManifest } }[];
  invalid: { name: string; refusal: string; bytes: Segment[] }[];
};
const storeVectors = JSON.parse(readFileSync(join(VECTORS, "app-store.json"), "utf8")) as {
  valid: { name: string; index: string; sig: string }[];
};

function fromSegments(segments: Segment[]): Uint8Array {
  const parts = segments.map((s) => ("hex" in s ? Buffer.from(s.hex, "hex") : Buffer.alloc(s.size, Number.parseInt(s.fill, 16))));
  return new Uint8Array(Buffer.concat(parts));
}

const tmp = () => mkdtempSync(join(tmpdir(), "ghostly-apps-"));
const sha256hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A key file for a vector label (seed = SHA-256 of `ghostly apps vectors: <label>`, a test value), as PKCS #8 PEM. */
function vectorKey(dir: string, label: string, header = ""): string {
  const seed = createHash("sha256").update(`ghostly apps vectors: ${label}`).digest();
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`;
  const path = join(dir, `${label.replace(/\W/g, "-")}.pem`);
  writeFileSync(path, header + pem, { mode: 0o600 });
  return path;
}

/** A folder `app publish` reads: the vector's files and its manifest as ghostly-app.json (without what publish writes). */
function appFolder(manifest: AppManifest, files: Map<string, Uint8Array>): string {
  const dir = tmp();
  const { publisher: _p, files: _f, ghostlyApp: _g, ...draft } = manifest;
  writeFileSync(join(dir, "ghostly-app.json"), JSON.stringify(draft, null, 2));
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  return dir;
}

const chess = () => {
  const vector = bundleVectors.valid[0];
  const read = readAppBundle(fromSegments(vector.bytes));
  if (!read.ok) throw new Error("vector 0 does not read");
  return { vector, manifest: read.bundle.manifest, files: read.bundle.files };
};

describe("app publish", () => {
  it.each(bundleVectors.valid.map((v) => [v.name, v] as const))("makes the vector's bundle byte for byte: %s", async (_, vector) => {
    const read = readAppBundle(fromSegments(vector.bytes));
    if (!read.ok) throw new Error(`the vector does not read: ${read.reason}`);
    const dir = appFolder(read.bundle.manifest, read.bundle.files);
    const keys = tmp();
    const made = ok(await ghostly(["app", "publish", dir, "--key", vectorKey(keys, "publisher")]));
    const bytes = readFileSync(join(dir, "app.ghostlyapp"));
    expect(bytes.length).toBe(vector.length);
    expect(sha256hex(bytes)).toBe(vector.sha256);
    expect(made).toMatchObject({ digest: vector.read.digest, sequence: vector.read.manifest.sequence, previous: null, keyCreated: false });
    // And the bundle it wrote verifies, as a client reads it.
    expect(ok(await ghostly(["app", "verify", join(dir, "app.ghostlyapp")]))).toMatchObject({ valid: true, digest: vector.read.digest });
  }, 60_000);

  it("raises the sequence by itself, keeps the app's key, and refuses another key's bundle", async () => {
    const { manifest, files } = chess();
    const dir = appFolder(manifest, files);
    const keys = tmp();
    const key = vectorKey(keys, "publisher");
    expect(ok(await ghostly(["app", "publish", dir, "--key", key]))).toMatchObject({ sequence: 1, previous: null });
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Chess 2</title>");
    const second = ok(await ghostly(["app", "publish", dir, "--key", key]));
    expect(second).toMatchObject({ sequence: 2, previous: 1, ref: `${manifest.publisher}/chess` });

    // Another key may not publish the next version of this app.
    const other = error(await ghostly(["app", "publish", dir, "--key", vectorKey(keys, "other publisher")]), "refused", 1) as { details?: { reason?: string } };
    expect(other.details?.reason).toBe("other-app");
    // A key file that is missing is not made over an app another key signed: a typo is not a new app.
    error(await ghostly(["app", "publish", dir, "--key", join(keys, "typo.pem")]), "not_found", 3);
    expect(existsSync(join(keys, "typo.pem"))).toBe(false);
    expect(readAppBundle(new Uint8Array(readFileSync(join(dir, "app.ghostlyapp"))))).toMatchObject({ ok: true, bundle: { manifest: { sequence: 2 } } });
  }, 60_000);

  it("makes an owner-only key on first use and never prints it", async () => {
    const { manifest, files } = chess();
    const dir = appFolder(manifest, files);
    const key = join(tmp(), "keys", "publisher.pem");
    const result = await ghostly(["app", "publish", dir, "--key", key]);
    const made = ok(result);
    expect(made.keyCreated).toBe(true);
    expect(made.publisher).not.toBe(manifest.publisher);
    if (process.platform !== "win32") {
      expect(statSync(key).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(key)).mode & 0o777).toBe(0o700);
    }
    const pem = readFileSync(key, "utf8");
    expect(pem).toMatch(/^Ghostly publisher key \(WISP 1200\)/);
    const body = /-----BEGIN PRIVATE KEY-----\n([^-]+)-----END/.exec(pem)![1].replace(/\s/g, "");
    expect(result.stdout + result.stderr).not.toContain("PRIVATE KEY");
    expect(result.stdout + result.stderr).not.toContain(body.slice(-20));
    expect(result.stderr).toContain("Back it up");
  }, 60_000);

  it("refuses a key file others may read, and a store key", async () => {
    const { manifest, files } = chess();
    const dir = appFolder(manifest, files);
    const keys = tmp();
    if (process.platform !== "win32") {
      const open = vectorKey(keys, "publisher");
      chmodSync(open, 0o644);
      expect(error(await ghostly(["app", "publish", dir, "--key", open]), "refused", 1).message).toContain("chmod 600");
    }
    const store = vectorKey(keys, "store", "Ghostly store key (WISP 1200).\n");
    expect(error(await ghostly(["app", "publish", dir, "--key", store]), "refused", 1).message).toContain("a store key never signs an app");
    expect(existsSync(join(dir, "app.ghostlyapp"))).toBe(false);
  }, 60_000);

  it("says what is wrong with the source: a usage error, fields publish writes, a manifest a client refuses", async () => {
    const { manifest, files } = chess();
    const keys = tmp();
    const key = vectorKey(keys, "publisher");
    error(await ghostly(["app", "publish", tmp()]), "usage", 2);
    error(await ghostly(["app", "publish", tmp(), "--key", key]), "not_found", 3);
    const dir = appFolder(manifest, files);
    writeFileSync(join(dir, "ghostly-app.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "ghostly-app.json"), "utf8")), publisher: manifest.publisher }));
    expect(error(await ghostly(["app", "publish", dir, "--key", key]), "bad_request", 1).message).toContain("publish writes it");
    const long = appFolder({ ...manifest, title: "x".repeat(41) }, files);
    const refusal = error(await ghostly(["app", "publish", long, "--key", key]), "refused", 1) as { details?: { reason?: string; detail?: string } };
    expect(refusal.details).toEqual({ reason: "bad-field", detail: "title is not valid" });
    // Dot files stay out of the bundle, and say so.
    const dotted = appFolder(manifest, files);
    writeFileSync(join(dotted, ".DS_Store"), "x");
    expect(ok(await ghostly(["app", "publish", dotted, "--key", key]))).toMatchObject({ files: ["index.html"], skipped: [".DS_Store"] });
  }, 60_000);
});

describe("app verify", () => {
  it.each(bundleVectors.invalid.map((v) => [v.name, v] as const))("refuses %s with the vector's code", async (_, vector) => {
    const path = join(tmp(), "app.ghostlyapp");
    writeFileSync(path, fromSegments(vector.bytes));
    const refusal = await verifyApp(path).then(() => null, (e: unknown) => e);
    expect(refusal).toBeInstanceOf(CliError);
    expect((refusal as CliError).code).toBe("refused");
    expect((refusal as CliError).details?.reason).toBe(vector.refusal);
  });

  it("answers exit 1 with the reason for a tampered bundle, 3 for no file, 2 for a URL a client does not read", async () => {
    const { vector } = chess();
    const bytes = fromSegments(vector.bytes);
    bytes[bytes.length - 1] ^= 1;
    const path = join(tmp(), "app.ghostlyapp");
    writeFileSync(path, bytes);
    const refusal = error(await ghostly(["app", "verify", path]), "refused", 1) as { details?: { reason?: string; detail?: string } };
    expect(refusal.details).toEqual({ reason: "file-hash", detail: "index.html" });
    error(await ghostly(["app", "verify", join(tmp(), "none.ghostlyapp")]), "not_found", 3);
    error(await ghostly(["app", "verify", "http://example.com/app.ghostlyapp"]), "usage", 2);
    error(await ghostly(["app", "verify", "https://cdn.jsdelivr.net/gh/ana/chess@main/app.ghostlyapp"]), "usage", 2);
  }, 60_000);
});

describe("app verify <url>", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const { vector } = chess();
  const bundle = fromSegments(vector.bytes);
  const stream = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } });

  it("reads a bundle over https, following a redirect held to the same rule", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      if (url.includes("@")) return new Response(stream([bundle]), { status: 200 });
      return new Response(null, { status: 302, headers: { location: "https://cdn.jsdelivr.net/gh/ana/chess@0123456789abcdef0123456789abcdef01234567/app.ghostlyapp" } });
    });
    expect(await verifyApp("https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp")).toMatchObject({ valid: true, digest: vector.read.digest });
    expect(seen).toHaveLength(2);
  });

  it("refuses a redirect to a URL a client does not read", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 301, headers: { location: "http://example.com/app.ghostlyapp" } }));
    await expect(verifyApp("https://example.com/app.ghostlyapp")).rejects.toMatchObject({ code: "refused" });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 302, headers: { location: "https://cdn.jsdelivr.net/gh/ana/chess@latest/app.ghostlyapp" } }));
    await expect(verifyApp("https://example.com/app.ghostlyapp")).rejects.toMatchObject({ code: "refused" });
  });

  it("stops past 16 MiB, by its length or while it reads", async () => {
    const limit = 16 * 1024 * 1024;
    vi.stubGlobal("fetch", async () => new Response(stream([bundle]), { status: 200, headers: { "content-length": String(limit + 1) } }));
    await expect(verifyApp("https://example.com/a.ghostlyapp")).rejects.toMatchObject({ code: "refused", details: { reason: "too-large" } });
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024 * 1024)); } });
    vi.stubGlobal("fetch", async () => new Response(endless, { status: 200 }));
    await expect(verifyApp("https://example.com/a.ghostlyapp")).rejects.toMatchObject({ code: "refused", details: { reason: "too-large" } });
    expect(pulled).toBeLessThan(20);
  });

  it("says not found for a 404", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 404 }));
    await expect(verifyApp("https://example.com/a.ghostlyapp")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("store sign", () => {
  const vector = storeVectors.valid[0];

  it("makes the vector's ghostly-store.json and ghostly-store.sig from an index written by hand", async () => {
    const dir = tmp();
    const keys = tmp();
    const { key: _key, ...index } = JSON.parse(vector.index) as Record<string, unknown>;
    writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 2));
    const signed = ok(await ghostly(["store", "sign", join(dir, "index.json"), "--key", vectorKey(keys, "store")]));
    expect(readFileSync(join(dir, "ghostly-store.json"), "utf8")).toBe(vector.index);
    expect(readFileSync(join(dir, "ghostly-store.sig"), "utf8")).toBe(vector.sig);
    expect(signed).toMatchObject({ sequence: JSON.parse(vector.index).sequence, previous: null, keyCreated: false });
  }, 60_000);

  it("refuses a lower sequence, the same one with other content, another key and a publisher key", async () => {
    const dir = tmp();
    const keys = tmp();
    const key = vectorKey(keys, "store");
    const index = JSON.parse(vector.index) as Record<string, unknown> & { sequence: number; name: string };
    const write = (value: object) => writeFileSync(join(dir, "index.json"), JSON.stringify(value));
    write(index);
    ok(await ghostly(["store", "sign", join(dir, "index.json"), "--key", key]));
    // The same index again is the same bytes: fine.
    ok(await ghostly(["store", "sign", join(dir, "index.json"), "--key", key]));
    write({ ...index, sequence: index.sequence - 1 });
    expect((error(await ghostly(["store", "sign", join(dir, "index.json"), "--key", key]), "refused", 1) as { details?: { reason?: string } }).details?.reason).toBe("rollback");
    write({ ...index, name: `${index.name} 2` });
    expect((error(await ghostly(["store", "sign", join(dir, "index.json"), "--key", key]), "refused", 1) as { details?: { reason?: string } }).details?.reason).toBe("equivocation");
    write({ ...index, name: `${index.name} 2`, sequence: index.sequence + 1 });
    expect(ok(await ghostly(["store", "sign", join(dir, "index.json"), "--key", key]))).toMatchObject({ sequence: index.sequence + 1, previous: index.sequence });
    expect((error(await ghostly(["store", "sign", join(dir, "index.json"), "--key", vectorKey(keys, "other store")]), "refused", 1) as { details?: { reason?: string } }).details?.reason).toBe("store-key");
    const publisher = vectorKey(keys, "publisher", "Ghostly publisher key (WISP 1200).\n");
    expect(error(await ghostly(["store", "sign", join(dir, "index.json"), "--key", publisher]), "refused", 1).message).toContain("a publisher key never signs a store index");
  }, 60_000);

  it("makes a store key for an index that names none, and refuses an index a client would refuse", async () => {
    const dir = tmp();
    const { key: _key, ...index } = JSON.parse(vector.index) as Record<string, unknown>;
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    const key = join(tmp(), "store.pem");
    const made = ok(await ghostly(["store", "sign", join(dir, "index.json"), "--key", key]));
    expect(made.keyCreated).toBe(true);
    expect(readFileSync(key, "utf8")).toMatch(/^Ghostly store key/);
    writeFileSync(join(dir, "far.json"), JSON.stringify({ ...index, expires: Math.floor(Date.now() / 1000) + 91 * 86_400 }));
    expect((error(await ghostly(["store", "sign", join(dir, "far.json"), "--key", key, "--out", tmp()]), "refused", 1) as { details?: { reason?: string } }).details?.reason).toBe("expires-too-far");
    writeFileSync(join(dir, "unknown.json"), JSON.stringify({ ...index, extra: 1 }));
    expect((error(await ghostly(["store", "sign", join(dir, "unknown.json"), "--key", key, "--out", tmp()]), "refused", 1) as { details?: { reason?: string } }).details?.reason).toBe("unknown-key");
  }, 60_000);
});
