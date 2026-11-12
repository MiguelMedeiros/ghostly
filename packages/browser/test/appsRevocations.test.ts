import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@ghostly/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJsonBytes, readAppRevocation, readAppRevocationShape, signAppRevocation, toBase64Url, utf8Encode, type SignedAppRevocation } from "@ghostly/core";
import { APP_FETCH_LIMITS } from "../src/engine/appFetch";
import { BUNDLE_URL, FakeNet, PUBLISHER, REPO, STORE_KEY, STORE_URL, appRows, apps, bundle, emptyProfile, keyOf, revocation, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A publisher's `ghostly-revoke.json` (WISP 1200 § Publisher keys) holds up to 4096 signed revocations, each an Ed25519
 * verify of about a millisecond. The engine runs in the page on the web and Desktop, so an update check verifies them in
 * short slices, and a file it already verified (the same bytes) is not verified again.
 */

vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  return { ...actual, readAppRevocation: vi.fn(actual.readAppRevocation), readAppRevocationShape: vi.fn(actual.readAppRevocationShape) };
});
const verifies = vi.mocked(readAppRevocation);
const shapeChecks = vi.mocked(readAppRevocationShape);

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
  verifies.mockClear();
});

/** The longest time between 1 ms timer ticks while `work` runs: how long the thread the page shares was held. */
async function longestHold(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now(), longest = 0, on = true;
  const tick = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; if (on) setTimeout(tick, 1); };
  setTimeout(tick, 1);
  await work();
  on = false;
  await new Promise((resolve) => setTimeout(resolve, 5));
  return longest;
}

describe("a publisher's ghostly-revoke.json", () => {
  it("is verified in short slices at an update check, and not again while its bytes are the same", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const list: SignedAppRevocation[] = [await revocation(v1.ref, [v1.digest])];
    for (let i = 0; i < 399; i++) list.push(await signAppRevocation({ ghostlyRevoke: 1, app: `${keyOf(PUBLISHER)}/other-${i}`, upTo: 1 + i }, PUBLISHER));
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes(list));
    verifies.mockClear();

    expect(await longestHold(() => store.checkUpdates())).toBeLessThan(100);
    expect(verifies).toHaveBeenCalledTimes(400);
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });

    await store.checkUpdates();
    expect(verifies).toHaveBeenCalledTimes(400);
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
  }, 60_000);

  it("a file whose kept list was dropped is read again by its verdict, with no signature checked", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const list = [await revocation(v1.ref, [v1.digest]), await signAppRevocation({ ghostlyRevoke: 1, app: `${keyOf(PUBLISHER)}/other`, upTo: 1 }, PUBLISHER)];
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes(list));
    await store.checkUpdates();
    (store as unknown as { revocationFiles: Map<string, unknown> }).revocationFiles.clear();
    verifies.mockClear();
    await store.checkUpdates();
    expect(verifies).toHaveBeenCalledTimes(0);
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
  });

  it("shared by six installed apps of its publisher: each entry is read once in a check, on an engine that never read it", async () => {
    const six = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => bundle({ name: `app${i}` })));
    const installer = apps(net);
    for (const [i, one] of six.entries()) {
      net.put(`${REPO}/app${i}.ghostlyapp`, one.bytes);
      await installer.preview({ url: `${REPO}/app${i}.ghostlyapp` });
      await installer.install({ digest: one.digest, grant: ["chat"] });
    }
    const list: SignedAppRevocation[] = [await revocation(six[0]!.ref, [six[0]!.digest], "Leaked key"), await revocation(six[3]!.ref, [six[3]!.digest], "Lost key")];
    for (let i = 0; i < 30; i++) list.push(await signAppRevocation({ ghostlyRevoke: 1, app: `${keyOf(PUBLISHER)}/other-${i}`, upTo: 1 + i }, PUBLISHER));
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes(list));

    // The page reloaded: a new engine, its first check.
    const store = apps(net);
    verifies.mockClear();
    shapeChecks.mockClear();
    await store.checkUpdates();
    expect(verifies.mock.calls.length + shapeChecks.mock.calls.length, "every entry read once, not once per app").toBe(list.length);
    expect(await store.runCheck({ ref: six[0]!.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
    expect(await store.runCheck({ ref: six[3]!.ref })).toEqual({ status: "revoked", reason: "Lost key" });
    for (const i of [1, 2, 4, 5]) expect(await store.runCheck({ ref: six[i]!.ref })).toEqual({ status: "ok" });
    expect((store as unknown as { revocationSplits: unknown }).revocationSplits, "nothing held past the check").toBeNull();

    // Every app's list dropped: the next check reads the file once more, by its verdict.
    (store as unknown as { revocationFiles: Map<string, unknown> }).revocationFiles.clear();
    verifies.mockClear();
    shapeChecks.mockClear();
    await store.checkUpdates();
    expect(verifies).toHaveBeenCalledTimes(0);
    expect(shapeChecks).toHaveBeenCalledTimes(list.length);
    expect(await store.runCheck({ ref: six[0]!.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
  }, 60_000);

  it("one entry that does not verify still refuses the whole file, even one naming another app", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const other = await signAppRevocation({ ghostlyRevoke: 1, app: `${keyOf(PUBLISHER)}/other`, upTo: 1 }, PUBLISHER);
    const forged = { statement: { ...other.statement, upTo: 2 }, signature: other.signature };
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest]), forged]));
    await store.checkUpdates();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "ok" });
    verifies.mockClear();
    await store.checkUpdates();
    expect(verifies, "refused once: not verified again").toHaveBeenCalledTimes(0);
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "ok" });
  });

  it("nine large files of one app, more than the bytes kept, are verified once: not again at the next check, and not held", async () => {
    // The file beside the install URL and one beside each of the 8 sources a manifest may name.
    const sources = Array.from({ length: 8 }, (_, i) => `https://raw.githubusercontent.com/ana/chess-mirror-${i}/HEAD/app.ghostlyapp`);
    const v1 = await bundle({ sources });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    // Revocations as long as one gets (64 digests, a 200-character reason), of other apps: about 1.9 MiB a file, each
    // file its own bytes; the first file also revokes the installed version. Their signatures are not this test's
    // matter, so every entry counts as verified.
    const own = await revocation(v1.ref, [v1.digest]);
    const digests = Array.from({ length: 64 }, (_, i) => toBase64Url(sha256(utf8Encode(`digest ${i}`))));
    const entry = (file: number, i: number): SignedAppRevocation => ({ statement: { ghostlyRevoke: 1, app: `${keyOf(PUBLISHER)}/other-${file}-${i}`, digests, reason: "r".repeat(200) }, signature: own.signature });
    const files = [REPO, ...sources.map((s) => s.replace("/app.ghostlyapp", ""))].map((folder, file) => {
      const bytes = canonicalJsonBytes([...(file === 0 ? [own] : []), ...Array.from({ length: 560 }, (_, i) => entry(file, i))]);
      net.put(`${folder}/ghostly-revoke.json`, bytes);
      return bytes.length;
    });
    const all = files.reduce((sum, bytes) => sum + bytes, 0);
    expect(all).toBeGreaterThan(APP_FETCH_LIMITS.revocationsBytes);
    const actual = await vi.importActual<typeof core>("@ghostly/core");
    verifies.mockImplementation((value) => ({ ok: true, revocation: value as SignedAppRevocation }));
    try {
      await store.checkUpdates();
      expect(verifies).toHaveBeenCalledTimes(9 * 560 + 1);
      expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
      // What stays in memory after the check, as JSON: at most one file's limit.
      const held = store as unknown as { revocationFiles: Map<string, unknown>; revocationVerdicts?: Map<string, unknown> };
      const kept = JSON.stringify([...held.revocationFiles.entries(), ...(held.revocationVerdicts?.entries() ?? [])]).length;
      expect(kept).toBeLessThanOrEqual(APP_FETCH_LIMITS.revocationsBytes + 1024);

      // The same bytes at the next checks: no entry is verified again.
      verifies.mockClear();
      await store.checkUpdates();
      await store.checkUpdates();
      expect(verifies).toHaveBeenCalledTimes(0);
      expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
    } finally {
      verifies.mockImplementation(actual.readAppRevocation);
    }
  }, 60_000);
});

describe("a revocation a store's index carries", () => {
  it("is kept on the app: the store's next index without it, or the store removed, does not let the version run again", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    // Its publisher serves no ghostly-revoke.json: the revocation reaches this client only through the store.
    await net.putStore(await storeFiles());
    await store.addStore({ url: STORE_URL });
    await net.putStore(await storeFiles({ sequence: 2, revoked: [await revocation(v1.ref, [v1.digest])] }));
    await store.checkUpdates();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });

    await net.putStore(await storeFiles({ sequence: 3 }));
    await store.checkUpdates();
    expect(await store.runCheck({ ref: v1.ref }), "an index that dropped it").toEqual({ status: "revoked", reason: "Leaked key" });

    await store.removeStore({ key: keyOf(STORE_KEY) });
    await store.checkUpdates();
    expect(await store.runCheck({ ref: v1.ref }), "the store removed").toEqual({ status: "revoked", reason: "Leaked key" });
    await expect(store.entry({ ref: v1.ref })).rejects.toThrow(/^revoked/);
  });

  it("is kept from when the store is added, with no update check, and stays when the store is removed", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    await net.putStore(await storeFiles({ revoked: [await revocation(v1.ref, [v1.digest])] }));
    await store.addStore({ url: STORE_URL });
    await store.removeStore({ key: keyOf(STORE_KEY) });
    expect(await store.runCheck({ ref: v1.ref }), "added, then removed").toEqual({ status: "revoked", reason: "Leaked key" });
  });

  it("of another app, or of a version not held here, is not kept", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const other = await bundle({ sequence: 2 });
    await net.putStore(await storeFiles({ revoked: [await revocation(v1.ref, [other.digest]), await signAppRevocation({ ghostlyRevoke: 1, app: `${keyOf(PUBLISHER)}/other`, upTo: 9 }, PUBLISHER)] }));
    await store.addStore({ url: STORE_URL });
    await store.checkUpdates();
    expect((await appRows() as { revocations?: unknown[] }[])[0]!.revocations).toBeUndefined();
  });
});
