import { describe, expect, it, vi } from "vitest";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
// covers: extension.engine, app.attention.notifications

/**
 * The extension's peer runs with no tab open. A contact's call that rang then reached no page and no host: the person
 * heard and saw nothing, while the caller was told it rang. The host hears it instead (`unheardCall`), and its end.
 */
type Events = { onCallSignal(linkId: string, signal: string): void };
const fake = vi.hoisted(() => ({ nodes: [] as { events: Events }[] }));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    constructor(public events: Events) { fake.nodes.push(this); }
    start() { return Promise.resolve(); }
    getState() { return { links: [] }; }
    async getMessages() { return []; }
    setActiveLink() {}
    appsCloseAll() {}
    async setCallSignal() {}
  },
}));

const { EngineServer } = await import("../src/engine/server");

const ICE = { u: "abcd", p: "abcdefghijklmnopqrstuv", f: "a".repeat(64), s: "actpass" };
const offer = (ts = Date.now()) => JSON.stringify({ t: "o", ts, ...ICE });
const hangUp = () => JSON.stringify({ t: "h", ts: Date.now() });
const answer = () => JSON.stringify({ t: "a", ts: Date.now(), ...ICE });

function client() {
  const posted: (EngineEvent | RpcResponse)[] = [];
  return { posted, post: (message: EngineEvent | RpcResponse) => void posted.push(message) };
}

async function started() {
  const server = new EngineServer();
  await server.ready;
  const told: [string, string | null][] = [];
  server.unheardCall = (linkId, signal) => void told.push([linkId, signal]);
  return { server, node: fake.nodes.at(-1)!, told };
}

describe("a call that rings with no page attached", () => {
  it("is told to the host once, and its end when the contact hangs up", async () => {
    const { node, told } = await started();
    const ringing = offer();
    node.events.onCallSignal("link-1", ringing);
    expect(told).toEqual([["link-1", ringing]]);

    node.events.onCallSignal("link-1", hangUp());
    expect(told).toEqual([["link-1", ringing], ["link-1", null]]);
    // Once: a second hang-up of the same call tells nothing more.
    node.events.onCallSignal("link-1", hangUp());
    expect(told).toHaveLength(2);
  });

  it("not while a page is attached: the page rings; once it goes, the host is told again", async () => {
    const { server, node, told } = await started();
    const page = client();
    server.attach(page);
    node.events.onCallSignal("link-1", offer());
    node.events.onCallSignal("link-1", hangUp());
    expect(told).toEqual([]);
    expect(page.posted.filter((m) => m.kind === "call-signal")).toHaveLength(2);

    server.detach(page);
    const ringing = offer();
    node.events.onCallSignal("link-1", ringing);
    expect(told).toEqual([["link-1", ringing]]);
  });

  it("ends when a page opened since answers or declines it, and only the chat it was told of", async () => {
    const { server, node, told } = await started();
    const ringing = offer();
    node.events.onCallSignal("link-1", ringing);
    // A hang-up in a chat that rang nothing here tells nothing.
    node.events.onCallSignal("link-2", hangUp());
    expect(told).toEqual([["link-1", ringing]]);

    const page = client();
    server.attach(page);
    await server.handle(page, { kind: "request", id: 1, method: "setCallSignal", params: { linkId: "link-1", signal: answer() } } as never);
    expect(told).toEqual([["link-1", ringing], ["link-1", null]]);
  });

  it("nothing for an offer too old to answer, nor for a contact's picture change", async () => {
    const { node, told } = await started();
    node.events.onCallSignal("link-1", offer(Date.now() - 10 * 60_000));
    node.events.onCallSignal("link-1", JSON.stringify({ t: "v", ts: Date.now() }));
    expect(told).toEqual([]);
  });
});
