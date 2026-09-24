import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEvent, RpcRequest, RpcResponse } from "../src/shared/rpc";
// covers: extension.engine, app.single-peer-per-browser

/**
 * The engine side of the RPC with the peer replaced: what matters here is how
 * calls from UI clients are answered and how events reach them, not what the
 * peer does with them.
 */
const fake = vi.hoisted(() => ({
  nodes: [] as FakeNodeShape[],
  start: () => Promise.resolve() as Promise<void>,
}));
interface FakeNodeShape {
  events: { onState(state: unknown): void; onMessages(linkId: string, messages: unknown[]): void; onAttention(event: unknown): void; onCallSignal(linkId: string, signal: string): void };
  options: unknown;
  state: { links: { id: string }[] };
  secret: string;
  setActiveLink: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
}

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    state = { links: [{ id: "a" }, { id: "b" }] };
    secret = "not a method";
    setActiveLink = vi.fn();
    shutdown = vi.fn(async () => {});
    constructor(public events: FakeNodeShape["events"], public options: unknown) { fake.nodes.push(this as unknown as FakeNodeShape); }
    start() { return fake.start(); }
    getState() { return this.state; }
    async getMessages(linkId: string) { return [{ id: `${linkId}-1` }]; }
    echo(params: unknown) { return { params, self: this === fake.nodes.at(-1) }; }
    async fail() { throw new Error("That payment was refused"); }
    failWithString() { throw "plain refusal"; }
  },
}));

const { EngineServer } = await import("../src/engine/server");
const { createInPageHost, becomeThePeer } = await import("../src/inPageHost");

type Posted = EngineEvent | RpcResponse;
const sink = () => { const posted: Posted[] = []; return { posted, post: (m: Posted) => void posted.push(m) }; };
const request = (method: string, params?: unknown, id = 1) => ({ kind: "request", id, method, params }) as unknown as RpcRequest;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => { fake.nodes.length = 0; fake.start = () => Promise.resolve(); });

describe("EngineServer answering calls", () => {
  it("answers a call with the peer's result under the request's id, the peer as `this`", async () => {
    const server = new EngineServer();
    const client = sink();
    await server.handle(client, request("echo", { amount: 21 }, 7));
    expect(client.posted).toEqual([{ kind: "response", id: 7, result: { params: { amount: 21 }, self: true } }]);
  });

  it("refuses a method the peer does not have, and a property that is not a method", async () => {
    const server = new EngineServer();
    const client = sink();
    await server.handle(client, request("dropDatabase", undefined, 1));
    await server.handle(client, request("secret", undefined, 2));
    expect(client.posted).toEqual([
      { kind: "response", id: 1, error: "Unknown method: dropDatabase" },
      { kind: "response", id: 2, error: "Unknown method: secret" },
    ]);
    // Nothing of the property's value travels back in the refusal.
    expect(JSON.stringify(client.posted)).not.toContain("not a method");
  });

  it("returns a failing call as an error message instead of throwing into the transport", async () => {
    const server = new EngineServer();
    const client = sink();
    await expect(server.handle(client, request("fail", undefined, 3))).resolves.toBeUndefined();
    await server.handle(client, request("failWithString", undefined, 4));
    expect(client.posted).toEqual([
      { kind: "response", id: 3, error: "That payment was refused" },
      { kind: "response", id: 4, error: "plain refusal" },
    ]);
  });

  it("ignores anything that is not a request", async () => {
    const server = new EngineServer();
    const client = sink();
    for (const junk of [null, undefined, "echo", { kind: "response", id: 1 }, { method: "echo", id: 1 }]) {
      await server.handle(client, junk as unknown as RpcRequest);
    }
    expect(client.posted).toEqual([]);
  });

  it("holds calls until the peer has started, then answers them", async () => {
    let started!: () => void;
    fake.start = () => new Promise<void>((resolve) => (started = resolve));
    const server = new EngineServer();
    const client = sink();
    const pending = server.handle(client, request("echo", 1));
    await flush();
    expect(client.posted).toEqual([]);
    started();
    await pending;
    expect(client.posted).toHaveLength(1);
  });

  it("answers every call with the start failure when the peer could not start", async () => {
    fake.start = () => Promise.reject(new Error("Storage is unavailable"));
    const server = new EngineServer();
    server.ready.catch(() => {});
    const client = sink();
    await server.handle(client, request("echo", 1, 9));
    expect(client.posted).toEqual([{ kind: "response", id: 9, error: "Storage is unavailable" }]);
  });

  it("survives a client that went away before its answer", async () => {
    const server = new EngineServer();
    const gone = { post: () => { throw new Error("port closed"); } };
    await expect(server.handle(gone, request("echo"))).resolves.toBeUndefined();
  });
});

describe("EngineServer and its clients", () => {
  it("gives a new client the current state and every chat's messages once the peer is ready", async () => {
    const server = new EngineServer();
    const client = sink();
    server.attach(client);
    await flush();
    expect(client.posted).toEqual([
      { kind: "state", state: { links: [{ id: "a" }, { id: "b" }] } },
      { kind: "messages", linkId: "a", messages: [{ id: "a-1" }] },
      { kind: "messages", linkId: "b", messages: [{ id: "b-1" }] },
    ]);
  });

  it("sends no snapshot to a client that left before the peer was ready", async () => {
    let started!: () => void;
    fake.start = () => new Promise<void>((resolve) => (started = resolve));
    const server = new EngineServer();
    const client = sink();
    server.attach(client);
    server.detach(client);
    started();
    await flush();
    expect(client.posted).toEqual([]);
  });

  it("tells every client what the peer reports, and drops one that cannot be reached", async () => {
    const server = new EngineServer();
    await server.ready;
    const first = sink();
    let closed = false;
    let broken = 0;
    const second = { post: () => { if (closed) { broken++; throw new Error("port closed"); } } };
    server.attach(first);
    server.attach(second);
    await flush();
    first.posted.length = 0;
    closed = true;

    const node = fake.nodes[0];
    node.events.onState({ links: [] });
    node.events.onMessages("a", [{ id: "x" }]);
    node.events.onAttention({ id: "e", type: "coin", at: 1 });
    node.events.onCallSignal("a", '{"t":"o"}');
    expect(first.posted).toEqual([
      { kind: "state", state: { links: [] } },
      { kind: "messages", linkId: "a", messages: [{ id: "x" }] },
      { kind: "attention", event: { id: "e", type: "coin", at: 1 } },
      { kind: "call-signal", linkId: "a", signal: '{"t":"o"}' },
    ]);
    expect(broken).toBe(1);
  });

  it("closes the open chat only when the last client leaves", async () => {
    const server = new EngineServer();
    const [a, b] = [sink(), sink()];
    server.attach(a);
    server.attach(b);
    server.detach(a);
    expect(fake.nodes[0].setActiveLink).not.toHaveBeenCalled();
    server.detach(b);
    expect(fake.nodes[0].setActiveLink).toHaveBeenCalledWith({ linkId: null });
  });

  it("passes the host's options to the peer", () => {
    new EngineServer({ platform: "extension" } as never);
    expect(fake.nodes[0].options).toEqual({ platform: "extension" });
  });
});

describe("the in-page host", () => {
  const features = { shareLocalServices: false, openServices: false };
  const host = (onServer = vi.fn()) => ({
    onServer,
    host: createInPageHost({ version: "1.0.0", features, node: { platform: "web" } as never, requestLocalAccess: async () => false, openService: async () => {}, onServer }),
  });

  it("starts one peer for every page connection and answers each connection's own calls", async () => {
    const { host: inPage, onServer } = host();
    const first: Posted[] = [];
    const second: Posted[] = [];
    const a = await inPage.connect((m) => first.push(m), () => {});
    const b = await inPage.connect((m) => second.push(m), () => {});
    expect(fake.nodes).toHaveLength(1);
    expect(onServer).toHaveBeenCalledTimes(1);
    expect(fake.nodes[0].options).toEqual({ platform: "web" });

    a.send(request("echo", "one", 1));
    b.send(request("dropDatabase", undefined, 2));
    await flush();
    expect(first.filter((m) => m.kind === "response")).toEqual([{ kind: "response", id: 1, result: { params: "one", self: true } }]);
    expect(second.filter((m) => m.kind === "response")).toEqual([{ kind: "response", id: 2, error: "Unknown method: dropDatabase" }]);
  });

  it("delivers messages asynchronously, never inside the call that caused them", async () => {
    const { host: inPage } = host();
    const received: Posted[] = [];
    const connection = await inPage.connect((m) => received.push(m), () => {});
    await flush();
    received.length = 0;
    fake.nodes[0].events.onState({ links: [] });
    expect(received).toEqual([]);
    await Promise.resolve();
    expect(received).toEqual([{ kind: "state", state: { links: [] } }]);
    expect(connection).toBeDefined();
  });

  it("says goodbye to peers when the page closes, and does nothing before a peer exists", async () => {
    const { host: inPage } = host();
    inPage.announceDeparture();
    await inPage.connect(() => {}, () => {});
    inPage.announceDeparture();
    expect(fake.nodes[0].shutdown).toHaveBeenCalledTimes(1);
  });

  it("exposes what the host was given", () => {
    const { host: inPage } = host();
    expect(inPage.version).toBe("1.0.0");
    expect(inPage.features).toBe(features);
    expect(inPage.openPaymentLink).toBeUndefined();
  });
});

describe("one peer per storage area", () => {
  it("says it is waiting while another page holds the lock, and takes over once it is free", async () => {
    vi.useFakeTimers();
    const queue: (() => unknown)[] = [];
    let held = true;
    vi.stubGlobal("navigator", { locks: { request: (_name: string, grant: () => unknown) => { if (held) queue.push(grant); else grant(); return Promise.resolve(); } } });
    const release = () => { held = false; queue.shift()?.(); };
    try {
      const onWaiting = vi.fn();
      let ours = false;
      const becoming = becomeThePeer("ghostly-peer", onWaiting).then(() => (ours = true));
      vi.advanceTimersByTime(150);
      expect(onWaiting).toHaveBeenCalledTimes(1);
      expect(ours).toBe(false);
      release();
      await becoming;
      expect(ours).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("does not report waiting when the lock is granted at once", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { locks: { request: (_name: string, grant: () => unknown) => { grant(); return Promise.resolve(); } } });
    try {
      const onWaiting = vi.fn();
      await becomeThePeer("ghostly-peer", onWaiting);
      vi.advanceTimersByTime(1000);
      expect(onWaiting).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
