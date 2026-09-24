import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserHost, EngineConnection } from "../src/host";
import type { EngineEvent, RpcRequest, RpcResponse } from "../src/shared/rpc";
import type { EngineState } from "../src/shared/types";

/**
 * The page's side of the RPC: a scripted host stands in for the extension port
 * or the in-page peer, so every message the engine client receives is chosen here.
 */
type Incoming = EngineEvent | RpcResponse;

function scriptedHost() {
  const connections: { sent: RpcRequest[]; deliver: (m: Incoming) => void; drop: () => void }[] = [];
  let refuse: Error | null = null;
  const connect = vi.fn(async (onMessage: (m: Incoming) => void, onDisconnect: () => void): Promise<EngineConnection> => {
    if (refuse) throw refuse;
    const sent: RpcRequest[] = [];
    connections.push({ sent, deliver: onMessage, drop: onDisconnect });
    return { send: (request) => void sent.push(request) };
  });
  const host = { version: "test", features: { shareLocalServices: false, openServices: false }, connect,
    requestLocalAccess: async () => false, openService: async () => {} } satisfies BrowserHost;
  return { host, connect, connections, refuseWith: (error: Error | null) => (refuse = error) };
}

await import("../src/platform/engine");
let engine: typeof import("../src/platform/engine").engine;
let hostModule: typeof import("../src/host");
let scripted: ReturnType<typeof scriptedHost>;

beforeEach(async () => {
  vi.resetModules();
  hostModule = await import("../src/host");
  ({ engine } = await import("../src/platform/engine"));
  scripted = scriptedHost();
  hostModule.setBrowserHost(scripted.host);
}, 60_000);
afterEach(() => vi.useRealTimers());

const state = (links: { id: string; peerPubKeyZ32: string }[] = []) => ({ links }) as unknown as EngineState;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("calling the peer", () => {
  it("refuses to connect before a host is configured", async () => {
    vi.resetModules();
    const { engine: bare } = await import("../src/platform/engine");
    expect(() => bare.connect()).toThrow("No browser host configured");
  });

  it("waits for the connection, then sends each call with its own id and its parameters", async () => {
    const first = engine.call("removeLink", { linkId: "a" });
    const second = engine.call("usdtLock");
    await tick();
    expect(scripted.connect).toHaveBeenCalledTimes(1);
    const { sent, deliver } = scripted.connections[0];
    expect(sent).toEqual([
      { kind: "request", id: 1, method: "removeLink", params: { linkId: "a" } },
      { kind: "request", id: 2, method: "usdtLock", params: undefined },
    ]);
    // Answers may come back in any order; each reaches its own caller.
    deliver({ kind: "response", id: 2, result: "locked" });
    deliver({ kind: "response", id: 1, error: "No such chat" });
    await expect(second).resolves.toBe("locked");
    await expect(first).rejects.toThrow("No such chat");
  });

  it("ignores an answer to a call it never made, and a second answer to the same call", async () => {
    const call = engine.call("usdtRefresh");
    await tick();
    const { deliver } = scripted.connections[0];
    deliver({ kind: "response", id: 99, result: "stray" });
    deliver({ kind: "response", id: 1, result: "first" });
    deliver({ kind: "response", id: 1, error: "late duplicate" });
    await expect(call).resolves.toBe("first");
  });

  it("fails a call when the host cannot reach the peer, and tries again on the next call", async () => {
    scripted.refuseWith(new Error("The extension is not running"));
    await expect(engine.call("usdtLock")).rejects.toThrow("The extension is not running");
    scripted.refuseWith(null);
    const retry = engine.call("usdtLock");
    await tick();
    scripted.connections[0].deliver({ kind: "response", id: 1, result: null });
    await expect(retry).resolves.toBeNull();
    expect(scripted.connect).toHaveBeenCalledTimes(2);
  });

  it("shares one connection attempt between everything that asks for it", async () => {
    await Promise.all([engine.connect(), engine.connect(), engine.connect()]);
    await engine.connect();
    expect(scripted.connect).toHaveBeenCalledTimes(1);
  });

  it("fails every call in flight when the peer goes away, then reconnects by itself", async () => {
    vi.useFakeTimers();
    const lost = engine.call("usdtRefresh");
    await vi.advanceTimersByTimeAsync(0);
    scripted.connections[0].drop();
    await expect(lost).rejects.toThrow("Lost the Ghostly peer");

    expect(scripted.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(scripted.connect).toHaveBeenCalledTimes(2);

    const next = engine.call("usdtRefresh");
    await vi.advanceTimersByTimeAsync(0);
    expect(scripted.connections[0].sent).toHaveLength(1);
    expect(scripted.connections[1].sent).toEqual([{ kind: "request", id: 2, method: "usdtRefresh", params: undefined }]);
    scripted.connections[1].deliver({ kind: "response", id: 2, result: "ok" });
    await expect(next).resolves.toBe("ok");
  });

  it("reconnects on the next call when the automatic reconnect found the peer still down", async () => {
    vi.useFakeTimers();
    await engine.connect();
    scripted.refuseWith(new Error("down"));
    scripted.connections[0].drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(scripted.connect).toHaveBeenCalledTimes(2);
    scripted.refuseWith(null);
    const call = engine.call("usdtLock");
    await vi.advanceTimersByTimeAsync(0);
    expect(scripted.connect).toHaveBeenCalledTimes(3);
    scripted.connections[1].deliver({ kind: "response", id: 1, result: null });
    await expect(call).resolves.toBeNull();
  });
});

describe("what the peer tells the page", () => {
  it("keeps the latest state and tells subscribers until they unsubscribe", async () => {
    await engine.connect();
    const { deliver } = scripted.connections[0];
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    const latest = state([{ id: "l1", peerPubKeyZ32: "peer-1" }]);
    deliver({ kind: "state", state: state() });
    deliver({ kind: "state", state: latest });
    expect(engine.state).toBe(latest);
    expect(engine.linkByPeer("peer-1")?.id).toBe("l1");
    expect(engine.linkByPeer("stranger")).toBeUndefined();
    unsubscribe();
    deliver({ kind: "state", state: state() });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("finds no chat before the first state arrives", () => {
    expect(engine.state).toBeNull();
    expect(engine.linkByPeer("peer-1")).toBeUndefined();
  });

  it("keeps each chat's messages and hands them to listeners", async () => {
    await engine.connect();
    const listener = vi.fn();
    const stop = engine.onMessages(listener);
    const messages = [{ id: "m", linkId: "l1", text: "hi", sender: "peer", timestamp: 1 }] as never;
    scripted.connections[0].deliver({ kind: "messages", linkId: "l1", messages });
    expect(engine.messages.get("l1")).toBe(messages);
    expect(listener).toHaveBeenCalledWith("l1", messages);
    stop();
    scripted.connections[0].deliver({ kind: "messages", linkId: "l1", messages: [] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(engine.messages.get("l1")).toEqual([]);
  });

  it("passes attention events through to listeners", async () => {
    await engine.connect();
    const listener = vi.fn();
    const stop = engine.onAttention(listener);
    const event = { id: "x", type: "coin", at: 5 } as const;
    scripted.connections[0].deliver({ kind: "attention", event });
    stop();
    scripted.connections[0].deliver({ kind: "attention", event });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });
});

describe("call offers", () => {
  const offer = JSON.stringify({ t: "o", sdp: "v=0" });

  it("keeps an incoming offer for a chat that opens later, and hands it out once", async () => {
    await engine.connect();
    const listener = vi.fn();
    engine.onCallSignal(listener);
    scripted.connections[0].deliver({ kind: "call-signal", linkId: "l1", signal: offer });
    expect(listener).toHaveBeenCalledWith("l1", offer);
    expect(engine.takeCallOffer("l1")).toBe(offer);
    expect(engine.takeCallOffer("l1")).toBeUndefined();
  });

  it("forgets the offer once anything else is signalled for that chat, even an unreadable signal", async () => {
    await engine.connect();
    const { deliver } = scripted.connections[0];
    const listener = vi.fn();
    const stop = engine.onCallSignal(listener);
    deliver({ kind: "call-signal", linkId: "l1", signal: offer });
    deliver({ kind: "call-signal", linkId: "l1", signal: JSON.stringify({ t: "e" }) });
    expect(engine.takeCallOffer("l1")).toBeUndefined();

    deliver({ kind: "call-signal", linkId: "l2", signal: offer });
    deliver({ kind: "call-signal", linkId: "l2", signal: "{not json" });
    deliver({ kind: "call-signal", linkId: "l3", signal: offer });
    deliver({ kind: "call-signal", linkId: "l3", signal: "null" });
    expect(engine.takeCallOffer("l2")).toBeUndefined();
    expect(engine.takeCallOffer("l3")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(6);
    stop();
    deliver({ kind: "call-signal", linkId: "l4", signal: offer });
    expect(listener).toHaveBeenCalledTimes(6);
    expect(engine.takeCallOffer("l4")).toBe(offer);
  });
});
