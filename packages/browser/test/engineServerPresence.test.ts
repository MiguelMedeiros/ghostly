import { describe, expect, it, vi } from "vitest";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
// covers: chat.status.wire

/**
 * Each page says whether the person is here (`setPresence`); the extension's tabs share one engine. The engine hears
 * `active` while any page says so, and `idle` once none does: a tab hidden, locked or closed does not tell the
 * contacts the profile is idle while another one is in use.
 */
const fake = vi.hoisted(() => ({ nodes: [] as { said: (string | null)[] }[] }));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    said: (string | null)[] = [];
    constructor() { fake.nodes.push(this); }
    start() { return Promise.resolve(); }
    getState() { return { links: [] }; }
    async getMessages() { return []; }
    setActiveLink() {}
    appsCloseAll() {}
    setPresence({ presence }: { presence: string | null }) { this.said.push(presence); }
  },
}));

const { EngineServer } = await import("../src/engine/server");

const page = () => ({ post: (_: EngineEvent | RpcResponse) => {} });
let id = 0;
const presence = (server: InstanceType<typeof EngineServer>, client: ReturnType<typeof page>, word: "active" | "idle") =>
  server.handle(client, { kind: "request", id: ++id, method: "setPresence", params: { presence: word } } as never);

describe("presence said by several pages", () => {
  it("stays active while any page says so, and goes idle once none does or the last active one goes away", async () => {
    const server = new EngineServer();
    await server.ready;
    const node = fake.nodes.at(-1)!;
    const [a, b] = [page(), page()];
    server.attach(a);
    server.attach(b);

    await presence(server, a, "active");
    await presence(server, b, "active");
    // B is hidden (or locked, or closed with a word): A is still in use.
    await presence(server, b, "idle");
    expect(node.said).not.toContain("idle");
    // A is hidden too: nobody is here.
    await presence(server, a, "idle");
    expect(node.said.at(-1)).toBe("idle");

    // A tab goes away without a word (a crash): the engine no longer counts it.
    await presence(server, a, "active");
    await presence(server, b, "active");
    server.detach(a);
    expect(node.said.at(-1)).toBe("active");
    server.detach(b);
    expect(node.said.at(-1)).toBe("idle");
  });
});
