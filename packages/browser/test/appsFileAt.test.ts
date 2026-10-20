import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64Url } from "@ghostly/core";
import { fileBytesOf, fileSpace, registerFileBytes, resetFileBytes, type FileBytes } from "../src/shared/fileBytes";
import { BUNDLE_URL, FakeNet, apps, bundle, emptyProfile, iconPng } from "./appsSupport";
// covers: apps.engine.installed

/*
 * Desktop hands a bundle's file to the app's window from its own file storage (Rust), never through the Ghostly window:
 * the engine says where the file lies there (`fileAt`) after the same checks as `file`.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});
afterEach(() => resetFileBytes());

/** The browser's own file storage, standing in for Desktop's (`native`), which keeps real files through Rust. */
function nativeStandIn(): void {
  registerFileBytes("native", async () => {
    const idb = (await fileBytesOf("idb"))!;
    return new Proxy(idb, { get: (target, key) => (key === "kind" ? "native" : Reflect.get(target, key, target)) }) as FileBytes;
  }, true);
  resetFileBytes(["native", "idb"]);
}

async function installed(data?: Uint8Array) {
  const app = await bundle({ icon: iconPng(), data });
  net.put(BUNDLE_URL, app.bytes);
  const store = apps(net);
  await store.preview({ url: BUNDLE_URL });
  await store.install({ digest: app.digest, grant: ["chat"] });
  await store.entry({ ref: app.ref });
  return { store, app };
}

describe("where a bundle's file lies", () => {
  it("in Desktop's file storage: the stored bundle's bytes at that place are the file's, and its hash is the manifest's", async () => {
    nativeStandIn();
    const data = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251);
    const { store, app } = await installed(data);
    const at = await store.fileAt({ ref: app.ref, path: "data/assets.bin" });
    expect(at).toMatchObject({ space: fileSpace(), id: `app-${app.digest}`, length: data.length, sha256: toBase64Url(sha256(data)) });
    const files = (await fileBytesOf("native"))!;
    const read = new Uint8Array(at!.length);
    for (let got = 0; got < at!.length;) {
      const part = await files.read(at!.id, at!.offset + got, at!.length - got);
      read.set(part, got);
      got += part.length;
    }
    expect(read).toEqual(data);
    expect(read).toEqual(await store.file({ ref: app.ref, path: "data/assets.bin" }));
  });

  it("is not said for the icon, for a bundle kept in the browser, or for a file the bundle does not have", async () => {
    nativeStandIn();
    const { store, app } = await installed();
    expect(await store.fileAt({ ref: app.ref, path: "icon.png" })).toBeNull();
    await expect(store.fileAt({ ref: app.ref, path: "nope.txt" })).rejects.toThrow(/^no-file/);
    await expect(store.fileAt({ ref: app.ref, path: "data/openings.json", digest: "another version" })).rejects.toThrow(/^stopped/);
    resetFileBytes();
    await emptyProfile();
    const kept = await installed();
    expect(await kept.store.fileAt({ ref: kept.app.ref, path: "data/openings.json" })).toBeNull();
  });
});
