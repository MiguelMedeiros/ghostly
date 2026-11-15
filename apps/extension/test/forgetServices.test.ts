import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { resetEngine } from "./fakeEngine";
import { MAX_SERVICES, toZ32, viewerTag } from "@ghostly/core";
import { OPENED_KEY } from "../../ui/src/lib/openedServices";
import { OTHER_PEER, OTHER_TAG, PEER, SERVICE, TAG, bootExtension, useProfile } from "./extension";

// covers: services.open

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);
// The chats the page's peer sends it, with the apps each contact lists.
const pageEngine = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  type Link = { myPubKeyZ32: string; peerPubKeyZ32: string; peerServices: { id: string; type: string }[] | null };
  return {
    state: null as null | { links: Link[]; edges?: Link[] },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    linkByPeer: () => undefined,
    send(links: Link[], edges?: Link[]) { pageEngine.state = { links, edges }; for (const listener of [...listeners]) listener(); },
    reset() { pageEngine.state = null; listeners.clear(); },
  };
});
vi.mock("@ghostly/browser/platform/engine", async (original) => ({ ...(await original<object>()), engine: pageEngine }));

/** What a contact's app may have kept on its viewer origin: everything Chrome lets an extension clear for one. */
const KEPT = { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true, cache: true };
const WORK = "work000000";
const origin = (peer: string, tag: string, service = SERVICE) => `https://${service}.${peer}.${tag}.invalid`;

let world: FakeWorld;

beforeEach(async () => {
  resetEngine();
  pageEngine.reset();
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
    await extensionHost.openService(PEER, SERVICE, TAG, false);
    await extensionHost.openService(PEER, "notes", TAG, false);
    await extensionHost.openService(OTHER_PEER, SERVICE, OTHER_TAG, false);
    const [viewer] = [...world.tabs.values()].filter((tab) => tab.url === `${origin(PEER, TAG)}/`);

    await forgetServicesOf({ tag: TAG });
    expect(removed()).toEqual([[{ origins: [origin(PEER, TAG)] }, KEPT], [{ origins: [origin(PEER, TAG, "notes")] }, KEPT]]);
    expect(world.tabs.has(viewer.id)).toBe(false);
    expect([...world.tabs.values()].map((tab) => tab.url)).toEqual([`${origin(OTHER_PEER, OTHER_TAG)}/`]);

    // Cleared once: a second Delete of the same chat has nothing left to clear.
    await forgetServicesOf({ tag: TAG });
    expect(removed()).toHaveLength(2);
  });

  it("goes with its chat and its profile though no list noted it open: every app the chat lists is noted", async () => {
    // Opened before this version kept its list: only the chat's list of apps names it.
    const { forgetServicesOf } = await page();
    const me = OTHER_PEER;
    pageEngine.send([
      { myPubKeyZ32: me, peerPubKeyZ32: PEER, peerServices: [{ id: SERVICE, type: "http" }, { id: "notes", type: "http" }] },
      { myPubKeyZ32: PEER, peerPubKeyZ32: OTHER_PEER, peerServices: null },
    ]);
    // The same list again, with every state: noted once.
    pageEngine.send([{ myPubKeyZ32: me, peerPubKeyZ32: PEER, peerServices: [{ id: SERVICE, type: "http" }, { id: "notes", type: "http" }] }]);

    await forgetServicesOf({ tag: viewerTag(me) });
    expect(removed()).toEqual([[{ origins: [origin(PEER, viewerTag(me))] }, KEPT], [{ origins: [origin(PEER, viewerTag(me), "notes")] }, KEPT]]);

    pageEngine.send([{ myPubKeyZ32: me, peerPubKeyZ32: PEER, peerServices: [{ id: "chess", type: "http" }] }]);
    await forgetServicesOf({ profile: "" });
    expect(removed()).toHaveLength(3);
    expect(removed()[2]).toEqual([{ origins: [origin(PEER, viewerTag(me), "chess")] }, KEPT]);
  });

  it("a page reads and writes the list once for all the apps its chats list, not once per app", async () => {
    // Each read checks every entry's address: once per app, a page's first state would cost the square of them.
    const { forgetServicesOf } = await page();
    const key = (n: number) => toZ32(new Uint8Array(32).fill(n));
    const links = Array.from({ length: 20 }, (_, i) => ({ myPubKeyZ32: key(i + 1), peerPubKeyZ32: key(i + 101), peerServices: [{ id: SERVICE, type: "http" }, { id: "notes", type: "http" }] }));
    const reads = vi.spyOn(localStorage, "getItem");
    const writes = vi.spyOn(localStorage, "setItem");
    const ofList = (spy: typeof reads | typeof writes) => spy.mock.calls.filter(([k]) => k === OPENED_KEY).length;
    pageEngine.send(links);
    expect([ofList(reads), ofList(writes)]).toEqual([1, 1]);

    // The next page, with all of them on the list already: one read, nothing to write.
    pageEngine.reset();
    vi.resetModules();
    await page();
    reads.mockClear();
    writes.mockClear();
    pageEngine.send(links);
    expect([ofList(reads), ofList(writes)]).toEqual([1, 0]);

    await forgetServicesOf({ profile: "" });
    expect(removed()).toHaveLength(40);
  });

  it("notes only the web apps a chat lists, and no more of them than one list holds, however many new ones its contact lists", async () => {
    const { extensionHost, forgetServicesOf } = await page();
    const me = OTHER_PEER;
    // Chat, voice and video open in no viewer tab: no origin of theirs to clear.
    pageEngine.send([{ myPubKeyZ32: me, peerPubKeyZ32: PEER, peerServices: ["chat", "voice", "video"].map((id) => ({ id, type: id })) }]);
    // A contact lists at most MAX_SERVICES apps at a time, but a new list of new ones at any time.
    for (let round = 0; round < 20; round++) {
      pageEngine.send([{ myPubKeyZ32: me, peerPubKeyZ32: PEER, peerServices: Array.from({ length: MAX_SERVICES }, (_, i) => ({ id: `app-${round}-${i}`, type: "http" })) }]);
    }
    const tag = viewerTag(me);
    const listed = () => (JSON.parse(localStorage.getItem(OPENED_KEY) ?? "[]") as { tag: string; service: string }[]).filter((o) => o.tag === tag);
    expect(listed()).toHaveLength(MAX_SERVICES);
    expect(listed().map((o) => o.service)).toEqual(Array.from({ length: MAX_SERVICES }, (_, i) => `app-0-${i}`));

    // One the person opens is still noted: what it keeps goes with the chat.
    await extensionHost.openService(PEER, "opened", tag, false);
    expect(listed()).toHaveLength(MAX_SERVICES + 1);

    // Delete chat clears no more origins than that.
    await forgetServicesOf({ tag });
    expect(removed()).toHaveLength(MAX_SERVICES + 1);
  });

  it("notes the apps a group member lists too: one opens from their chat in the group as from a contact's", async () => {
    const { forgetServicesOf } = await page();
    const me = OTHER_PEER;
    pageEngine.send([], [{ myPubKeyZ32: me, peerPubKeyZ32: PEER, peerServices: [{ id: SERVICE, type: "http" }] }]);
    await forgetServicesOf({ tag: viewerTag(me) });
    expect(removed()).toEqual([[{ origins: [origin(PEER, viewerTag(me))] }, KEPT]]);
  });

  it("a viewer tab whose debugger was cancelled still closes before its origin is cleared", async () => {
    const { extensionHost, forgetServicesOf } = await page();
    await extensionHost.openService(PEER, SERVICE, TAG, false);
    const [viewer] = [...world.tabs.values()].filter((tab) => tab.url === `${origin(PEER, TAG)}/`);
    // "Cancel" on Chrome's debugging bar: the tab loses its binding but stays open, the app still running in it.
    fire(world.chrome.debugger.onDetach, { tabId: viewer.id }, "canceled_by_user");
    await settle();
    expect(world.tabs.has(viewer.id)).toBe(true);

    await forgetServicesOf({ tag: TAG });
    expect(removed()).toHaveLength(1);
    expect(world.tabs.has(viewer.id)).toBe(false);
  });

  it("goes with its profile (Clear all data, Delete profile), and another profile's stays", async () => {
    await (await page()).extensionHost.openService(PEER, SERVICE, TAG, false);
    // Another page, started once WORK is the profile in use, opens one as that profile.
    useProfile(world, WORK);
    vi.resetModules();
    const { extensionHost, forgetServicesOf } = await page();
    await extensionHost.openService(OTHER_PEER, SERVICE, OTHER_TAG, false);

    await forgetServicesOf({ profile: "" });
    expect(removed()).toEqual([[{ origins: [origin(PEER, TAG)] }, KEPT]]);
    await forgetServicesOf({ profile: WORK });
    expect(removed()).toEqual([[{ origins: [origin(PEER, TAG)] }, KEPT], [{ origins: [origin(OTHER_PEER, OTHER_TAG)] }, KEPT]]);
  });

  it("stays listed when Chrome did not clear it, and goes at the profile's next clear", async () => {
    const { extensionHost, forgetServicesOf } = await page();
    await extensionHost.openService(PEER, SERVICE, TAG, false);
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
