import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../public/manifest.json";
import { settle, type FakeWorld } from "./fakeChrome";
import { resetEngine } from "./fakeEngine";
import { bootExtension } from "./extension";

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
    expect(manifest.permissions).toEqual(["offscreen", "storage", "debugger"]);
    expect(manifest.optional_permissions).toEqual(["notifications", "identity"]);
    expect(manifest).not.toHaveProperty("host_permissions");
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
    expect(csp).not.toMatch(/'unsafe-eval'|'unsafe-inline'|script-src[^;]*https?:/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("the host the app page runs on", () => {
  const load = () => world.load("page", () => import("../src/host.ts"));

  it("asks Chrome for one local origin, and reports what the person chose", async () => {
    const { extensionHost } = await load();
    expect(await extensionHost.requestLocalAccess!("http://127.0.0.1/*")).toBe(true);
    world.permissionsGranted = false;
    expect(await extensionHost.requestLocalAccess!("http://localhost/*")).toBe(false);
    expect(world.callsTo("permissions.request")).toEqual([[{ origins: ["http://127.0.0.1/*"] }], [{ origins: ["http://localhost/*"] }]]);
  });

  it("says what went wrong when the worker refuses a payment link or a service", async () => {
    const { extensionHost } = await load();
    await expect(extensionHost.openPaymentLink!("https://evil.example")).rejects.toThrow("Not a payment link");
    await expect(extensionHost.openService!("not-a-key", "atlas")).rejects.toThrow("Invalid service");
    await extensionHost.openPaymentLink!("lightning:lnbc1");
    expect(world.callsTo("tabs.create")).toEqual([["lightning:lnbc1"]]);
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
});
