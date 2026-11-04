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

/**
 * The extension's tabs share one engine, and a call rings in each. One answered it or declined it, and the others rang on
 * to their timeout, then wrote "Missed call" into the history of a call that was on; a Decline in one ended it.
 */
describe("a call one page answers or declines", () => {
  const answer = (o: number) => JSON.stringify({ t: "a", ts: Date.now(), o });
  const setCallSignal = (linkId: string, signal: string | null) => ({ kind: "request", id: 1, method: "setCallSignal", params: { linkId, signal } }) as never;
  const handled = (page: ReturnType<typeof client>) => page.posted.filter((m) => m.kind === "call-handled");

  it("stops ringing on the other pages, not on the one that took it", async () => {
    const { server, node } = await started();
    const [first, second, third] = [client(), client(), client()];
    for (const page of [first, second, third]) server.attach(page);
    await flush();
    const ts = Date.now();
    node.events.onCallSignal("answered", offer(ts));
    node.events.onCallSignal("declined", offer(ts));

    await server.handle(first, setCallSignal("answered", answer(ts)));
    await server.handle(second, setCallSignal("declined", hangUp()));
    expect(handled(first)).toEqual([{ kind: "call-handled", linkId: "declined" }]);
    expect(handled(second)).toEqual([{ kind: "call-handled", linkId: "answered" }]);
    expect(handled(third)).toEqual([{ kind: "call-handled", linkId: "answered" }, { kind: "call-handled", linkId: "declined" }]);
  });

  it("says nothing for a signal sent while nothing rang, nor for a clear", async () => {
    const { server, node } = await started();
    const [first, second] = [client(), client()];
    for (const page of [first, second]) server.attach(page);
    await flush();
    // The call is on: the next answer or hang-up is no page taking a ring.
    node.events.onCallSignal("on", offer());
    await server.handle(first, setCallSignal("on", answer(Date.now())));
    await server.handle(first, setCallSignal("on", hangUp()));
    await server.handle(first, setCallSignal("quiet", hangUp()));
    node.events.onCallSignal("cleared", offer());
    await server.handle(first, setCallSignal("cleared", null));
    expect(handled(second)).toEqual([{ kind: "call-handled", linkId: "on" }]);
  });
});
