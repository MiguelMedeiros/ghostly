import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeWorld } from "./fakeChrome";
import { engineControl, resetEngine } from "./fakeEngine";
import { bootExtension } from "./extension";

// covers: extension.engine

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

/**
 * The peer stores a chat text before its send answers (`sendChatText`: the row, then the outbox's turn, seconds on the
 * DHT floor), and the next peer sends what was stored. A page whose peer's document goes away in between must not take
 * the text as failed: the composer would hand it back, and a second Send would deliver it twice.
 */

let world: FakeWorld;
interface Row { id: string; linkId: string; text: string; sender: "me"; timestamp: number }
/** The chat as the peer's database keeps it: shared by every peer, as their profile's IndexedDB is. */
let rows: Row[];

beforeEach(() => {
  resetEngine();
  rows = [];
});

/**
 * A peer whose sends store the row (or, with `stores` false, do not get that far) and then wait on the network: their
 * answer never comes. Its `messagePage` reads the chat.
 */
function peer(stores: boolean): void {
  engineControl().answer = (method, params) => {
    if (method === "sendMessage") {
      const { linkId, text, timestamp } = params as { linkId: string; text: string; timestamp: number };
      if (stores) rows.push({ id: `me_wire${rows.length}`, linkId, text: text.trim(), sender: "me", timestamp });
      return new Promise(() => {});
    }
    if (method === "messagePage") {
      const { linkId, after, before } = params as { linkId: string; after: number; before: number };
      return Promise.resolve({ messages: rows.filter((r) => r.linkId === linkId && r.timestamp > after && r.timestamp < before), more: false });
    }
    return undefined;
  };
}

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

describe("a text being sent when the peer's document goes away", () => {
  it.each([1, 2, 3])("kept by the peer: answered as sent, so the person does not send it again (run %i)", async () => {
    peer(true);
    const engine = await page();
    const sending = engine.call("sendMessage", { linkId: "a", text: "pay me back", timestamp: 1700 });
    await vi.waitFor(() => expect(rows).toHaveLength(1));

    world.endOffscreen();
    // What the composer does with the answer: a send that threw comes back to the field, and is sent again.
    const outcome = await sending.then((r) => r, (e: Error) => e);
    if (outcome instanceof Error) {
      await vi.waitFor(() => expect(engineControl().servers).toHaveLength(2));
      void engine.call("sendMessage", { linkId: "a", text: "pay me back", timestamp: 1800 });
      await vi.waitFor(() => expect(rows).toHaveLength(2));
    }

    expect(outcome).toEqual({ error: null, messageId: "me_wire0" });
    expect(rows.map((r) => r.text)).toEqual(["pay me back"]);
  }, 15_000);

  it("not kept: still the peer lost, and the words come back to be sent", async () => {
    peer(false);
    const engine = await page();
    const sending = engine.call("sendMessage", { linkId: "a", text: "pay me back", timestamp: 1700 });
    await vi.waitFor(() => expect(engineControl().servers[0].handled.some(({ request }) => request.method === "sendMessage")).toBe(true));

    world.endOffscreen();
    await expect(sending).rejects.toThrow("Lost the Ghostly peer");
  }, 15_000);
});

/**
 * A group text is saved before its send answers too (`GroupSession.sendText`: the frame saved as unsaid, then the row),
 * and the next peer stores and says what was saved (`resume`). Its time is the peer's own, not the page's.
 */
/**
 * `stores`: whether the n-th send (from 0) gets as far as its row; `answers`: whether it then answers; `lagMs`: how far
 * behind the wall clock the row is dated, as a community's clock may run (`CommunityGroups.sendTime`).
 */
function groupPeer(stores: boolean | ((n: number) => boolean), { answers = () => false, lagMs = 0 }: { answers?: (n: number) => boolean; lagMs?: number } = {}): void {
  let sends = 0;
  engineControl().answer = (method, params) => {
    if (method === "sendGroupMessage") {
      const { groupId, text } = params as { groupId: string; text: string };
      const n = sends++;
      if (!(typeof stores === "function" ? stores(n) : stores)) return new Promise(() => {});
      const id = `g_${rows.length}`;
      rows.push({ id, linkId: `group:${groupId}`, text: text.trim(), sender: "me", timestamp: Date.now() - lagMs });
      return answers(n) ? Promise.resolve({ error: null, messageId: id }) : new Promise(() => {});
    }
    if (method === "messagePage") {
      const { linkId, after, before } = params as { linkId: string; after: number; before: number };
      return Promise.resolve({ messages: rows.filter((r) => r.linkId === linkId && r.timestamp > after && r.timestamp < before), more: false });
    }
    return undefined;
  };
}

describe("a group text being sent when the peer's document goes away", () => {
  it("kept by the peer: answered as sent, so the person does not send it to the group again", async () => {
    // Said a moment before, in the same words: not the one this send kept.
    rows = [{ id: "g_old", linkId: "group:g1", text: "on my way", sender: "me", timestamp: Date.now() - 5_000 }];
    groupPeer(true);
    const engine = await page();
    const sending = engine.call("sendGroupMessage", { groupId: "g1", text: "on my way" });
    await vi.waitFor(() => expect(rows).toHaveLength(2));

    world.endOffscreen();
    const outcome = await sending.then((r) => r, (e: Error) => e);
    if (outcome instanceof Error) {
      await vi.waitFor(() => expect(engineControl().servers).toHaveLength(2));
      void engine.call("sendGroupMessage", { groupId: "g1", text: "on my way" });
      await vi.waitFor(() => expect(rows).toHaveLength(3));
    }

    expect(outcome).toEqual({ error: null, messageId: "g_1" });
    expect(rows.map((r) => r.id)).toEqual(["g_old", "g_1"]);
  }, 15_000);

  it("not kept: still the peer lost, and the words come back to be sent", async () => {
    rows = [{ id: "g_old", linkId: "group:g1", text: "on my way", sender: "me", timestamp: Date.now() - 5_000 }];
    groupPeer(false);
    const engine = await page();
    const sending = engine.call("sendGroupMessage", { groupId: "g1", text: "on my way" });
    await vi.waitFor(() => expect(engineControl().servers[0].handled.some(({ request }) => request.method === "sendGroupMessage")).toBe(true));

    world.endOffscreen();
    await expect(sending).rejects.toThrow("Lost the Ghostly peer");
  }, 15_000);

  it("two of the same words in flight, only the first kept: the first is sent, the second comes back", async () => {
    groupPeer((n) => n === 0);
    const engine = await page();
    const first = engine.call("sendGroupMessage", { groupId: "g1", text: "ok" });
    const second = engine.call("sendGroupMessage", { groupId: "g1", text: "ok" });
    await vi.waitFor(() => expect(engineControl().servers[0].handled.filter(({ request }) => request.method === "sendGroupMessage")).toHaveLength(2));

    world.endOffscreen();
    await expect(first).resolves.toEqual({ error: null, messageId: "g_0" });
    await expect(second).rejects.toThrow("Lost the Ghostly peer");
  }, 15_000);

  it("the same words sent and answered a moment before: not taken for the text that was lost", async () => {
    groupPeer((n) => n === 0, { answers: (n) => n === 0 });
    const engine = await page();
    await expect(engine.call("sendGroupMessage", { groupId: "g1", text: "ok" })).resolves.toEqual({ error: null, messageId: "g_0" });
    const again = engine.call("sendGroupMessage", { groupId: "g1", text: "ok" });
    await vi.waitFor(() => expect(engineControl().servers[0].handled.filter(({ request }) => request.method === "sendGroupMessage")).toHaveLength(2));

    world.endOffscreen();
    await expect(again).rejects.toThrow("Lost the Ghostly peer");
  }, 15_000);

  it("kept under a time a little behind the page's, as a community's clock runs: still answered as sent", async () => {
    groupPeer(true, { lagMs: 500 });
    const engine = await page();
    const sending = engine.call("sendGroupMessage", { groupId: "c1", text: "on my way" });
    await vi.waitFor(() => expect(rows).toHaveLength(1));

    world.endOffscreen();
    await expect(sending).resolves.toEqual({ error: null, messageId: "g_0" });
  }, 15_000);
});
