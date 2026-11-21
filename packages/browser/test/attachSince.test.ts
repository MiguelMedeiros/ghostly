import { describe, expect, it, vi } from "vitest";
import type { MessageChanges } from "../src/shared/messageChanges";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
// covers: extension.engine

/**
 * A page of the extension that attaches again (a tab reloaded, another opened) with the mark of what its pages mirrored
 * already gets only the chats that changed since: each chat's newest 400 rows went to every tab at each attach, 120,000
 * rows and 51 MiB of JSON at 300 chats, though a typical reload had nothing to catch up on.
 */
type Events = { onMessages(linkId: string, messages: StoredMessage[]): void; onMessageChanges?(linkId: string, changes: MessageChanges): void };
const CHATS = 300, ROWS = 400;
const fake = vi.hoisted(() => ({
  nodes: [] as { events: Events }[],
  stored: new Map<string, StoredMessage[]>(),
  pages: 0,
  gate: null as Promise<void> | null,
}));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    constructor(public events: Events) { fake.nodes.push(this); }
    start() { return Promise.resolve(); }
    getState() { return { links: [...fake.stored.keys()].filter((id) => !id.startsWith("group:")).map((id) => ({ id })), groups: [] }; }
    async getMessages(linkId: string) { return fake.stored.get(linkId) ?? []; }
    async messagePage({ linkId, limit = 50 }: { linkId: string; limit?: number }) {
      fake.pages++;
      const list = fake.stored.get(linkId) ?? [];
      await fake.gate;
      return { messages: list.slice(-limit), more: list.length > limit };
    }
    deletedIdsOf() { return []; }
    setActiveLink() {}
    appsCloseAll() {}
  },
}));

const { EngineServer } = await import("../src/engine/server");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const row = (linkId: string, i: number): StoredMessage => ({ linkId, id: `${linkId}:${i}`, text: `message ${i}`, sender: i % 2 ? "peer" : "me", timestamp: 1_700_000_000_000 + i, via: "datalink" });
const history = (linkId: string, n: number) => Array.from({ length: n }, (_, i) => row(linkId, i));
const client = () => {
  const got: (EngineEvent | RpcResponse)[] = [];
  return {
    got, post: (m: EngineEvent | RpcResponse) => void got.push(m),
    history: () => got.filter((m) => m.kind === "messages" || m.kind === "message-changes"),
    marks: () => got.filter((m): m is Extract<EngineEvent, { kind: "mark" }> => m.kind === "mark"),
  };
};
const fill = (chats: number, rows: number) => {
  fake.stored.clear();
  for (let c = 0; c < chats; c++) fake.stored.set(`chat${c}`, history(`chat${c}`, rows));
};
const newest = { newest: ROWS, marks: true };

describe("a page that attaches again with the mark of what it mirrored", () => {
  it("gets no chat that did not change since, and the ones that did", async () => {
    fill(CHATS, ROWS);
    const server = new EngineServer();
    const events = fake.nodes.at(-1)!.events;
    const first = client();
    server.attach(first, undefined, newest);
    await flush();
    expect(first.history()).toHaveLength(CHATS);
    const [mark] = first.marks();
    expect(mark).toEqual({ kind: "mark", epoch: server.epoch, mark: 0 });
    server.detach(first);

    // Nothing came: the reload gets no row, and reads no chat.
    fake.pages = 0;
    const reload = client();
    server.attach(reload, undefined, { ...newest, since: { epoch: mark.epoch, mark: mark.mark } });
    await flush();
    expect(reload.history()).toEqual([]);
    expect(fake.pages).toBe(0);
    expect(reload.marks()).toEqual([{ kind: "mark", epoch: server.epoch, mark: 0, skipped: [...fake.stored.keys()] }]);
    expect(JSON.stringify(reload.got).length).toBeLessThan(10 * 1024);
    server.detach(reload);

    // Two chats got a message while no tab was open: those two, and the mark after them.
    for (const id of ["chat7", "chat42"]) {
      fake.stored.get(id)!.push(row(id, ROWS));
      events.onMessageChanges!(id, { messages: [row(id, ROWS)], deleted: [] });
    }
    const later = client();
    server.attach(later, undefined, { ...newest, since: { epoch: mark.epoch, mark: mark.mark } });
    await flush();
    expect(later.history()).toEqual(["chat7", "chat42"].map((id) => ({ kind: "messages", linkId: id, messages: fake.stored.get(id)!.slice(-ROWS), more: true })));
    expect(later.marks().at(-1)).toMatchObject({ mark: 2 });
  });

  it("gets every chat for a mark of another engine (a replaced offscreen document), or none", async () => {
    fill(5, 10);
    const before = new EngineServer();
    const server = new EngineServer();
    expect(server.epoch).not.toBe(before.epoch);
    const page = client();
    server.attach(page, undefined, { ...newest, since: { epoch: before.epoch, mark: 99 } });
    await flush();
    expect(page.history()).toHaveLength(5);
    expect(page.marks()).toEqual([{ kind: "mark", epoch: server.epoch, mark: 0 }]);
  });

  it("gets a skipped chat's newest page when it first changes, not a change it has nothing to apply to", async () => {
    fill(3, 10);
    const server = new EngineServer();
    const events = fake.nodes.at(-1)!.events;
    const page = client();
    server.attach(page, undefined, { ...newest, since: { epoch: server.epoch, mark: 0 } });
    await flush();
    expect(page.history()).toEqual([]);
    fake.stored.get("chat1")!.push(row("chat1", 10));
    events.onMessageChanges!("chat1", { messages: [row("chat1", 10)], deleted: [] });
    await flush();
    expect(page.history()).toEqual([{ kind: "messages", linkId: "chat1", messages: fake.stored.get("chat1") }]);
    // Then its changes, on top of that page.
    events.onMessageChanges!("chat1", { messages: [row("chat1", 11)], deleted: [] });
    await flush();
    expect(page.history().at(-1)).toEqual({ kind: "message-changes", linkId: "chat1", messages: [row("chat1", 11)], deleted: [] });
  });

  it("hears a new mark once what changed was sent to it, not before", async () => {
    fill(2, 10);
    const server = new EngineServer();
    const events = fake.nodes.at(-1)!.events;
    const page = client();
    server.attach(page, undefined, { ...newest, since: { epoch: server.epoch, mark: 0 } });
    await flush();
    expect(page.marks()).toHaveLength(1);
    // A skipped chat's first change is its newest page, read first: the mark waits for it.
    let open!: () => void;
    fake.gate = new Promise<void>((resolve) => (open = resolve));
    events.onMessageChanges!("chat0", { messages: [row("chat0", 10)], deleted: [] });
    await flush();
    expect(page.marks()).toHaveLength(1);
    open();
    fake.gate = null;
    await flush();
    const kinds = page.got.map((m) => m.kind);
    expect(kinds.lastIndexOf("mark")).toBeGreaterThan(kinds.lastIndexOf("messages"));
    expect(page.marks().at(-1)).toEqual({ kind: "mark", epoch: server.epoch, mark: 1 });
    // A client that did not ask for marks hears none.
    const other = client();
    server.attach(other, undefined, { newest: ROWS });
    await flush();
    events.onMessageChanges!("chat0", { messages: [row("chat0", 11)], deleted: [] });
    await flush();
    expect(other.marks()).toEqual([]);
    expect(page.marks().at(-1)).toMatchObject({ mark: 2 });
  });
});
