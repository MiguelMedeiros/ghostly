import { describe, expect, it, vi } from "vitest";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
// covers: devices.handoff

/**
 * A handoff waits while a call is on (WISP 06 § States and events). The calls live in the pages; each page says
 * whether one is on in it (`setCallOn`), and the engine hears whether a call is on in any page. A page that goes away
 * mid-call (a tab closed) is no longer counted.
 */
const fake = vi.hoisted(() => ({ nodes: [] as { said: boolean[] }[] }));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    said: boolean[] = [];
    constructor() { fake.nodes.push(this); }
    start() { return Promise.resolve(); }
    getState() { return { links: [] }; }
    async getMessages() { return []; }
    setActiveLink() {}
    appsCloseAll() {}
    setCallOn({ on }: { on: boolean }) { this.said.push(on); }
  },
}));

const { EngineServer } = await import("../src/engine/server");

const page = () => ({ post: (_: EngineEvent | RpcResponse) => {} });
let id = 0;
const callOn = (server: InstanceType<typeof EngineServer>, client: ReturnType<typeof page>, on: boolean) =>
  server.handle(client, { kind: "request", id: ++id, method: "setCallOn", params: { on } } as never);

describe("a call on in a page", () => {
  it("is on for the engine while it is on in any page, and off once the last one ends or its page goes away", async () => {
    const server = new EngineServer();
    await server.ready;
    const node = fake.nodes.at(-1)!;
    const [a, b] = [page(), page()];
    server.attach(a);
    server.attach(b);

    await callOn(server, a, true);
    await callOn(server, b, true);
    // One call ends; the other page is still on one.
    await callOn(server, a, false);
    expect(node.said).toEqual([true, true, true]);
    // The page on a call closes without a word: the engine no longer counts it.
    server.detach(b);
    expect(node.said.at(-1)).toBe(false);
    // A page that was not on a call goes away: nothing to say.
    server.detach(a);
    expect(node.said).toHaveLength(4);
  });
});
