import { describe, expect, it, vi } from "vitest";
import type { MessageChanges } from "../src/shared/messageChanges";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
// covers: groups.send

/**
 * A page that opens a group asks for its whole history (`EngineServer.history`): it comes once the groups are read, as
 * `groupMessages` answers, not after the whole engine start; and the group's next message is a change of it, not its
 * whole history read again.
 */
type Events = { onMessages(linkId: string, messages: StoredMessage[]): void; onMessageChanges?(linkId: string, changes: MessageChanges): void };
const fake = vi.hoisted(() => ({
  nodes: [] as { events: Events; groupsLoaded(): void }[],
  stored: new Map<string, StoredMessage[]>(),
  reads: [] as string[],
  started: null as (() => void) | null,
}));

vi.mock("../src/engine/node", () => ({
  GhostlyNode: class {
    groupsLoaded!: () => void;
    readonly groupsRead = new Promise<void>((resolve) => { this.groupsLoaded = resolve; });
    constructor(public events: Events) { fake.nodes.push(this); }
    start() { return new Promise<void>((resolve) => { fake.started = resolve; }); }
    getState() { return { links: [], groups: [] }; }
    async getMessages(linkId: string) {
      fake.reads.push(linkId);
      return fake.stored.get(linkId) ?? [];
    }
    setActiveLink() {}
    appsCloseAll() {}
  },
}));

const { EngineServer } = await import("../src/engine/server");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const GROUP = "group:g1";
const row = (i: number): StoredMessage => ({ linkId: GROUP, id: `m${i}`, text: `Message ${i}`, sender: "peer", member: "alice", timestamp: 1_700_000_000_000 + i, via: "datalink" });
const client = () => {
  const got: (EngineEvent | RpcResponse)[] = [];
  return { got, post: (m: EngineEvent | RpcResponse) => void got.push(m), history: () => got.filter((m) => m.kind === "messages" || m.kind === "message-changes") };
};

describe("a group's history asked by a page", () => {
  it("comes once the groups are read, while the engine still starts, and then only what changes", async () => {
    fake.stored.set(GROUP, Array.from({ length: 300 }, (_, i) => row(i)));
    const server = new EngineServer();
    const node = fake.nodes.at(-1)!;
    const page = client();
    server.attach(page);
    void server.history(page, GROUP);
    await flush();
    expect(page.history()).toEqual([]);
    node.groupsLoaded();
    await flush();
    expect(page.history()).toEqual([{ kind: "messages", linkId: GROUP, messages: fake.stored.get(GROUP) }]);

    fake.reads = [];
    node.events.onMessageChanges!(GROUP, { messages: [row(300)], deleted: [] });
    await flush();
    expect(page.history().at(-1)).toEqual({ kind: "message-changes", linkId: GROUP, messages: [row(300)], deleted: [] });
    expect(fake.reads).toEqual([]);
    fake.started?.();
  });
});
