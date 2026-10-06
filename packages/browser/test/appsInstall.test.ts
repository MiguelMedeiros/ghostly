import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "@ghostly/core";
import { fileBytes } from "../src/shared/fileBytes";
import {
  BUNDLE_URL, FakeNet, NOW_MS, PINNED_URL, PUBLISHER, REPO, STORE_KEY, STORE_URL, appRows, apps, bundle, bundleIds, emptyProfile, keyOf,
  listing, revocation, signer, storeFiles,
} from "./appsSupport";
// covers: apps.engine.installed

/*
 * The engine's app store (WISP 1200 § Updates and rollback, § Takedowns, § Apps sent in a chat): install only after the
 * person saw the checked bundle, the update rule from core (rollback refused, equivocation marked, new permissions asked
 * again), revocations and removals checked before a run, and a restored profile's missing files fetched again by digest.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

describe("install", () => {
  it("a pasted GitHub URL is read from raw.githubusercontent.com; nothing is kept before Install", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    const preview = await store.preview({ url: "https://github.com/ana/chess" });
    expect(net.requests).toEqual([BUNDLE_URL]);
    expect(preview).toMatchObject({ digest: v1.digest, ref: v1.ref, install: "new", asks: ["chat"], run: { status: "ok" }, unknownPublisher: true, listedBy: [] });
    expect(await appRows()).toEqual([]);
    expect(await bundleIds()).toEqual([]);

    const view = await store.install({ digest: v1.digest, grant: ["chat"] });
    expect(view).toMatchObject({ ref: v1.ref, sequence: 1, digest: v1.digest, permissions: ["chat"], run: { status: "ok" } });
    expect(await bundleIds()).toEqual([`app-${v1.digest}`]);
    const entry = await store.entry({ ref: v1.ref });
    expect(entry).toMatchObject({ digest: v1.digest, version: "1.0.1", permissions: ["chat"] });
    expect(entry.entry).toContain("<p>v1");
    expect(new TextDecoder().decode(await store.file({ ref: v1.ref, path: "data/openings.json" }))).toBe("[]");
    await expect(store.file({ ref: v1.ref, path: "../secret" })).rejects.toThrow(/^no-file/);
  });

  it("refuses an install without every permission granted, and one never previewed", async () => {
    const v1 = await bundle({ permissions: ["chat", "name"] });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^permissions/);
    await expect(store.install({ digest: "x".repeat(43), grant: [] })).rejects.toThrow(/^expired/);
    expect(await appRows()).toEqual([]);
  });

  it("refuses a bundle that does not verify, with the reader's refusal, and keeps nothing", async () => {
    const v1 = await bundle();
    const broken = v1.bytes.slice();
    broken[broken.length - 1] ^= 1;
    net.put(BUNDLE_URL, broken);
    await expect(apps(net).preview({ url: BUNDLE_URL })).rejects.toThrow(/^file-hash/);
    net.put(BUNDLE_URL, new Uint8Array([...v1.bytes, 0]));
    await expect(apps(net).preview({ url: BUNDLE_URL })).rejects.toThrow(/^trailing-bytes/);
    expect(await bundleIds()).toEqual([]);
  });

  it("a card's pointer is fetched only from the allowed hosts, and must hold its app at its number or newer", async () => {
    const v2 = await bundle({ sequence: 2 });
    net.put(PINNED_URL, v2.bytes);
    const store = apps(net);
    await expect(store.preview({ card: { ref: v2.ref, url: "https://evil.example/app.ghostlyapp" } })).rejects.toThrow(/^host/);
    await expect(store.preview({ card: { ref: v2.ref, url: "https://cdn.jsdelivr.net/gh/ana/chess@main/app.ghostlyapp" } })).rejects.toThrow(/^host/);
    expect(net.requests).toEqual([]);
    await expect(store.preview({ card: { ref: v2.ref, url: PINNED_URL, sequence: 3 } })).rejects.toThrow(/^rollback/);
    await expect(store.preview({ card: { ref: v2.ref, url: PINNED_URL, sequence: 2, digest: "A".repeat(43) } })).rejects.toThrow(/^equivocation/);
    await expect(store.preview({ card: { ref: `${keyOf(signer("other"))}/chess`, url: PINNED_URL } })).rejects.toThrow(/^other-app/);
    // An older card is fine: the bundle there is newer.
    expect(await store.preview({ card: { ref: v2.ref, url: PINNED_URL, sequence: 1 } })).toMatchObject({ digest: v2.digest, install: "new" });
  });

  it("from a store's listing: its URLs in order, its digest held, and a curated store clears Unknown publisher", async () => {
    const v1 = await bundle();
    net.put(PINNED_URL, v1.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v1, ["https://raw.githubusercontent.com/ana/chess/HEAD/gone.ghostlyapp", PINNED_URL])] }));
    const store = apps(net);
    await store.addStore({ url: STORE_URL, key: keyOf(STORE_KEY) });
    const preview = await store.preview({ store: keyOf(STORE_KEY), ref: v1.ref });
    expect(preview).toMatchObject({ digest: v1.digest, from: PINNED_URL, unknownPublisher: false, listedBy: [{ key: keyOf(STORE_KEY), name: "Test store", kind: "curated" }] });
    expect((await store.install({ digest: v1.digest, grant: ["chat"] })).unknownPublisher).toBe(false);
    // An indexed store's listing leaves the warning in place.
    await emptyProfile();
    await net.putStore(await storeFiles({ kind: "indexed", apps: [listing(v1, [PINNED_URL])] }));
    const again = apps(net);
    await again.addStore({ url: STORE_URL });
    expect(await again.preview({ store: keyOf(STORE_KEY), ref: v1.ref })).toMatchObject({ unknownPublisher: true });
  });
});

describe("updates", () => {
  async function installed(options: Parameters<typeof bundle>[0] = {}) {
    const v1 = await bundle(options);
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: v1 && (options.permissions ?? ["chat"]) });
    return { store, v1 };
  }

  it("a newer version a store lists installs by itself when it adds no permission; the old files go", async () => {
    const { store, v1 } = await installed();
    const v2 = await bundle({ sequence: 2, permissions: [] });
    net.put(PINNED_URL, v2.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v2, [PINNED_URL])] }));
    await store.addStore({ url: STORE_URL });
    expect(await store.checkUpdates()).toEqual([{ ref: v1.ref, outcome: "updated", run: { status: "ok" } }]);
    expect((await store.list())[0]).toMatchObject({ sequence: 2, digest: v2.digest, permissions: [] });
    expect(await bundleIds()).toEqual([`app-${v2.digest}`]);
  });

  it("an update that adds a permission waits for the person, who sees only what is new", async () => {
    const { store, v1 } = await installed();
    const v2 = await bundle({ sequence: 2, permissions: ["chat", "name"] });
    net.put(PINNED_URL, v2.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v2, [PINNED_URL])] }));
    await store.addStore({ url: STORE_URL });
    expect((await store.checkUpdates())[0]!.outcome).toBe("ask");
    const waiting = (await store.list())[0]!;
    expect(waiting).toMatchObject({ sequence: 1, digest: v1.digest, permissions: ["chat"], pending: { sequence: 2, added: ["name"] } });
    expect((await store.entry({ ref: v1.ref })).digest, "the installed one still runs").toBe(v1.digest);
    const accepted = await store.acceptUpdate({ ref: v1.ref });
    expect(accepted).toMatchObject({ sequence: 2, digest: v2.digest, permissions: ["chat", "name"] });
    expect(accepted.pending).toBeUndefined();
    expect(await bundleIds()).toEqual([`app-${v2.digest}`]);
  });

  it("a newer version found at the app's own source, peeked first", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    net.requests.length = 0;
    net.fetch.mockClear();
    expect((await store.checkUpdates())[0]!.outcome, "nothing newer: only the peek and the revocations are read").toBe("none");
    expect(net.requests).toEqual([BUNDLE_URL, `${REPO}/ghostly-revoke.json`]);
    expect(net.fetch.mock.calls[0]![1]).toMatchObject({ headers: { range: expect.stringMatching(/^bytes=0-\d+$/) } });
    const v2 = await bundle({ sequence: 2, sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v2.bytes);
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
  });

  it("a lower sequence is never installed over a higher one", async () => {
    const { store } = await installed({ sequence: 3 });
    const old = await bundle({ sequence: 2 });
    net.put(PINNED_URL, old.bytes);
    expect(await store.preview({ url: PINNED_URL })).toMatchObject({ install: "rollback" });
    await expect(store.install({ digest: old.digest, grant: ["chat"] })).rejects.toThrow(/^rollback/);
    expect((await store.list())[0]!.sequence).toBe(3);
  });

  it("the same sequence with another digest is refused and the app marked; the one held is kept", async () => {
    const { store, v1 } = await installed();
    const twin = await bundle({ sequence: 1, entry: "<p>another version 1" });
    net.put(PINNED_URL, twin.bytes);
    expect(await store.preview({ url: PINNED_URL })).toMatchObject({ install: "equivocation" });
    await expect(store.install({ digest: twin.digest, grant: ["chat"] })).rejects.toThrow(/^equivocation: Two different versions 1 exist/);
    expect((await store.list())[0]).toMatchObject({ digest: v1.digest, equivocation: { sequence: 1 } });
    // Found by the update check (a store lists the twin): marked the same way.
    await emptyProfile();
    const again = await installed();
    await net.putStore(await storeFiles({ apps: [listing(twin, [PINNED_URL])] }));
    await again.store.addStore({ url: STORE_URL });
    expect((await again.store.checkUpdates())[0]!.outcome).toBe("equivocation");
    expect((await again.store.list())[0]).toMatchObject({ digest: again.v1.digest, equivocation: { sequence: 1 } });
    // A later version past that number ends the mark.
    const v2 = await bundle({ sequence: 2 });
    net.put(BUNDLE_URL, v2.bytes);
    await again.store.preview({ url: BUNDLE_URL });
    expect((await again.store.install({ digest: v2.digest, grant: ["chat"] })).equivocation).toBeUndefined();
  });

  it("with no app installed the check asks nothing", async () => {
    await net.putStore(await storeFiles());
    expect(await apps(net).checkUpdates()).toEqual([]);
    expect(net.requests).toEqual([]);
  });
});

describe("before a run", () => {
  it("a publisher's revocation stops the app with no Run anyway, from a store or beside its source", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest])]));
    await store.checkUpdates();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
    await expect(store.entry({ ref: v1.ref, runAnyway: true })).rejects.toThrow(/^revoked/);
    await expect(store.file({ ref: v1.ref, path: "index.html" })).rejects.toThrow(/^revoked/);
  });

  it("a revocation by another key is not taken", async () => {
    const v1 = await bundle();
    const other = await bundle({ by: signer("other") });
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    // A store copies a revocation of another app verbatim: it names that app, so it does not touch this one.
    await net.putStore(await storeFiles({ revoked: [await (await import("@ghostly/core")).signAppRevocation({ ghostlyRevoke: 1, app: other.ref, upTo: 9 }, signer("other"))] }));
    await store.addStore({ url: STORE_URL });
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "ok" });
  });

  it("a store's removal warns: the app runs only with Run anyway, and is not installable", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    await net.putStore(await storeFiles({ removed: [{ ref: v1.ref, digest: v1.digest, reason: "Malware", at: NOW_MS / 1000 }] }));
    await store.addStore({ url: STORE_URL });
    expect(await store.runCheck({ ref: v1.ref })).toMatchObject({ status: "removed", by: [{ name: "Test store", reason: "Malware" }] });
    await expect(store.entry({ ref: v1.ref })).rejects.toThrow(/^removed: Removed by Test store: Malware/);
    expect((await store.entry({ ref: v1.ref, runAnyway: true })).digest).toBe(v1.digest);
    await store.uninstall({ ref: v1.ref });
    await store.preview({ url: BUNDLE_URL });
    await expect(store.install({ digest: v1.digest, grant: ["chat"] })).rejects.toThrow(/^removed/);
  });

  it("stored files that no longer match are not run", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const files = await fileBytes();
    const id = `app-${v1.digest}`;
    const bytes = await files.read(id, 0, v1.bytes.length);
    bytes[bytes.length - 1] ^= 1;
    await files.remove(id);
    await files.append(id, 0, bytes);
    await files.flush(id);
    await expect(apps(net).entry({ ref: v1.ref })).rejects.toThrow(/^damaged/);
  });
});

describe("a restored profile (installed list, no bundle)", () => {
  async function restored() {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    await (await fileBytes()).remove(`app-${v1.digest}`);
    net.requests.length = 0;
    return { v1, store: apps(net) };
  }

  it("says the files are missing, and fetches them again by digest on the first open", async () => {
    const { v1, store } = await restored();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "needs-files" });
    expect((await store.list())[0]!.run).toEqual({ status: "needs-files" });
    expect(net.requests, "listing and checking ask nothing").toEqual([]);
    const entry = await store.entry({ ref: v1.ref });
    expect(entry.digest).toBe(v1.digest);
    expect(net.requests).toEqual([BUNDLE_URL]);
    expect(await bundleIds()).toEqual([`app-${v1.digest}`]);
  });

  it("takes only the installed digest: another version at the URL leaves it needing its files, never run unchecked", async () => {
    const { v1, store } = await restored();
    net.put(BUNDLE_URL, (await bundle({ sequence: 2 })).bytes);
    expect(await store.fetchFiles({ ref: v1.ref })).toEqual({ status: "needs-files" });
    await expect(store.entry({ ref: v1.ref })).rejects.toThrow(/^needs-files/);
    net.files.delete(BUNDLE_URL);
    await expect(store.entry({ ref: v1.ref })).rejects.toThrow(/^needs-files/);
    expect(await bundleIds()).toEqual([]);
  });

  it("a store listing of that digest is a source too, and so is installing the same version again", async () => {
    const { v1, store } = await restored();
    net.files.delete(BUNDLE_URL);
    net.put(PINNED_URL, v1.bytes);
    await net.putStore(await storeFiles({ apps: [listing(v1, [PINNED_URL])] }));
    await store.addStore({ url: STORE_URL });
    expect(await store.fetchFiles({ ref: v1.ref })).toEqual({ status: "ok" });

    await (await fileBytes()).remove(`app-${v1.digest}`);
    await store.preview({ url: PINNED_URL });
    expect(await store.install({ digest: v1.digest, grant: ["chat"] })).toMatchObject({ run: { status: "ok" } });
  });
});

it("the publisher is shown by its fingerprint: 16 z-base32 characters in four groups", async () => {
  const v1 = await bundle();
  net.put(BUNDLE_URL, v1.bytes);
  const preview = await apps(net).preview({ url: BUNDLE_URL });
  expect(preview.fingerprint).toBe(keyOf(PUBLISHER).slice(0, 16).match(/.{4}/g)!.join(" "));
});
