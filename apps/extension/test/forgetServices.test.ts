import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { resetEngine } from "./fakeEngine";
import { OTHER_PEER, OTHER_TAG, PEER, SERVICE, TAG, bootExtension, useProfile } from "./extension";

// covers: services.open

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

/** What a contact's app may have kept on its viewer origin: everything Chrome lets an extension clear for one. */
const KEPT = { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true, cache: true };
const WORK = "work000000";
const origin = (peer: string, tag: string, service = SERVICE) => `https://${service}.${peer}.${tag}.invalid`;

let world: FakeWorld;

beforeEach(async () => {
  resetEngine();
  world = await bootExtension();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The app page's host, and `forgetServicesOf` as Delete chat, Clear all data and Delete profile call it. */
async function page() {
  return world.load("page", async () => {
    const { extensionHost } = await import("../src/host.ts");
    const { setBrowserHost, forgetServicesOf } = await import("@ghostly/browser/host");
    setBrowserHost(extensionHost);
    return { extensionHost, forgetServicesOf };
  });
}

const removed = () => world.callsTo("browsingData.remove");

describe("what a contact's app kept in its viewer tab", () => {
  it("goes with its chat (Delete chat): that chat's origins only, and their tabs close first", async () => {
    const { extensionHost, forgetServicesOf } = await page();
    await extensionHost.openService(PEER, SERVICE, TAG);
    await extensionHost.openService(PEER, "notes", TAG);
    await extensionHost.openService(OTHER_PEER, SERVICE, OTHER_TAG);
    const [viewer] = [...world.tabs.values()].filter((tab) => tab.url === `${origin(PEER, TAG)}/`);

    await forgetServicesOf({ tag: TAG });
    expect(removed()).toEqual([[{ origins: [origin(PEER, TAG)] }, KEPT], [{ origins: [origin(PEER, TAG, "notes")] }, KEPT]]);
    expect(world.tabs.has(viewer.id)).toBe(false);
    expect([...world.tabs.values()].map((tab) => tab.url)).toEqual([`${origin(OTHER_PEER, OTHER_TAG)}/`]);

    // Cleared once: a second Delete of the same chat has nothing left to clear.
    await forgetServicesOf({ tag: TAG });
    expect(removed()).toHaveLength(2);
  });

  it("goes with its profile (Clear all data, Delete profile), and another profile's stays", async () => {
    await (await page()).extensionHost.openService(PEER, SERVICE, TAG);
    // Another page, started once WORK is the profile in use, opens one as that profile.
    useProfile(world, WORK);
    vi.resetModules();
    const { extensionHost, forgetServicesOf } = await page();
    await extensionHost.openService(OTHER_PEER, SERVICE, OTHER_TAG);

    await forgetServicesOf({ profile: "" });
    expect(removed()).toEqual([[{ origins: [origin(PEER, TAG)] }, KEPT]]);
    await forgetServicesOf({ profile: WORK });
    expect(removed()).toEqual([[{ origins: [origin(PEER, TAG)] }, KEPT], [{ origins: [origin(OTHER_PEER, OTHER_TAG)] }, KEPT]]);
  });

  it("stays listed when Chrome did not clear it, and goes at the profile's next clear", async () => {
    const { extensionHost, forgetServicesOf } = await page();
    await extensionHost.openService(PEER, SERVICE, TAG);
    world.failBrowsingData = "Chrome said no";
    await forgetServicesOf({ profile: "" });
    expect(removed()).toHaveLength(1);

    world.failBrowsingData = null;
    await forgetServicesOf({ profile: "" });
    await forgetServicesOf({ profile: "" });
    expect(removed()).toHaveLength(2);
  });

  it("clears no origin but a viewer's, whatever a page asks for", async () => {
    for (const [peer, service, tag] of [["not-a-key", SERVICE, TAG], [PEER, "a.b", TAG], [PEER, SERVICE, `${TAG}.invalid/x`]]) {
      const reply = await world.chrome.runtime.sendMessage({ target: "background", type: "forget-service", peerPubKeyZ32: peer, serviceId: service, tag });
      expect(reply).toEqual({ ok: false, error: "Invalid service" });
    }
    // Nor for anyone but the extension's own pages.
    await world.sendMessageFrom({ id: "another-extension", url: "chrome-extension://another-extension/x.html" }, { target: "background", type: "forget-service", peerPubKeyZ32: PEER, serviceId: SERVICE, tag: TAG }).catch(() => {});
    fire(world.chrome.runtime.onStartup);
    await settle();
    expect(removed()).toEqual([]);
  });
});
