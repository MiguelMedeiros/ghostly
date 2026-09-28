import { describe, expect, it, vi } from "vitest";
import type { MessageChanges } from "../src/shared/messageChanges";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
// covers: extension.engine

/**
 * What changed in a chat or group reaches each client as only that, on top of a whole history it was sent before: a
 * chat's in the first snapshot, a group's (never in it) read whole on its first change. Everything for one chat or
 * group reaches a client in the order it happened, even while a whole history is being read.
 */
type Events = { onMessages(linkId: string, messages: StoredMessage[]): void; onMessageChanges?(linkId: string, changes: MessageChanges): void };
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
    getState() { return { links: [{ id: "chat" }], groups: [{ id: "g" }] }; }
    async getMessages(linkId: string) {
      fake.reads.push(linkId);
      const list = fake.stored.get(linkId) ?? [];
      await fake.gate;
      return list;
    }
    setActiveLink() {}
  },
}));

const { EngineServer } = await import("../src/engine/server");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const row = (linkId: string, id: string): StoredMessage => ({ linkId, id, text: id, sender: "peer", timestamp: 1, via: "datalink" });
const client = () => {
  const got: (EngineEvent | RpcResponse)[] = [];
  return { got, post: (m: EngineEvent | RpcResponse) => void got.push(m), history: () => got.filter((m) => m.kind === "messages" || m.kind === "message-changes") };
};

describe("what changed in a history", () => {
  it("goes alone to a client that has the history, and a history it lacks goes whole first, then what changes", async () => {
    fake.stored.set("chat", [row("chat", "a")]);
    fake.stored.set("group:g", [row("group:g", "x"), row("group:g", "y")]);
    const server = new EngineServer();
    const page = client();
    server.attach(page);
    await flush();
    const events = fake.nodes.at(-1)!.events;
    expect(page.history()).toEqual([{ kind: "messages", linkId: "chat", messages: [row("chat", "a")] }]);

    events.onMessageChanges!("chat", { messages: [row("chat", "b")], deleted: ["a"] });
    expect(page.history().at(-1)).toEqual({ kind: "message-changes", linkId: "chat", messages: [row("chat", "b")], deleted: ["a"] });

    // A group's first change: its whole history, read once, holds the change already.
    fake.reads = [];
    events.onMessageChanges!("group:g", { messages: [row("group:g", "y")], deleted: [] });
    await flush();
    expect(fake.reads).toEqual(["group:g"]);
    expect(page.history().at(-1)).toEqual({ kind: "messages", linkId: "group:g", messages: fake.stored.get("group:g") });
    events.onMessageChanges!("group:g", { messages: [row("group:g", "z")], deleted: [] });
    expect(page.history().at(-1)).toMatchObject({ kind: "message-changes", linkId: "group:g" });
    expect(fake.reads).toEqual(["group:g"]);
  });

  it("keeps a group's changes in order behind its whole history, and a second client gets the history too", async () => {
    fake.stored.set("group:g", [row("group:g", "x")]);
    const server = new EngineServer();
    const first = client(), second = client();
    server.attach(first);
    await flush();
    const events = fake.nodes.at(-1)!.events;
    events.onMessageChanges!("group:g", { messages: [row("group:g", "x")], deleted: [] });
    await flush();
    // The second client comes while the group is read for nobody; the first one has its history.
    server.attach(second);
    await flush();
    let open!: () => void;
    fake.gate = new Promise<void>((resolve) => (open = resolve));
    events.onMessageChanges!("group:g", { messages: [row("group:g", "y")], deleted: [] });
    events.onMessageChanges!("group:g", { messages: [], deleted: ["x"] });
    await flush();
    // The first client heard the first change; the next one waits behind the read the second client needs.
    expect(first.history().filter((m) => m.linkId === "group:g").map((m) => m.kind)).toEqual(["messages", "message-changes"]);
    open();
    fake.gate = null;
    await flush();
    expect(first.history().filter((m) => m.linkId === "group:g").map((m) => m.kind)).toEqual(["messages", "message-changes", "message-changes"]);
    expect(second.history().filter((m) => m.linkId === "group:g").map((m) => m.kind)).toEqual(["messages", "message-changes"]);
    expect(second.history().at(-1)).toEqual({ kind: "message-changes", linkId: "group:g", messages: [], deleted: ["x"] });
  });

  it("sends a whole history to every client as before when the peer sends one", async () => {
    const server = new EngineServer();
    const page = client();
    server.attach(page);
    await flush();
    fake.nodes.at(-1)!.events.onMessages("group:g", [row("group:g", "w")]);
    expect(page.history().at(-1)).toEqual({ kind: "messages", linkId: "group:g", messages: [row("group:g", "w")] });
    fake.reads = [];
    fake.nodes.at(-1)!.events.onMessageChanges!("group:g", { messages: [row("group:g", "v")], deleted: [] });
    expect(page.history().at(-1)).toMatchObject({ kind: "message-changes" });
    expect(fake.reads).toEqual([]);
  });
});
