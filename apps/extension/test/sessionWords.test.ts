import { beforeEach, describe, expect, it, vi } from "vitest";
import { settle, type FakeWorld } from "./fakeChrome";
import { engineControl, resetEngine } from "./fakeEngine";
import { bootExtension } from "./extension";

// covers: extension.engine, extension.reconnecting

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

/**
 * Chrome ends the peer's offscreen document (its renderer crashed, the task manager, the minute check replacing it) and
 * the worker makes a new one; each tab connects again by itself. The page tells the peer the chat on screen and the
 * person's presence only when they change, and the new peer keeps neither: it read the open chat's mailbox at the
 * background pace and said no presence to contacts until the person opened another chat or used the app a minute on.
 */

let world: FakeWorld;

beforeEach(() => {
  resetEngine();
  // The peer answers the page's words (they return nothing), as `EngineServer.handle` does.
  engineControl().answer = (method) => (method.startsWith("set") ? Promise.resolve(null) : undefined);
});

async function page() {
  world = await bootExtension();
  await vi.waitFor(() => expect(engineControl().servers).toHaveLength(1));
  const { extensionHost } = await world.load("page", () => import("../src/host.ts"));
  const { engine } = await world.load("page", async () => {
    (await import("@ghostly/browser/host")).setBrowserHost(extensionHost);
    return import("@ghostly/browser/platform/engine");
  });
  await engine.connect();
  return engine;
}

/** What a peer heard from the pages, as method and params, in order. */
const heard = (server: number) => engineControl().servers[server].handled.map(({ request }) => [request.method, request.params]);

describe("a tab whose peer's document started again", () => {
  it("tells the new peer the chat on screen and the person's presence, and the first peer each once", async () => {
    const engine = await page();
    await engine.call("setActiveLink", { linkId: "link-1" });
    await engine.call("setPresence", { presence: "active" });
    // A call that only acts (look at the chat's mailbox now), left unanswered.
    void engine.call("pollNow", { linkId: "link-1" }).catch(() => {});
    await vi.waitFor(() => expect(heard(0)).toHaveLength(3));
    expect(heard(0)).toEqual([["setActiveLink", { linkId: "link-1" }], ["setPresence", { presence: "active" }], ["pollNow", { linkId: "link-1" }]]);

    world.endOffscreen();
    await vi.waitFor(() => expect(engineControl().servers).toHaveLength(2), { timeout: 5_000 });
    await vi.waitFor(() => expect(engineControl().servers[1].attached).toHaveLength(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(heard(1)).toHaveLength(2), { timeout: 5_000 });
    await settle();
    // Once each, and nothing that only acted.
    expect(heard(1)).toEqual([["setActiveLink", { linkId: "link-1" }], ["setPresence", { presence: "active" }]]);
    expect(engine.reconnecting).toBe(false);
  }, 15_000);

  it("tells it a group on screen and a call on in the tab", async () => {
    const engine = await page();
    await engine.call("setActiveLink", { linkId: "group:g" });
    await engine.call("setCallOn", { on: true });

    world.endOffscreen();
    await vi.waitFor(() => expect(heard(1)).toHaveLength(2), { timeout: 5_000 });
    expect(heard(1)).toEqual([["setActiveLink", { linkId: "group:g" }], ["setCallOn", { on: true }]]);
  }, 15_000);

  it("tells it nothing the page took back before it went away", async () => {
    const engine = await page();
    await engine.call("setActiveLink", { linkId: "link-1" });
    await engine.call("setActiveLink", { linkId: null });
    await engine.call("setCallOn", { on: true });
    await engine.call("setCallOn", { on: false });

    world.endOffscreen();
    await vi.waitFor(() => expect(engineControl().servers[1]?.attached).toHaveLength(1), { timeout: 5_000 });
    await settle();
    expect(heard(1)).toEqual([]);
  }, 15_000);
});
