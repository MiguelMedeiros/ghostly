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
