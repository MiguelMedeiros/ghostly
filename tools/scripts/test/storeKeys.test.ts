import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAppBundle, readAppListing, readAppStore } from "@ghostly/core";
// covers: apps.store.official

/*
 * tools/scripts/store-keys.sh, the owner's one-time setup of the official store (docs/APPS.md): two new keys,
 * owner-only, Chess published with its publisher key, its listing, the first index signed with the store key; only
 * public keys printed; never over a key that is there.
 */

const root = resolve(import.meta.dirname, "../../..");
const script = join(root, "tools/scripts/store-keys.sh");
let tmp: string;
let cli: string;
let chess: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "store-keys-"));
  // The CLI's build leaves its npm dependencies out, so it runs from under the repository, where they resolve.
  mkdirSync(join(root, "node_modules/.cache"), { recursive: true });
  cli = mkdtempSync(join(root, "node_modules/.cache/store-keys-cli-"));
  chess = join(tmp, "chess");
  await build({ configFile: join(root, "packages/cli/vite.config.ts"), root: join(root, "packages/cli"), logLevel: "silent", build: { outDir: cli, emptyOutDir: true } });
  await build({ configFile: join(root, "apps/mini/chess/vite.config.ts"), logLevel: "silent", build: { outDir: chess, emptyOutDir: true } });
}, 180_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(cli, { recursive: true, force: true });
});

/** A clone of ghostly-store as the repository starts: store.json, an empty STORE_KEY, apps/. */
function emptyStore(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "apps"), { recursive: true });
  writeFileSync(join(dir, "store.json"), JSON.stringify({ name: "Ghostly Store", description: "Test.", kind: "curated", removed: [], revoked: [] }));
  writeFileSync(join(dir, "STORE_KEY"), "");
  return dir;
}

function run(keys: string, store: string) {
  const result = spawnSync("bash", [script, "--keys", keys, "--store", store], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, GHOSTLY_CLI: join(cli, "ghostly.mjs"), CHESS_DIST: chess, STORE_SKIP_CHECK: "1" },
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("store-keys.sh", () => {
  let keys: string;
  let store: string;
  let first: ReturnType<typeof run>;

  beforeAll(() => {
    keys = join(tmp, "keys");
    store = emptyStore("store");
    first = run(keys, store);
  }, 120_000);

  it("makes two owner-only keys in a folder of their own", () => {
    expect(first.err).not.toMatch(/failed|refused/);
    expect(first.status).toBe(0);
    expect(mode(keys)).toBe(0o700);
    expect(readdirSync(keys).sort()).toEqual(["chess-publisher.key", "store.key"]);
    for (const file of ["chess-publisher.key", "store.key"]) expect(mode(join(keys, file))).toBe(0o600);
  });

  it("prints the two public keys and their fingerprints, and never a private key", () => {
    const storeKey = readFileSync(join(store, "STORE_KEY"), "utf8").trim();
    expect(first.out).toContain(`Store key         ${storeKey}`);
    expect(first.out).toMatch(/Chess publisher {3}[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\n {20}fingerprint( [ybndrfg8ejkmcpqxot1uwisza345h769]{4}){4}/);
    const printed = first.out + first.err;
    expect(printed).not.toContain("PRIVATE KEY");
    for (const file of ["chess-publisher.key", "store.key"]) {
      const body = readFileSync(join(keys, file), "utf8").split("\n").filter((line) => /^[A-Za-z0-9+/=]{16,}$/.test(line));
      expect(body.length).toBeGreaterThan(0);
      for (const line of body) expect(printed).not.toContain(line);
    }
    expect(first.out).toContain("Back up");
    expect(first.out).toContain("git push");
  });

  it("publishes Chess with its own key, lists it, and signs an index a client reads under the store key", () => {
    const storeKey = readFileSync(join(store, "STORE_KEY"), "utf8").trim();
    const [folder] = readdirSync(join(store, "apps"));
    const bundle = readAppBundle(new Uint8Array(readFileSync(join(store, "apps", folder!, "app.ghostlyapp"))));
    if (!bundle.ok) throw new Error(bundle.reason);
    const { manifest } = bundle.bundle;
    expect(folder).toBe(`chess.${manifest.publisher.slice(0, 16)}`);
    expect(manifest.publisher).not.toBe(storeKey);
    expect(manifest).toMatchObject({ name: "chess", sequence: 1, permissions: ["chat"], files: [{ path: "index.html" }] });
    const url = `https://raw.githubusercontent.com/MiguelMedeiros/ghostly-store/HEAD/apps/${folder}/app.ghostlyapp`;
    expect(manifest.sources).toEqual([url]);

    const listing = readAppListing(readFileSync(join(store, "apps", folder!, "listing.json"), "utf8"));
    if (!listing.ok) throw new Error(listing.reason);
    expect(listing.listing).toMatchObject({ ref: `${manifest.publisher}/chess`, sequence: 1, digest: bundle.bundle.digest, urls: [url], title: "Chess" });

    const now = Math.floor(Date.now() / 1000);
    const index = readAppStore(new Uint8Array(readFileSync(join(store, "ghostly-store.json"))), new Uint8Array(readFileSync(join(store, "ghostly-store.sig"))), now, storeKey);
    if (!index.ok) throw new Error(index.reason);
    expect(index.store.index).toMatchObject({ name: "Ghostly Store", kind: "curated", sequence: 1, apps: [listing.listing], removed: [], revoked: [] });
    // Far enough under the 90 days a client allows that a late clock still reads it.
    expect(index.store.index.expires - now).toBeGreaterThan(79 * 86_400);
    expect(index.store.index.expires - now).toBeLessThanOrEqual(80 * 86_400);
  });

  it("never runs over a key that is there", () => {
    const before = readFileSync(join(keys, "store.key"));
    const again = run(keys, emptyStore("store-again"));
    expect(again.status).not.toBe(0);
    expect(again.err).toContain("is already there");
    expect(readFileSync(join(keys, "store.key"))).toEqual(before);
    expect(existsSync(join(tmp, "store-again", "ghostly-store.json"))).toBe(false);
  });

  it("refuses a store that is signed already", () => {
    const again = run(join(tmp, "keys-two"), store);
    expect(again.status).not.toBe(0);
    expect(again.err).toContain("is signed already");
  });

  it("refuses a key folder inside a git repository", () => {
    const inside = run(join(root, "store-keys-test-keys"), emptyStore("store-git"));
    expect(inside.status).not.toBe(0);
    expect(inside.err).toContain("inside a git repository");
    expect(existsSync(join(root, "store-keys-test-keys"))).toBe(false);
  });
});
