import { describe, expect, it, vi } from "vitest";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
// covers: extension.engine, calls.ring-elsewhere

/**
 * A page that attaches while a contact's call rings hears the offer too. The extension's peer runs with no tab open:
 * a call that came in before the person opened Ghostly used to show nothing, while the caller kept ringing.
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
    async setCallSignal() {}
  },
}));

const { EngineServer } = await import("../src/engine/server");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const offer = (ts = Date.now()) => JSON.stringify({ t: "o", ts, u: "abcd", p: "abcdefghijklmnopqrstuv", f: "a".repeat(64), s: "actpass" });
const hangUp = () => JSON.stringify({ t: "h", ts: Date.now() });

function client() {
  const posted: (EngineEvent | RpcResponse)[] = [];
  return { posted, post: (message: EngineEvent | RpcResponse) => void posted.push(message), signals: () => posted.filter((m) => m.kind === "call-signal") };
}

async function started() {
  const server = new EngineServer();
  await server.ready;
  return { server, node: fake.nodes.at(-1)! };
}

describe("a call that rings before the page opens", () => {
  it("reaches a page that attaches during the ring, after the state", async () => {
    const { server, node } = await started();
    const ringing = offer();
    node.events.onCallSignal("link-1", ringing);

    const page = client();
    server.attach(page);
    await flush();
    expect(page.signals()).toEqual([{ kind: "call-signal", linkId: "link-1", signal: ringing }]);
    expect(page.posted[0]).toMatchObject({ kind: "state" });
  });

  it("not once the contact hung up, this app answered or declined, or the offer is too old to answer", async () => {
    const { server, node } = await started();
    node.events.onCallSignal("hung-up", offer());
    node.events.onCallSignal("hung-up", hangUp());
    node.events.onCallSignal("answered", offer());
    await server.handle(client(), { kind: "request", id: 1, method: "setCallSignal", params: { linkId: "answered", signal: "{}" } } as never);
    node.events.onCallSignal("stale", offer(Date.now() - 10 * 60_000));

    const page = client();
    server.attach(page);
    await flush();
    expect(page.signals()).toEqual([]);
  });
});
