import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHARE_TARGET_PATH } from "../../../web/src/sw/policy";

// covers: app.pwa.install, app.pwa.shortcuts, app.pwa.share-target, app.pwa.protocol

/**
 * The web app's manifest, checked the way a browser decides the app can be installed (Lighthouse no longer has a
 * PWA category, so this is the check CI runs), and against the code that answers what it declares.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const manifest = JSON.parse(read("web/public/manifest.json"));
const html = read("web/index.html");
const routes = read("src/Root.tsx");

describe("installable", () => {
  it("is linked from the page, with the Apple tags for Add to Home Screen", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.json" />');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    expect(html).toContain('rel="apple-touch-icon"');
  });

  it("has what installing asks for: names, a start inside its scope, standalone, 192 and 512 icons, a maskable one", () => {
    expect(manifest.name).toBe("Ghostly");
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.id).toBe("/");
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    expect(manifest.display).toBe("standalone");
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) expect(() => read(`web/public${icon.src}`)).not.toThrow();
  });
});

describe("what it declares, the app answers", () => {
  it("each shortcut opens a route the app has", () => {
    const urls = manifest.shortcuts.map((s: { url: string }) => s.url);
    expect(urls).toEqual(["/#/new", "/#/scan", "/#/wallet"]);
    for (const url of urls) expect(routes).toContain(`path="${url.slice(2)}"`);
    expect(manifest.shortcuts.map((s: { name: string }) => s.name)).toEqual(["New chat", "Scan invite", "Wallets"]);
  });

  it("the share target posts, as a form with files, where the worker takes it", () => {
    expect(manifest.share_target).toMatchObject({ action: SHARE_TARGET_PATH, method: "POST", enctype: "multipart/form-data" });
    expect(manifest.share_target.params).toMatchObject({ title: "title", text: "text", url: "url" });
    expect(manifest.share_target.params.files[0].name).toBe("files");
  });

  it("web+ghostly: links open the app with the link in the fragment", () => {
    expect(manifest.protocol_handlers).toEqual([{ protocol: "web+ghostly", url: "/#%s" }]);
  });
});
