import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserHost, EngineConnection } from "../src/host";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
// covers: extension.engine

/** Each time the page makes a history with changes, a copy of the whole list. */
const made = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/shared/messageChanges", async (actual) => {
  const real = await actual<typeof import("../src/shared/messageChanges")>();
  return { ...real, applyMessageChanges: (...args: Parameters<typeof real.applyMessageChanges>) => (made.count++, real.applyMessageChanges(...args)) };
});

let engine: typeof import("../src/platform/engine").engine;
let MESSAGE_CHANGES_TICK_MS: number;
let deliver: (m: EngineEvent | RpcResponse) => void;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const hostModule = await import("../src/host");
  ({ engine, MESSAGE_CHANGES_TICK_MS } = await import("../src/platform/engine"));
  const host = { version: "test", features: { shareLocalServices: false, openServices: false },
    connect: async (onMessage: (m: EngineEvent | RpcResponse) => void): Promise<EngineConnection> => {
      deliver = onMessage;
      return { send: () => {} };
    },
    requestLocalAccess: async () => false, openService: async () => {} } satisfies BrowserHost;
  hostModule.setBrowserHost(host);
  await engine.connect();
  made.count = 0;
});

const at = (id: string, timestamp: number, delivery?: "delivered" | "read") =>
  ({ id, linkId: "l1", text: id, sender: "me", timestamp, via: "datalink", ...(delivery && { delivery }) }) as StoredMessage;

describe("a burst of one-row changes in a long chat", () => {
  it("copies the history once for the whole burst, and every reader still sees it as it is now", async () => {
    const history = Array.from({ length: 1000 }, (_, i) => at(`m${i}`, i));
    deliver({ kind: "messages", linkId: "l1", messages: history });
    const listener = vi.fn();
    engine.onMessages(listener);
    // A delivery mark per text, each its own event, as the outbox sends them.
    for (let i = 0; i < 500; i++) deliver({ kind: "message-changes", linkId: "l1", messages: [at(`m${i}`, i, "delivered")], deleted: [] });
    expect(made.count).toBe(0);
    // A reader before the tick gets the list as it is now: made once, then held.
    const now = engine.messages.get("l1")!;
    expect(now.slice(0, 500).every((m) => m.delivery === "delivered")).toBe(true);
    expect(now[500]!.delivery).toBeUndefined();
    expect(engine.messages.get("l1")).toBe(now);
    expect(made.count).toBe(1);
    // More marks, a row deleted and one given back in the same tick: made once more, when the tick ends.
    for (let i = 500; i < 1000; i++) deliver({ kind: "message-changes", linkId: "l1", messages: [at(`m${i}`, i, "read")], deleted: [] });
    deliver({ kind: "message-changes", linkId: "l1", messages: [], deleted: ["m3"] });
    deliver({ kind: "message-changes", linkId: "l1", messages: [], deleted: ["m4"] });
    deliver({ kind: "message-changes", linkId: "l1", messages: [at("m4", 4, "read")], deleted: [] });
    await vi.advanceTimersByTimeAsync(MESSAGE_CHANGES_TICK_MS);
    expect(made.count).toBe(2);
    const told = engine.messages.get("l1")!;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![1]).toBe(told);
    expect(listener.mock.calls[0]![2].from).toBe(history);
    expect(listener.mock.calls[0]![2].deleted).toEqual(["m3"]);
    expect(listener.mock.calls[0]![2].messages).toHaveLength(999);
    expect(told.map((m) => m.id)).toEqual(history.map((m) => m.id).filter((id) => id !== "m3"));
    expect(told.map((m) => m.delivery)).toEqual(told.map((m) => (Number(m.id.slice(1)) < 500 && m.id !== "m4" ? "delivered" : "read")));
    // Read by iterating too: what a burst left is made before it is handed out.
    deliver({ kind: "message-changes", linkId: "l1", messages: [at("new", 2000)], deleted: [] });
    expect([...engine.messages].find(([id]) => id === "l1")![1].at(-1)!.id).toBe("new");
    expect(made.count).toBe(3);
  });
});
