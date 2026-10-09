import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Apps } from "../src/engine/apps";
import { FakeNet, apps, bundle, emptyProfile, iconPng } from "./appsSupport";
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

/** A fresh engine (a page reloaded), and how many times it reads a bundle back from file storage. */
function freshEngine(): { store: Apps; reads: () => number } {
  const store = apps(net);
  const spy = vi.spyOn(store as unknown as { readBundleBytes: (...args: unknown[]) => Promise<Uint8Array | null> }, "readBundleBytes");
  return { store, reads: () => spy.mock.calls.length };
}

describe("installed bundles read back", () => {
  it("the Apps page with three apps, opened three times, reads each bundle once", async () => {
    const installed = await installMany(3);
    const { store, reads } = freshEngine();
    for (let visit = 0; visit < 3; visit++) {
      const icons = await Promise.all(installed.map(({ ref }) => store.file({ ref, path: "icon.png" })));
      expect(icons).toEqual(installed.map(({ icon }) => icon));
    }
    expect(reads()).toBe(3);
  });

  it("four cards of one app drawn at once read its bundle once", async () => {
    const [{ ref, icon }] = await installMany(1);
    const { store, reads } = freshEngine();
    expect(await Promise.all([1, 2, 3, 4].map(() => store.file({ ref, path: "icon.png" })))).toEqual([icon, icon, icon, icon]);
    expect(reads()).toBe(1);
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

  it("an uninstalled app's icon is not handed out any more", async () => {
    const [{ ref }] = await installMany(1);
    const { store } = freshEngine();
    await store.file({ ref, path: "icon.png" });
    await store.uninstall({ ref });
    await expect(store.file({ ref, path: "icon.png" })).rejects.toThrow(/^not-installed/);
  });
});
