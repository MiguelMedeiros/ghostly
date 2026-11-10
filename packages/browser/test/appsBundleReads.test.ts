import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Apps } from "../src/engine/apps";
import { fileBytesOf } from "../src/shared/fileBytes";
import { BUNDLE_URL, FakeNet, NOW_MS, apps, bundle, emptyProfile, iconPng } from "./appsSupport";
// covers: apps.engine.installed

/*
 * How often the engine reads an installed bundle back: every icon on the Apps page, in a chat's app cards and in the
 * composer's Apps is an `appFile icon.png`. A bundle is read and checked again once, not at every icon shown: with
 * three apps or more, or several cards of one app drawn at once, each icon read the whole bundle (up to 16 MiB) again.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

async function installMany(count: number, data?: Uint8Array): Promise<{ ref: string; icon: Uint8Array }[]> {
  const store = apps(net);
  const out: { ref: string; icon: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    const url = `https://raw.githubusercontent.com/ana/app${i}/HEAD/app.ghostlyapp`;
    const icon = iconPng(32 + i);
    const built = await bundle({ name: `app${i}`, icon, ...(data && { data }) });
    net.put(url, built.bytes);
    await store.preview({ url });
    await store.install({ digest: built.digest, grant: ["chat"] });
    out.push({ ref: built.ref, icon });
  }
  return out;
}

/** A fresh engine (a page reloaded), and how many times it reads a bundle back from file storage, whole or only its icon. */
function freshEngine(now?: () => number): { store: Apps; reads: () => number; iconReads: () => number } {
  const store = apps(net, now && { now });
  const spy = vi.spyOn(store as unknown as { readBundleBytes: (...args: unknown[]) => Promise<Uint8Array | null> }, "readBundleBytes");
  const icons = vi.spyOn(store as unknown as { storedIcon: (...args: unknown[]) => Promise<Uint8Array | null> }, "storedIcon");
  return { store, reads: () => spy.mock.calls.length, iconReads: () => icons.mock.calls.length };
}

describe("installed bundles read back", () => {
  it("the Apps page with three apps, opened three times, reads each icon once and no bundle whole", async () => {
    const installed = await installMany(3);
    const { store, reads, iconReads } = freshEngine();
    for (let visit = 0; visit < 3; visit++) {
      const icons = await Promise.all(installed.map(({ ref }) => store.file({ ref, path: "icon.png" })));
      expect(icons).toEqual(installed.map(({ icon }) => icon));
    }
    expect([iconReads(), reads()]).toEqual([3, 0]);
  });

  it("three apps running at once, reading their files in turn, read each bundle once", async () => {
    const installed = await installMany(3);
    const { store, reads } = freshEngine();
    for (const { ref } of installed) await store.entry({ ref });
    for (let round = 0; round < 3; round++) {
      for (const { ref } of installed) {
        expect(await store.file({ ref, path: "data/openings.json" })).toEqual(new TextEncoder().encode("[]"));
        // A file the bundle does not hold is refused from the kept bundle too, not after reading it all again.
        await expect(store.file({ ref, path: "no/such.json" })).rejects.toThrow(/^no-file/);
      }
    }
    // Before: two bundles kept, the oldest dropped first, so with three apps in turn each app's first read of a round was a miss (12).
    expect(reads()).toBe(3);
  });

  it("three apps running at once for minutes, each reading a file every 30 s, read each bundle once", async () => {
    const installed = await installMany(3);
    let now = NOW_MS;
    const { store, reads } = freshEngine(() => now);
    for (const { ref } of installed) await store.entry({ ref });
    for (let round = 0; round < 10; round++) {
      now += 30_000;
      for (const { ref } of installed) await store.file({ ref, path: "data/openings.json" });
    }
    expect(reads()).toBe(3);
  });

  it("apps opened one after another, each closed before the next, keep two checked bundles, not one each", async () => {
    const installed = await installMany(8);
    let now = NOW_MS;
    const { store } = freshEngine(() => now);
    const kept = store as unknown as { verified: Map<string, unknown> };
    for (const { ref } of installed) {
      await store.entry({ ref });
      await store.file({ ref, path: "data/openings.json" });
      // The person uses it a while and closes it before opening the next.
      now += 2 * 60_000;
    }
    // The Apps page drawn afterwards: its icons keep no bundle of an app that does not run.
    for (const { ref } of installed) await store.file({ ref, path: "icon.png" });
    // Before: one bundle for each app started in this engine's life (8, up to 16 MiB each), until a reload.
    expect(kept.verified.size).toBe(2);
  });

  it("apps opened within a minute, then one used for minutes, keep two checked bundles, not one each", async () => {
    const installed = await installMany(4);
    let now = NOW_MS;
    const { store, reads } = freshEngine(() => now);
    const kept = store as unknown as { verified: Map<string, unknown> };
    for (const { ref } of installed) {
      await store.entry({ ref });
      now += 8_000;
    }
    // The last one keeps running and reading its files; none of the others is read again.
    const { ref } = installed[installed.length - 1];
    for (let round = 0; round < 12; round++) {
      now += 10_000;
      await store.file({ ref, path: "data/openings.json" });
    }
    // Before: every bundle opened within the minute stayed (4, up to 16 MiB each) for as long as one app ran.
    expect(kept.verified.size).toBe(2);
    expect(reads()).toBe(4);
  });

  it("four cards of one app drawn at once read its icon once", async () => {
    const [{ ref, icon }] = await installMany(1);
    const { store, iconReads } = freshEngine();
    const files = (await fileBytesOf("idb"))!;
    const read = vi.spyOn(files, "read");
    expect(await Promise.all([1, 2, 3, 4].map(() => store.file({ ref, path: "icon.png" })))).toEqual([icon, icon, icon, icon]);
    // Four calls, one read from file storage: the head with the manifest, then the icon.
    expect([iconReads(), read.mock.calls.length]).toEqual([4, 2]);
    read.mockRestore();
  });

  it("the icons kept in memory hold the icons, not the whole bundles they were read from", async () => {
    const installed = await installMany(4, new Uint8Array(2 * 1024 * 1024).fill(7));
    const { store } = freshEngine();
    for (const { ref } of installed) await store.file({ ref, path: "icon.png" });
    // Every buffer the engine keeps alive, the two checked bundles of its cache (WISP 1200: "again before it runs") aside.
    const kept = store as unknown as { icons: Map<string, Uint8Array | null>; verified: Map<string, { files: Map<string, Uint8Array> }> };
    const cached = new Set([...kept.verified.values()].map((b) => b.files.get("index.html")!.buffer));
    const held = new Set([...kept.icons.values()].map((icon) => icon!.buffer).filter((buffer) => !cached.has(buffer)));
    const bytes = [...held].reduce((sum, buffer) => sum + buffer.byteLength, 0);
    // Before: the two bundles out of the cache stayed whole behind their icons (2 x 2 MiB); now 64 bytes per icon.
    expect(bytes).toBeLessThanOrEqual(4 * 64);
  });

  it("an icon handed out is a copy: changing it changes nothing kept", async () => {
    const [{ ref, icon }] = await installMany(1);
    const { store } = freshEngine();
    (await store.file({ ref, path: "icon.png" })).fill(0);
    expect(await store.file({ ref, path: "icon.png" })).toEqual(icon);
  });

  it("an icon kept for later holds only its own bytes, not the whole bundle it was read from", async () => {
    const installed = await installMany(3);
    const { store } = freshEngine();
    for (const { ref } of installed) await store.file({ ref, path: "icon.png" });
    const kept = [...(store as unknown as { icons: Map<string, Uint8Array | null> }).icons.values()];
    expect(kept.map((icon) => icon?.buffer.byteLength)).toEqual(installed.map(({ icon }) => icon.length));
  });

  it("twenty apps' icons drawn at once after a start read and hash about the icons' bytes, not every bundle whole", async () => {
    const installed = await installMany(20, new Uint8Array(1024 * 1024).fill(7));
    const { store, reads } = freshEngine();
    const files = (await fileBytesOf("idb"))!;
    let read = 0, hashed = 0;
    const realRead = files.read.bind(files);
    vi.spyOn(files, "read").mockImplementation(async (...args) => { const out = await realRead(...args); read += out.length; return out; });
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => { hashed += (data as Uint8Array).byteLength; return realDigest(algorithm, data); });
    try {
      expect(await Promise.all(installed.map(({ ref }) => store.file({ ref, path: "icon.png" })))).toEqual(installed.map(({ icon }) => icon));
    } finally { vi.restoreAllMocks(); }
    // Before: every bundle read back whole and hashed (20 reads in flight, 20 MiB read, 20 MiB hashed) for 20 icons of 64 bytes.
    expect({ whole: reads(), small: read <= 20 * (4 * 1024 + 64), read, hashed }).toEqual({ whole: 0, small: true, read, hashed: 0 });
  });

  it("an icon whose stored bytes changed since the install is refused, not handed out", async () => {
    const built = await bundle({ icon: iconPng() });
    net.put(BUNDLE_URL, built.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: built.digest, grant: ["chat"] });
    // The icon's last byte (its zero padding), which the entry follows in the bundle, flipped in file storage.
    const changed = built.bytes.slice();
    changed[changed.length - new TextEncoder().encode("<!doctype html><title>Chess</title><p>v1").length - 1] ^= 1;
    const files = (await fileBytesOf("idb"))!;
    await files.stage(`app-${built.digest}`, new Blob([changed]));
    await expect(apps(net).file({ ref: built.ref, path: "icon.png" })).rejects.toThrow(/^damaged/);
  });

  it("an uninstalled app's icon is not handed out any more", async () => {
    const [{ ref }] = await installMany(1);
    const { store } = freshEngine();
    await store.file({ ref, path: "icon.png" });
    await store.uninstall({ ref });
    await expect(store.file({ ref, path: "icon.png" })).rejects.toThrow(/^not-installed/);
  });
});
