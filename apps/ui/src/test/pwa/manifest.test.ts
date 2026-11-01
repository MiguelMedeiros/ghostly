import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHARE_TARGET_PATH } from "../../../../web/src/sw/policy";

// covers: app.pwa.install, app.pwa.shortcuts, app.pwa.share-target, app.pwa.protocol

/**
 * The web app's manifest, checked the way a browser decides the app can be installed (Lighthouse no longer has a
 * PWA category, so this is the check CI runs), and against the code that answers what it declares.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const manifest = JSON.parse(read("apps/web/public/manifest.json"));
const html = read("apps/web/index.html");
const routes = read("apps/ui/src/Root.tsx");

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
    for (const icon of manifest.icons) expect(() => read(`apps/web/public${icon.src}`)).not.toThrow();
  });
});

describe("a link to the app, shared", () => {
  /** The `content` of the page's meta tag with this name or property, or undefined. */
  const meta = (key: string) => new RegExp(`<meta (?:name|property)="${key.replace(/[:.]/g, "\\$&")}" content="([^"]*)" />`).exec(html)?.[1];

  it("shows the app's description and the website's share card, not a bare \"Ghostly\"", () => {
    expect(meta("description")).toBe(manifest.description);
    expect(meta("og:description")).toBe(manifest.description);
    expect(meta("og:title")).toBe(manifest.name);
    expect(meta("og:site_name")).toBe(manifest.name);
    expect(meta("og:type")).toBe("website");
    expect(meta("twitter:card")).toBe("summary_large_image");
    // The website's image (apps/website/lib/pageMeta.ts), at its size: absolute, so it is the same from any host.
    const website = read("apps/website/lib/pageMeta.ts");
    expect(meta("og:image")).toBe("https://ghostly.tools/og-image.png");
    expect(website).toContain("url: `${SITE_URL}/og-image.png`");
    expect(website).toContain('export const SITE_URL = "https://ghostly.tools"');
    expect(() => read("apps/website/public/og-image.png")).not.toThrow();
    expect([meta("og:image:width"), meta("og:image:height")]).toEqual(["1200", "630"]);
    expect(meta("og:image:alt")).toBe(/alt: "([^"]+)"/.exec(website)?.[1]);
    // No og:url: a card links to the address that was shared (an invite in its fragment, another host's copy).
    expect(meta("og:url")).toBeUndefined();
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

  it("a link to the app (the Add a device QR code, opened by a phone's camera) opens the installed app, in its open window", () => {
    expect(manifest.handle_links).toBe("preferred");
    expect(manifest.launch_handler).toEqual({ client_mode: ["navigate-existing", "auto"] });
    // A device code arriving in a window that is open already changes only the fragment: the router's intake takes it.
    expect(routes).toContain("isDeviceCode(rest)");
  });
});
