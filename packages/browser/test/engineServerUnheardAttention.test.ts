import { describe, expect, it, vi } from "vitest";
import type { AttentionEvent, EngineEvent, RpcResponse } from "../src/shared/rpc";
// covers: extension.engine, app.attention.notifications

/**
 * The extension's peer runs with no tab open. Attention went only to the attached pages, so a message that came while
 * none was open showed nothing: the host hears it instead (`unheardAttention`), and only then.
 */
type Events = { onAttention(event: AttentionEvent): void };
const fake = vi.hoisted(() => ({ nodes: [] as { events: Events }[] }));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    constructor(public events: Events) { fake.nodes.push(this); }
    start() { return Promise.resolve(); }
    getState() { return { links: [] }; }
    setActiveLink() {}
    appsCloseAll() {}
  },
}));

const { EngineServer } = await import("../src/engine/server");

const message = (id: string): AttentionEvent => ({ id, type: "message", at: Date.now(), linkId: "link-1" });

function client() {
  const posted: (EngineEvent | RpcResponse)[] = [];
  return { posted, post: (m: EngineEvent | RpcResponse) => void posted.push(m), attention: () => posted.filter((m) => m.kind === "attention") };
}

describe("attention with no page attached", () => {
  it("goes to the host while no page is attached, and to the pages alone while one is", async () => {
    const server = new EngineServer();
    await server.ready;
    const node = fake.nodes.at(-1)!;
    const unheard: string[] = [];
    server.unheardAttention = (event) => unheard.push(event.id);

    node.events.onAttention(message("before"));
    const page = client();
    server.attach(page);
    node.events.onAttention(message("while"));
    server.detach(page);
    node.events.onAttention(message("after"));

    expect(unheard).toEqual(["before", "after"]);
    expect(page.attention()).toEqual([{ kind: "attention", event: expect.objectContaining({ id: "while" }) }]);
  });
});
