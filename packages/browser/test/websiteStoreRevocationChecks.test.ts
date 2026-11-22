import { sha256 } from "@noble/hashes/sha2.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appRef, buildAppBundle, canonicalJson, seedSigner, signAppRevocation, signAppStore, toZ32, utf8Encode, type AppStoreIndex, type SignedAppRevocation, type Signer } from "@ghostly/core";
import { readStore } from "../../../apps/website/lib/storeRead";
// covers: apps.store

/*
 * ghostly.tools' /apps pages check the publishers' `ghostly-revoke.json` files the first time a request reaches them, on
 * the server's one thread. Files that differ by one entry each are each checked in full: a revocation repeated in them
 * is verified once for the read, and the signatures one publisher's files (and all of them) may take are bounded. A
 * listing whose files go past that is left out, and another publisher's is still read as before.
 */

const verifies = vi.hoisted(() => ({ count: 0 }));
vi.mock("@noble/curves/ed25519.js", async (original) => {
  const real = await original<typeof import("@noble/curves/ed25519.js")>();
  const verify: typeof real.ed25519.verify = (...args) => { verifies.count++; return real.ed25519.verify(...args); };
  return { ...real, ed25519: { ...real.ed25519, verify } };
});

const signerOf = (label: string): Signer => seedSigner(sha256(utf8Encode(`ghostly website store revocation checks: ${label}`)));
const NOW = 1_791_417_600;
const RAW = "https://raw.githubusercontent.com";
const at = (dir: string) => `${RAW}/${dir}/HEAD/app.ghostlyapp`;
const revokeAt = (dir: string) => `${RAW}/${dir}/HEAD/ghostly-revoke.json`;
/** The checks one publisher's files may take (storeRead.ts, `REVOCATION_CHECKS`): a full file the app accepts. */
const PER_PUBLISHER = 4096;
const fileOf = (entries: SignedAppRevocation[]) => utf8Encode(canonicalJson(entries as never));

/** One app per publisher, each with four listing URLs and eight sources: twelve folders a revocation file may sit in. */
async function world(publishers: string[]) {
  const store = signerOf("store");
  const bundles: Record<string, Uint8Array> = {};
  const apps: AppStoreIndex["apps"] = [];
  const folders: Record<string, string[]> = {};
  const signers: Record<string, Signer> = {};
  for (const name of publishers) {
    const publisher = signerOf(name);
    const key = toZ32(publisher.publicKey);
    const dirs = [1, 2, 3, 4].map((n) => `${name}/app-${n}`);
    const sources = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${name}/src-${n}`);
    const made = await buildAppBundle({
      name, version: "1.0.0", sequence: 1, kind: "mini-app", title: name, tagline: name, entry: "index.html",
      permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", sources: sources.map(at),
    }, [{ path: "index.html", bytes: utf8Encode(`<p>${name}`) }], publisher);
    bundles[at(dirs[0]!)] = made.bytes;
    apps.push({ ref: appRef(key, name), sequence: 1, digest: made.digest, urls: dirs.map(at), title: name, tagline: name });
    folders[name] = [...dirs, ...sources];
    signers[name] = publisher;
  }
  const index: AppStoreIndex = { ghostlyStore: 1, key: toZ32(store.publicKey), name: "Ghostly", kind: "curated", sequence: 1, expires: NOW + 30 * 24 * 3600, apps, removed: [], revoked: [] };
  const { indexBytes, sigBytes } = await signAppStore(index, store);
  return { index: indexBytes, sig: sigBytes, bundles, key: toZ32(store.publicKey), folders, signers };
}

/** `count` revocations of other apps of `name`'s publisher, numbered from `from`. */
async function others(signer: Signer, from: number, count: number): Promise<SignedAppRevocation[]> {
  const key = toZ32(signer.publicKey);
  return Promise.all(Array.from({ length: count }, (_, n) => signAppRevocation({ ghostlyRevoke: 1, app: appRef(key, `other${from + n}`), upTo: 1 }, signer)));
}

/** Signature checks of a read with no revocation file: the index and the bundles. */
function baseline(w: Awaited<ReturnType<typeof world>>): number {
  verifies.count = 0;
  readStore({ index: w.index, sig: w.sig, bundles: w.bundles, revocations: {} }, NOW, w.key);
  return verifies.count;
}

describe("website store, revocation checks bounded", () => {
  beforeEach(() => { verifies.count = 0; });

  it("checks a revocation repeated across twelve distinct files once", async () => {
    const w = await world(["ana"]);
    const base = baseline(w);
    const filler = (await others(w.signers.ana!, 0, 1))[0]!;
    const own = await others(w.signers.ana!, 1, 12);
    // Each file differs from the others by one entry; the rest is one revocation, repeated.
    const revocations = Object.fromEntries(w.folders.ana!.map((dir, n) => [revokeAt(dir), fileOf([own[n]!, ...Array.from({ length: 255 }, () => filler)])]));
    verifies.count = 0;
    const view = readStore({ index: w.index, sig: w.sig, bundles: w.bundles, revocations }, NOW, w.key);
    expect(view).toMatchObject({ ok: true, skipped: [] });
    expect(view.ok && view.apps.map((a) => a.name)).toEqual(["ana"]);
    expect(verifies.count - base).toBe(12 + 1);
  });

  it("leaves out a listing whose files need more checks than one publisher may take, and still reads another's", async () => {
    const w = await world(["ana", "bea"]);
    const base = baseline(w);
    const many = await others(w.signers.ana!, 0, PER_PUBLISHER + 1);
    const bea = w.signers.bea!;
    const revokesBea = await signAppRevocation({ ghostlyRevoke: 1, app: appRef(toZ32(bea.publicKey), "bea"), upTo: 1 }, bea);
    const revocations = {
      [revokeAt(w.folders.ana![0]!)]: fileOf(many.slice(0, PER_PUBLISHER)),
      [revokeAt(w.folders.ana![1]!)]: fileOf(many.slice(PER_PUBLISHER)),
      [revokeAt(w.folders.bea![0]!)]: fileOf([revokesBea]),
    };
    verifies.count = 0;
    const view = readStore({ index: w.index, sig: w.sig, bundles: w.bundles, revocations }, NOW, w.key);
    const [ana, beaRef] = [appRef(toZ32(w.signers.ana!.publicKey), "ana"), appRef(toZ32(bea.publicKey), "bea")];
    expect(view).toMatchObject({ ok: true, apps: [], skipped: [{ ref: ana, reason: "revocations-unchecked" }, { ref: beaRef, reason: "revoked" }] });
    expect(verifies.count - base).toBe(PER_PUBLISHER + 1);
  }, 60_000);
});
