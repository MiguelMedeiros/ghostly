import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../public/manifest.json";
import servicesAr from "../../ui/src/locales/ar/services.json";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { resetEngine } from "./fakeEngine";
import { PEER, SERVICE, TAG, bootExtension, restartServiceWorker } from "./extension";

// covers: extension.engine, services.add, app.updates.extension, proofs.oidc.callback.extension

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

let world: FakeWorld;

beforeEach(async () => {
  resetEngine();
  world = await bootExtension();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what the extension may do, as the manifest declares it", () => {
  it("asks only for what the peer needs up front", () => {
    // `browsingData`: what a contact's app kept on its viewer origin goes with its chat or the profile (`forgetServices`).
    expect(manifest.permissions).toEqual(["offscreen", "storage", "debugger", "browsingData"]);
    expect(manifest.optional_permissions).toEqual(["notifications", "identity"]);
    expect(manifest).not.toHaveProperty("host_permissions");
  });

  it("uses the debugger from the service worker only", () => {
    // `debugger` cannot be an optional permission in Chrome, so it is declared; background.ts scopes it.
    const src = resolve(__dirname, "../src");
    const callers = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => /chrome\s*\.\s*debugger|\["debugger"\]/.test(readFileSync(resolve(src, file), "utf8")));
    expect(callers).toEqual(["background.ts"]);
  });

  it("can only ever be granted this machine's hosts", () => {
    for (const pattern of manifest.optional_host_permissions) {
      expect(pattern).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])\/\*$/);
    }
  });

  it("lets no web page or other extension talk to it or load its files", () => {
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("web_accessible_resources");
  });

  it("runs no code it did not ship", () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(csp).not.toMatch(/'unsafe-eval'|script-src[^;]*('unsafe-inline'|https?:)/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("loads nothing else from, and sends nothing to, a host it does not need", () => {
    const directives = new Map(manifest.content_security_policy.extension_pages.split(";").map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }));
    // A load with no directive of its own falls back to default-src: frames, media, fonts and styles stay on the extension.
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives.get("font-src")).toEqual(["'self'", "data:"]);
    expect(directives.get("media-src")).toEqual(["'self'", "blob:"]);
    expect(directives.get("frame-src")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'none'"]);
    // Only the shipped scripts can connect (script-src above). The engine checks itself that plain HTTP and WS stay on
    // this machine (pairedTransports, http.ts), which a policy cannot say: Chrome takes no [::1] in a source.
    expect(directives.get("connect-src")).toEqual(["'self'", "https:", "wss:", "http:", "ws:", "data:", "blob:"]);
  });
});

describe("the host the app page runs on", () => {
  const load = () => world.load("page", () => import("../src/host.ts"));

  it("asks Chrome for one local origin, and reports what the person chose", async () => {
    const { extensionHost } = await load();
    expect(await extensionHost.requestLocalAccess!("http://127.0.0.1/*", "http://127.0.0.1:3400")).toBe(true);
    world.permissionsGranted = false;
    expect(await extensionHost.requestLocalAccess!("http://localhost/*", "http://localhost:3400")).toBe(false);
    expect(world.callsTo("permissions.request")).toEqual([[{ origins: ["http://127.0.0.1/*"] }], [{ origins: ["http://localhost/*"] }]]);
  });

  it("says what went wrong when the worker refuses a payment link or a service", async () => {
    const { extensionHost } = await load();
    await expect(extensionHost.openPaymentLink!("https://evil.example")).rejects.toThrow("Not a payment link");
    await expect(extensionHost.openService!("not-a-key", "atlas", "ybndrfg8ejkmcpqx")).rejects.toThrow("Invalid service");
    await extensionHost.openPaymentLink!("lightning:lnbc1");
    expect(world.callsTo("tabs.create")).toEqual([["lightning:lnbc1"]]);
  });

  it("hands the worker a contact's app's error page in the profile's language", async () => {
    const { extensionHost } = await load();
    const { loadSettings, saveSettings } = await import("../../ui/src/lib/settings");
    const { loadLocale } = await import("../../ui/src/locales");
    saveSettings({ ...loadSettings(), language: "ar" });
    await loadLocale("ar");
    await extensionHost.openService!(PEER, SERVICE, TAG);
    const [tabId] = [...world.tabs.keys()];
    expect(world.session.get(`viewer:${tabId}`)).toMatchObject({
      page: { lang: "ar", dir: "rtl", unreachable: servicesAr.window.unreachable, failed: servicesAr.window.failed },
    });
  });

  it("reports the manifest's version", async () => {
    const { extensionHost } = await load();
    expect(extensionHost.version).toBe(manifest.version);
  });
});

describe("sign-in for an identity proof", () => {
  const load = async () => (await world.load("page", () => import("../src/oidc.ts"))).extensionOidc;

  it("asks for the identity permission synchronously, inside the person's click", async () => {
    const oidc = await load();
    void oidc.open();
    // No await between the click and the request: Chrome shows its prompt only from a gesture.
    expect(world.callsTo("permissions.request")).toEqual([[{ permissions: ["identity"] }]]);
  });

  it("redirects to the extension's own chromiumapp.org address and returns Chrome's answer", async () => {
    const oidc = await load();
    const session = await oidc.open();
    expect(session.redirectUri).toBe(`https://${world.chrome.runtime.id}.chromiumapp.org/oidc`);
    world.webAuthFlow = async () => `${session.redirectUri}#id_token=t&state=s`;
    const answer = await session.authorize("https://accounts.example/authorize?x=1", new AbortController().signal);
    expect(answer).toBe(`${session.redirectUri}#id_token=t&state=s`);
    expect(world.callsTo("identity.launchWebAuthFlow")).toEqual([[{ url: "https://accounts.example/authorize?x=1", interactive: true }]]);
  });

  it("does not open the provider without the permission", async () => {
    world.permissionsGranted = false;
    const oidc = await load();
    const session = await oidc.open();
    await expect(session.authorize("https://accounts.example/", new AbortController().signal)).rejects.toThrow("sign-in permission");
    expect(world.callsTo("identity.launchWebAuthFlow")).toEqual([]);
  });

  it("stops when cancelled, before or during the flow, and when Chrome returns nothing", async () => {
    const oidc = await load();
    const session = await oidc.open();

    const before = new AbortController();
    before.abort();
    await expect(session.authorize("https://accounts.example/", before.signal)).rejects.toThrow();
    expect(world.callsTo("identity.launchWebAuthFlow")).toEqual([]);

    world.webAuthFlow = () => new Promise(() => {});
    const during = new AbortController();
    const pending = session.authorize("https://accounts.example/", during.signal);
    await settle();
    during.abort();
    await expect(pending).rejects.toThrow("Sign-in cancelled");

    world.webAuthFlow = async () => undefined;
    await expect(session.authorize("https://accounts.example/", new AbortController().signal)).rejects.toThrow("Sign-in was cancelled.");
  });
});

describe("updates", () => {
  const load = async () => (await world.load("page", () => import("../src/updates.ts"))).extensionUpdates;

  it("an unpacked install only reads the feed and says the person must replace it", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ version: "9.0.0" })));
    vi.stubGlobal("fetch", fetch);
    const updates = await load();
    expect(await updates.check()).toMatchObject({ version: "9.0.0", apply: "manual" });
    expect(fetch).toHaveBeenCalledWith("https://ghostly.tools/latest.json", expect.objectContaining({ credentials: "omit", referrerPolicy: "no-referrer" }));
    expect(world.callsTo("runtime.requestUpdateCheck")).toEqual([]);
  });

  it("a store install asks Chrome, and never the network itself", async () => {
    world.manifest.update_url = "https://clients2.google.com/service/update2/crx";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const updates = await load();
    expect(await updates.check()).toBeNull();
    world.updateCheck = { status: "update_available", version: "0.5.0" };
    expect(await updates.check()).toEqual({ version: "0.5.0", apply: "restart" });
    world.updateCheck = { status: "throttled" };
    expect(await updates.check()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("installs by reloading, which is what lets Chrome swap the version in", async () => {
    const updates = await load();
    await updates.install({ version: "0.5.0", apply: "restart" });
    expect(world.callsTo("runtime.reload")).toHaveLength(1);
  });

  it("brings the app back after Update and restart, at the pages that were open", async () => {
    const app = world.chrome.runtime.getURL("app.html");
    await world.chrome.tabs.create({ url: `${app}#/chat/abc` });
    await world.chrome.tabs.create({ url: "https://example.com/" });
    await world.chrome.tabs.create({ url: `${app}#/settings` });
    const updates = await load();
    await updates.install({ version: "0.5.0", apply: "restart" });

    // The reload closes every page of the extension and forgets its session storage; the new version's worker starts.
    for (const tab of [...world.tabs.values()]) if (tab.url.startsWith(app)) world.tabs.delete(tab.id);
    world.session.clear();
    await restartServiceWorker(world);
    world.calls.length = 0;
    fire(world.chrome.runtime.onInstalled, { reason: "update", previousVersion: "0.4.0" });
    await settle();
    expect(world.callsTo("tabs.create")).toEqual([[`${app}#/chat/abc`], [`${app}#/settings`]]);

    // Only that once: an update nobody asked for here opens nothing.
    fire(world.chrome.runtime.onInstalled, { reason: "update", previousVersion: "0.5.0" });
    await settle();
    expect(world.callsTo("tabs.create")).toHaveLength(2);
  });

  it("opens the app once after Update and restart even when no tab of it is found, and never another page", async () => {
    const app = world.chrome.runtime.getURL("app.html");
    world.local.set("ghostly_reopen_after_update", ["https://example.com/", `${app}#/chats`, "javascript:alert(1)"]);
    fire(world.chrome.runtime.onInstalled, { reason: "update", previousVersion: "0.4.0" });
    await settle();
    expect(world.callsTo("tabs.create")).toEqual([[`${app}#/chats`]]);

    world.tabs.clear();
    const updates = await load();
    await updates.install({ version: "0.5.0", apply: "restart" });
    world.calls.length = 0;
    fire(world.chrome.runtime.onInstalled, { reason: "update", previousVersion: "0.4.0" });
    await settle();
    expect(world.callsTo("tabs.create")).toEqual([[app]]);
  });
});
