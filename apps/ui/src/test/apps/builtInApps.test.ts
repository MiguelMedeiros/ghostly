import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appRef, isAppKey, readAppBundleAsync } from "@ghostly/core";
import { BUILT_IN_APPS } from "@ghostly/browser/engine/appDefaults";
import { isAppFetchUrl } from "@ghostly/browser/engine/appFetch";
import { readBuiltInApp } from "../../lib/apps/builtIns";
// @ts-expect-error a plain script of the build, with no types of its own
import { bundleDigest, sourcesOf } from "../../../scripts/built-in-apps.mjs";
// covers: apps.engine.built-in

/*
 * The apps that come with Ghostly (WISP 1200 § Built-in apps): the file this build carries for each entry of the
 * engine's list is the bundle the entry pins, signed by the entry's publisher, and the client reads it from its own
 * files only. The files are not in the repository: `npm ci` (or `npm run sync:apps`) reads each from its app's own
 * repository at the pinned commit, so a test here that finds none says to run it.
 */

const DIR = join(import.meta.dirname, "..", "..", "assets", "apps");
function file(name: string): Uint8Array {
  try { return new Uint8Array(readFileSync(join(DIR, `${name}.ghostlyapp`))); } catch { throw new Error(`No ${name}.ghostlyapp in apps/ui/src/assets/apps: run npm run sync:apps`); }
}
const pins = JSON.parse(readFileSync(join(DIR, "built-in.json"), "utf8")) as { name: string; digest: string; url: string }[];

afterEach(() => { vi.unstubAllGlobals(); });

describe("the bundles this build carries", () => {
  it("the list is short, whole, and names each app once", () => {
    expect(BUILT_IN_APPS.map((app) => app.name)).toEqual(["chess"]);
    for (const app of BUILT_IN_APPS) {
      expect(isAppKey(app.publisher), app.name).toBe(true);
      expect(isAppFetchUrl(app.url), app.url).toBe(true);
      // Pinned to a commit: what the URL holds never changes under the digest.
      expect(app.url).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/gh\/[^/]+\/[^/@]+@[0-9a-f]{40}\//);
    }
  });

  it("what the build reads is what the engine pins: the same apps, digests and URLs", () => {
    expect(pins).toEqual(BUILT_IN_APPS.map(({ name, digest, url }) => ({ name, digest, url })));
  });

  it("the build reads a bundle only at a commit, from jsDelivr or the same commit on GitHub, and tells it by its digest", () => {
    expect(sourcesOf(BUILT_IN_APPS[0]!.url)).toEqual([
      BUILT_IN_APPS[0]!.url,
      "https://raw.githubusercontent.com/MiguelMedeiros/ghostly-chess/c665ab194478145fd9b9a4777e6c0d1893969649/app.ghostlyapp",
    ]);
    for (const moving of ["https://cdn.jsdelivr.net/gh/ana/chess@main/app.ghostlyapp", "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp", "https://example.com/app.ghostlyapp"]) {
      expect(() => sourcesOf(moving), moving).toThrow("pinned to a commit");
    }
    const bytes = Buffer.from(file("chess"));
    expect(bundleDigest(bytes)).toBe(BUILT_IN_APPS[0]!.digest);
    expect(bundleDigest(bytes.subarray(0, 8))).toBeNull();
    expect(bundleDigest(Buffer.from("<!doctype html>not a bundle at all"))).toBeNull();
  });

  it("each carried file is the bundle its entry pins: its digest, its publisher's signature and its reference", async () => {
    for (const app of BUILT_IN_APPS) {
      const read = await readAppBundleAsync(file(app.name));
      expect(read.ok, app.name).toBe(true);
      if (!read.ok) continue;
      expect(read.bundle.digest).toBe(app.digest);
      expect(appRef(read.bundle.manifest.publisher, read.bundle.manifest.name)).toBe(appRef(app.publisher, app.name));
      expect(read.bundle.manifest.runtime.clients).toEqual(expect.arrayContaining(["web", "desktop"]));
      // What its row shows before the file is read is what the bundle says of itself.
      expect({ title: app.title, tagline: app.tagline }).toEqual({ title: read.bundle.manifest.title, tagline: read.bundle.manifest.tagline });
    }
  });

  it("the reader asks this client's own files for an app the build carries, and nothing for any other", async () => {
    const bytes = file("chess");
    const fetched = vi.fn(async (_url: RequestInfo | URL) => new Response(bytes.slice(), { status: 200 }));
    vi.stubGlobal("fetch", fetched);
    expect(await readBuiltInApp(BUILT_IN_APPS[0]!)).toEqual(bytes);
    expect(fetched).toHaveBeenCalledTimes(1);
    // A path of this build, never another origin.
    expect(String(fetched.mock.calls[0]![0])).not.toMatch(/^[a-z]+:\/\/(?!localhost)/);

    await expect(readBuiltInApp({ name: "notes" })).rejects.toThrow("does not carry");
    await expect(readBuiltInApp({ name: "constructor" })).rejects.toThrow("does not carry");
    expect(fetched).toHaveBeenCalledTimes(1);

    fetched.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(readBuiltInApp(BUILT_IN_APPS[0]!)).rejects.toThrow("did not load (404)");
  });
});
