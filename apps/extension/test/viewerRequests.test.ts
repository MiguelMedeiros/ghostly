import { beforeEach, describe, expect, it, vi } from "vitest";
import { settle, type FakeWorld } from "./fakeChrome";
import { engineControl, okResponse, resetEngine } from "./fakeEngine";
import { PEER, SERVICE, TAG, bodyText, bootExtension, endBootPeer, engine, openViewer, pauseRequest, restartServiceWorker } from "./extension";

// covers: services.open

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

let world: FakeWorld;

beforeEach(async () => {
  resetEngine();
  world = await bootExtension();
});

const url = `https://${SERVICE}.${PEER}.${TAG}.invalid/`;

/** What the worker asks of the browser while `act` runs: messages, session reads, document checks, and what each app tab heard. */
async function costOf(tabs: number, act: () => Promise<void>) {
  const heard: unknown[] = [];
  // Each app tab listens for the worker's messages as apps/ui/src/lib/notifications.ts does, and answers none of them.
  for (let i = 0; i < tabs; i++) world.within("page", () => world.chrome.runtime.onMessage.addListener((message: unknown) => (heard.push(message), false)));
  const session = world.chrome.storage.session;
  const get = session.get.bind(session);
  const hasDocument = world.chrome.offscreen.hasDocument.bind(world.chrome.offscreen);
  let reads = 0;
  let documentChecks = 0;
  session.get = ((key: string | null) => (reads++, get(key as never))) as typeof session.get;
  world.chrome.offscreen.hasDocument = (() => (documentChecks++, hasDocument())) as typeof world.chrome.offscreen.hasDocument;
  const before = world.callsTo("runtime.sendMessage").length;
  try {
    await act();
  } finally {
    session.get = get as typeof session.get;
    world.chrome.offscreen.hasDocument = hasDocument;
  }
  return { messages: world.callsTo("runtime.sendMessage").length - before, reads, documentChecks, heard };
}

describe("a contact's app's requests in its tab", () => {
  it("go to the peer alone, once each, with one read of the tab's binding: no app tab hears them, nor their body", async () => {
    const tabId = await openViewer(world);
    engineControl().respond = async () => okResponse("ok", 200, [["content-type", "text/plain"]]);
    const upload = Buffer.alloc(64 * 1024, 7).toString("base64");
    const cost = await costOf(4, async () => {
      for (let i = 0; i < 10; i++) expect((await pauseRequest(world, tabId, { url: `${url}asset/${i}.js` })).method).toBe("Fetch.fulfillRequest");
      const answer = await pauseRequest(world, tabId, { url: `${url}upload`, method: "POST", postDataEntries: [{ bytes: upload }] });
      expect(bodyText(answer.params)).toBe("ok");
    });
    expect(engine().requests).toHaveLength(11);
    expect(engine().requests[10].init.body).toHaveLength(64 * 1024);
    expect(cost.heard.map((message) => (message as { type?: string }).type)).toEqual([]);
    expect(cost.messages).toBe(0);
    expect(cost.documentChecks).toBe(0);
    expect(cost.reads).toBe(11);
  });

  it("start the peer and are asked once more when its document went away", async () => {
    const tabId = await openViewer(world);
    endBootPeer(world);
    engineControl().respond = async () => okResponse("back", 200, [["content-type", "text/plain"]]);
    const answer = await pauseRequest(world, tabId, { url });
    expect(answer.method).toBe("Fetch.fulfillRequest");
    expect(bodyText(answer.params)).toBe("back");
    expect(engine().requests).toHaveLength(1);
    expect(world.callsTo("offscreen.createDocument")).toHaveLength(2);
  });

  it("are answered when the worker stopped and started again meanwhile", async () => {
    const tabId = await openViewer(world);
    await pauseRequest(world, tabId, { url });
    await restartServiceWorker(world);
    engineControl().respond = async () => okResponse("again", 200, [["content-type", "text/plain"]]);
    expect(bodyText((await pauseRequest(world, tabId, { url })).params)).toBe("again");
    expect(engine().requests).toHaveLength(2);
  });
});

describe("closing every viewer", () => {
  it("reads the bindings once, however many other tabs the browser has open", async () => {
    const tabId = await openViewer(world);
    for (let i = 0; i < 300; i++) await world.chrome.tabs.create({ url: `https://example.org/${i}` });
    const cost = await costOf(0, async () => {
      expect(await world.chrome.runtime.sendMessage({ target: "background", type: "close-services" })).toEqual({ ok: true });
    });
    await settle();
    expect(world.tabs.has(tabId)).toBe(false);
    expect(world.session.has(`viewer:${tabId}`)).toBe(false);
    expect(world.tabs.size).toBe(300);
    // One for the bindings, and one per binding a leftover check finds (closeLeftoverViewers): not one per tab.
    expect(cost.reads).toBeLessThanOrEqual(3);
  });
});
