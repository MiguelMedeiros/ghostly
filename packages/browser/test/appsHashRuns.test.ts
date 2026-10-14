import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_BYTES_STEP } from "../src/shared/fileBytes";
import { BUNDLE_URL, FakeNet, REPO, STORE_URL, apps, bundle, emptyProfile, listing, storeFiles, type Built } from "./appsSupport";
// covers: apps.engine.installed, apps.engine.stores

/*
 * How long the engine hashes in one run. It shares the page's thread, and SHA-256 in JavaScript takes about 12 ms per
 * MiB on a desktop CPU: a bundle, a `ghostly-revoke.json` or a store's index hashed whole in one call (they may be 16
 * MiB) is a page that draws nothing and takes no input for that long, three times from Install to the app's first
 * open, and again whenever the update check takes an update. Counted here: the most bytes one call of the JavaScript
 * hash was given. With `crypto.subtle` a large file is hashed off the thread; without it (a page not served over
 * HTTPS), in slices with a pause between them. Storage's own read-back goes a step at a time either way.
 */

const runs = vi.hoisted(() => ({ longest: 0 }));
vi.mock("@noble/hashes/sha2.js", async (original) => {
  const real = await original<typeof import("@noble/hashes/sha2.js")>();
  const seen = (bytes: Uint8Array) => { if (bytes.length > runs.longest) runs.longest = bytes.length; };
  const sha256 = Object.assign((bytes: Uint8Array) => { seen(bytes); return real.sha256(bytes); }, real.sha256, {
    create: () => {
      const hash = real.sha256.create();
      const update = hash.update.bind(hash);
      hash.update = (bytes: Uint8Array) => { seen(bytes); update(bytes); return hash; };
      return hash;
    },
  });
  return { ...real, sha256 };
});

const MIB = 1024 * 1024;
const REVOKE_URL = `${REPO}/ghostly-revoke.json`;

/** The most bytes one run of the JavaScript hash was given while `work` ran. */
async function longestRun<T>(work: () => Promise<T>): Promise<{ bytes: number; value: T }> {
  runs.longest = 0;
  const value = await work();
  return { bytes: runs.longest, value };
}

let net: FakeNet;
let v1: Built;
let v2: Built;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
  // A game with assets: one data file of 8 MiB, and its next version.
  v1 = await bundle({ sources: [BUNDLE_URL], data: new Uint8Array(8 * MIB).fill(1) });
  v2 = await bundle({ sequence: 2, sources: [BUNDLE_URL], data: new Uint8Array(8 * MIB).fill(2) });
  net.put(BUNDLE_URL, v1.bytes);
  // A store whose index is over 2 MiB: read again, and hashed, at every Apps page open and every update check.
  const long = (i: number) => `https://raw.githubusercontent.com/ana/app${i}/HEAD/${"p".repeat(400)}/app.ghostlyapp`;
  const listed = Array.from({ length: 2500 }, (_, i) => ({ ...listing(v1, [long(i), long(i).replace("/HEAD/", "/main/")]), ref: `${v1.ref}-${i}` }));
  const store = await storeFiles({ apps: listed });
  expect(store.indexBytes.length).toBeGreaterThan(2 * MIB);
  await net.putStore(store);
});
afterEach(() => { vi.restoreAllMocks(); });

/** From the tap on a link to the app on screen, then an update taken by the check, each on the thread the page draws on. */
async function installOpenUpdate(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const engine = apps(net);
  // Not counted: an index read for the first time is parsed and its signature checked whole, once.
  await engine.addStore({ url: STORE_URL });
  out.preview = (await longestRun(() => engine.preview({ url: BUNDLE_URL }))).bytes;
  out.install = (await longestRun(() => engine.install({ digest: v1.digest, grant: ["chat"] }))).bytes;
  // A page loaded again: the bundle is read back and checked again before it runs.
  const again = apps(net);
  const opened = await longestRun(() => again.entry({ ref: v1.ref }));
  expect(opened.value.entry).toContain("<p>v1");
  out.entry = opened.bytes;
  out.refreshStores = (await longestRun(() => again.refreshStores())).bytes;
  // The next version at its source, beside a 3 MiB `ghostly-revoke.json` (hashed before it is read, whatever it holds).
  net.put(BUNDLE_URL, v2.bytes);
  net.put(REVOKE_URL, new Uint8Array(3 * MIB).fill(0x20));
  const checked = await longestRun(() => again.checkUpdates());
  expect(checked.value).toEqual([{ ref: v1.ref, outcome: "updated", run: { status: "ok" } }]);
  out.checkUpdates = checked.bytes;
  // The same check again: the same revocations file and the same index, hashed again to see that they are the same.
  out.checkAgain = (await longestRun(() => again.checkUpdates())).bytes;
  expect((await again.entry({ ref: v1.ref })).entry).toContain("<p>v2");
  return out;
}

/** The steps whose longest run was more than one step of storage's read-back (1 MiB). */
const over = (longest: Record<string, number>) => Object.fromEntries(Object.entries(longest).filter(([, bytes]) => bytes > FILE_BYTES_STEP));

describe("the longest run of hashing on the page's thread", () => {
  it("is never a whole bundle, revocations file or store index: with crypto.subtle they are hashed off the thread", { timeout: 120_000 }, async () => {
    expect(over(await installOpenUpdate())).toEqual({});
  });

  it("is a slice at a time where there is no crypto.subtle (a page not served over HTTPS)", { timeout: 120_000 }, async () => {
    vi.spyOn(globalThis.crypto, "subtle", "get").mockReturnValue(undefined as unknown as SubtleCrypto);
    expect(globalThis.crypto.subtle).toBeUndefined();
    expect(over(await installOpenUpdate())).toEqual({});
  });
});
