import { sha256 } from "@noble/hashes/sha2.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRef, buildAppBundle, canonicalJson, seedSigner, signAppRevocation, signAppStore, toZ32, utf8Encode, type AppStoreIndex, type Signer } from "@ghostly/core";
import { readStore } from "../../../apps/website/lib/storeRead";
// covers: apps.store

/*
 * ghostly.tools' /apps pages check each publisher's `ghostly-revoke.json` the first time a request reaches them, on the
 * server's one thread: up to 4096 signature checks a file. The same file served beside every URL and source of a
 * listing (or of every listing of one publisher) was checked again for each URL, holding the server for tens of
 * seconds; the app keeps a file's answer by the SHA-256 of its bytes, and so does the site now. The same entries in
 * another order in each folder (other bytes, nothing newly signed) held it as long: each signed revocation is checked once.
 */

const reads = vi.hoisted(() => ({ count: 0, verified: 0 }));
vi.mock("@noble/curves/ed25519.js", async (original) => {
  const real = await original<typeof import("@noble/curves/ed25519.js")>();
  const verify: typeof real.ed25519.verify = (...args) => { reads.verified++; return real.ed25519.verify(...args); };
  return { ...real, ed25519: { ...real.ed25519, verify } };
});
vi.mock("../../../apps/website/lib/store-core/appStatements", async (original) => {
  const real = await original<typeof import("../../../apps/website/lib/store-core/appStatements")>();
  return { ...real, readAppRevocations: (...args: Parameters<typeof real.readAppRevocations>) => { reads.count++; return real.readAppRevocations(...args); } };
});

const signerOf = (label: string): Signer => seedSigner(sha256(utf8Encode(`ghostly website store revocations once: ${label}`)));
const NOW = 1_791_417_600;
const RAW = "https://raw.githubusercontent.com/ana";
const at = (dir: string) => `${RAW}/${dir}/HEAD/app.ghostlyapp`;
const revokeAt = (dir: string) => `${RAW}/${dir}/HEAD/ghostly-revoke.json`;

/**
 * Two apps of one publisher, each with four listing URLs and two sources, every folder serving the same revocation file,
 * or (`rotated`) the same signed entries in another order in each folder: other bytes, nothing newly signed.
 */
async function world(revokes: "other" | "chess", order: "same" | "rotated" = "same") {
  const publisher = signerOf("publisher");
  const store = signerOf("store");
  const key = toZ32(publisher.publicKey);
  const dirs = (name: string) => [1, 2, 3, 4].map((n) => `${name}-${n}`);
  const sources = (name: string) => [at(`${name}-src-1`), at(`${name}-src-2`)];
  const bundles: Record<string, Uint8Array> = {};
  const apps: AppStoreIndex["apps"] = [];
  for (const name of ["chess", "notes"]) {
    const made = await buildAppBundle({
      name, version: "1.0.0", sequence: 1, kind: "mini-app", title: name, tagline: name, entry: "index.html",
      permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", sources: sources(name),
    }, [{ path: "index.html", bytes: utf8Encode(`<p>${name}`) }], publisher);
    bundles[at(dirs(name)[0]!)] = made.bytes;
    apps.push({ ref: appRef(key, name), sequence: 1, digest: made.digest, urls: dirs(name).map(at), title: name, tagline: name });
  }
  const index: AppStoreIndex = { ghostlyStore: 1, key: toZ32(store.publicKey), name: "Ghostly", kind: "curated", sequence: 1, expires: NOW + 30 * 24 * 3600, apps, removed: [], revoked: [] };
  const { indexBytes, sigBytes } = await signAppStore(index, store);
  const entries = [];
  for (let n = 0; n < 16; n++) entries.push(await signAppRevocation({ ghostlyRevoke: 1, app: appRef(key, n === 0 ? revokes : `other${n}`), upTo: 1 }, publisher));
  const file = utf8Encode(canonicalJson(entries as never));
  const folders = ["chess", "notes"].flatMap((name) => [...dirs(name), `${name}-src-1`, `${name}-src-2`]);
  const rotated = (i: number) => utf8Encode(canonicalJson([...entries.slice(i), ...entries.slice(0, i)] as never));
  const revocations = Object.fromEntries(folders.map((dir, i) => [revokeAt(dir), order === "same" ? file.slice() : rotated(i)]));
  return { bytes: { index: indexBytes, sig: sigBytes, bundles, revocations }, key: toZ32(store.publicKey), files: folders.length, chess: appRef(key, "chess") };
}

describe("website store, each revocation file checked once", () => {
  beforeEach(() => { reads.count = 0; });

  it("checks the same file served beside twelve URLs once, and still keeps the apps it does not revoke", async () => {
    const { bytes, key, files } = await world("other");
    expect(files).toBe(12);
    const view = readStore(bytes, NOW, key);
    expect(view).toMatchObject({ ok: true, skipped: [] });
    expect(view.ok && view.apps.map((a) => a.name)).toEqual(["chess", "notes"]);
    expect(reads.count).toBe(1);
  });

  it("still leaves out the version the shared file revokes", async () => {
    const { bytes, key, chess } = await world("chess");
    const view = readStore(bytes, NOW, key);
    expect(view).toMatchObject({ ok: true, skipped: [{ ref: chess, reason: "revoked" }] });
    expect(view.ok && view.apps.map((a) => a.name)).toEqual(["notes"]);
    expect(reads.count).toBe(1);
  });

  it("checks each signed revocation once, whichever file and order holds it", async () => {
    const same = await world("other");
    reads.verified = 0;
    readStore(same.bytes, NOW, same.key);
    const once = reads.verified;
    const { bytes, key } = await world("other", "rotated");
    reads.verified = 0;
    const view = readStore(bytes, NOW, key);
    expect(view).toMatchObject({ ok: true, skipped: [] });
    expect(reads.count).toBe(1 + 12);
    expect(reads.verified).toBe(once);
  });
});
