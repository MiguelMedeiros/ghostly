import { describe, expect, it, vi } from "vitest";
import type { MessageChanges } from "../src/shared/messageChanges";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
// covers: extension.engine

/**
 * A client that attaches with `newest` gets each chat's newest page, not its whole history: the extension's pages get
 * what the peer sends as JSON, and 50 chats of 2,000 messages were about 20 MiB per page opened. It asks for a chat's
 * whole history when it needs one (`EngineServer.history`), and gets it in order with what changes in that chat.
 */
type Events = { onMessages(linkId: string, messages: StoredMessage[]): void; onMessageChanges?(linkId: string, changes: MessageChanges): void };
const CHATS = 50, LONG = 2_000;
const fake = vi.hoisted(() => ({
  nodes: [] as { events: Events }[],
  stored: new Map<string, StoredMessage[]>(),
  reads: [] as string[],
  gate: null as Promise<void> | null,
}));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    constructor(public events: Events) { fake.nodes.push(this); }
    start() { return Promise.resolve(); }
    getState() { return { links: [...fake.stored.keys()].filter((id) => !id.startsWith("group:")).map((id) => ({ id })), groups: [] }; }
    async getMessages(linkId: string) {
      fake.reads.push(linkId);
      const list = fake.stored.get(linkId) ?? [];
      await fake.gate;
      return list;
    }
    async messagePage({ linkId, limit = 50 }: { linkId: string; limit?: number }) {
      const list = fake.stored.get(linkId) ?? [];
      return { messages: list.slice(-limit), more: list.length > limit };
    }
    setActiveLink() {}
    appsCloseAll() {}
  },
}));

const { EngineServer } = await import("../src/engine/server");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const row = (linkId: string, i: number): StoredMessage => ({ linkId, id: `${linkId}:${i}`, text: `An ordinary message of a long chat, number ${i}`, sender: i % 2 ? "peer" : "me", timestamp: 1_700_000_000_000 + i, via: "datalink" });
const history = (linkId: string, n: number) => Array.from({ length: n }, (_, i) => row(linkId, i));
const client = () => {
  const got: (EngineEvent | RpcResponse)[] = [];
  return { got, post: (m: EngineEvent | RpcResponse) => void got.push(m), history: () => got.filter((m) => m.kind === "messages" || m.kind === "message-changes") };
};

describe("a client that attaches with each chat's newest page", () => {
  it("gets a newest page per chat, not every whole history, and no history is read whole", async () => {
    fake.stored.clear();
    for (let c = 0; c < CHATS; c++) fake.stored.set(`chat${c}`, history(`chat${c}`, LONG));
    fake.stored.set("short", history("short", 3));
    const server = new EngineServer();
    const page = client();
    fake.reads = [];
    server.attach(page, undefined, { newest: 50 });
    await flush();
    const sent = page.history();
    expect(sent).toHaveLength(CHATS + 1);
    expect(sent[0]).toEqual({ kind: "messages", linkId: "chat0", messages: fake.stored.get("chat0")!.slice(-50), more: true });
    // A chat that fits in its page is whole: nothing says older rows are left.
    expect(sent.at(-1)).toEqual({ kind: "messages", linkId: "short", messages: fake.stored.get("short") });
    expect(fake.reads).toEqual([]);
    // What a page opened is sent: well under the 20 MiB of every whole history.
    const bytes = JSON.stringify(page.got).length;
    expect(bytes).toBeLessThan(1024 * 1024);
    expect(JSON.stringify([...fake.stored.values()]).length).toBeGreaterThan(10 * 1024 * 1024);
  });

  it("hears what changes on top of the page it has, and gets a chat's whole history when it asks", async () => {
    fake.stored.clear();
    fake.stored.set("chat", history("chat", 120));
    const server = new EngineServer();
    const events = fake.nodes.at(-1)!.events;
    const page = client();
    server.attach(page, undefined, { newest: 50 });
    await flush();
    fake.reads = [];
    events.onMessageChanges!("chat", { messages: [row("chat", 120)], deleted: [] });
    expect(page.history().at(-1)).toEqual({ kind: "message-changes", linkId: "chat", messages: [row("chat", 120)], deleted: [] });
    expect(fake.reads).toEqual([]);

    // Its whole history, asked for, comes in order: a change while it is read follows it.
    fake.stored.set("chat", history("chat", 121));
    let open!: () => void;
    fake.gate = new Promise<void>((resolve) => (open = resolve));
    void server.history(page, "chat");
    await flush();
    events.onMessageChanges!("chat", { messages: [row("chat", 121)], deleted: [] });
    open();
    fake.gate = null;
    await flush();
    expect(fake.reads).toEqual(["chat"]);
    expect(page.history().slice(-2)).toEqual([
      { kind: "messages", linkId: "chat", messages: history("chat", 121) },
      { kind: "message-changes", linkId: "chat", messages: [row("chat", 121)], deleted: [] },
    ]);
  });

  it("sends a client that attaches as before every chat's whole history", async () => {
    fake.stored.clear();
    fake.stored.set("chat", history("chat", 120));
    const server = new EngineServer();
    const page = client();
    server.attach(page);
    await flush();
    expect(page.history()).toEqual([{ kind: "messages", linkId: "chat", messages: fake.stored.get("chat") }]);
  });

  it("sends no history to a client that went away before it asked, nor reads one", async () => {
    fake.stored.clear();
    fake.stored.set("chat", history("chat", 120));
    const server = new EngineServer();
    const page = client();
    server.attach(page, undefined, { newest: 50 });
    await flush();
    server.detach(page);
    fake.reads = [];
    await server.history(page, "chat");
    await flush();
    expect(fake.reads).toEqual([]);
    expect(page.history()).toHaveLength(1);
  });
});
