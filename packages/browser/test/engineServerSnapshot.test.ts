import { describe, expect, it, vi } from "vitest";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";

/**
 * A client attached to the engine gets a snapshot once the peer is ready. A client that goes away while
 * it is sent is dropped, as a broadcast drops one, and a peer that never started leaves nothing
 * unhandled (every call already answers with its failure).
 */
const fake = vi.hoisted(() => ({ start: () => Promise.resolve() as Promise<void>, nodes: [] as { events: { onState(state: unknown): void } }[] }));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    constructor(public events: { onState(state: unknown): void }) { fake.nodes.push(this); }
    start() { return fake.start(); }
    getState() { return { links: [{ id: "a" }] }; }
    async getMessages() { return []; }
    setActiveLink() {}
  },
}));

const { EngineServer } = await import("../src/engine/server");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("a client's first snapshot", () => {
  it("drops a client that went away during it, and leaves nothing unhandled when the peer could not start", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const server = new EngineServer();
      const gone = { post: vi.fn((_: EngineEvent | RpcResponse) => { throw new Error("port closed"); }) };
      server.attach(gone);
      await flush();
      fake.nodes[0].events.onState({ links: [] });
      expect(gone.post).toHaveBeenCalledOnce();

      fake.start = () => Promise.reject(new Error("Storage is unavailable"));
      const broken = new EngineServer();
      broken.ready.catch(() => {});
      broken.attach({ post: () => {} });
      await flush();
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});
