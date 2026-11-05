import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type GroupSession } from "@ghostly/core";
import { db } from "../src/engine/db";
import { Groups, type GroupStore, type GroupsHost } from "../src/engine/groups";
import { SEQ_BLOCK } from "../src/engine/groupRows";
import { STORES, clearProfileStores, groupLiveKey, store, wrap } from "../src/shared/idb";
import type { StoredGroup } from "../src/shared/types";
// covers: groups.send

/*
 * A message sent in a private group wrote the group's whole record: its membership chain, which carries the whole
 * roster at each commit and grows with every join and leave for good (50 KB a message in a group of 32 just made,
 * 800 KB after 150 joins and leaves). Now it writes the group's small row; the record is written when a commit lands.
 * An app from before reads the record alone and must never send at a number already used.
 */

/** Characters written per store from here on, by `put`. */
function writes(): Record<string, number> {
  const written: Record<string, number> = {};
  const real = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    written[this.name] = (written[this.name] ?? 0) + JSON.stringify(args[0]).length;
    return real.apply(this, args);
  });
  return written;
}

/** An engine whose every member's edge is up: the numbers of the messages it sent, in order. */
function engine(groupStore: GroupStore = db): { groups: Groups; said: number[] } {
  const edges = new Map<string, Map<string, string>>(), said: number[] = [];
  const host = {
    // One frame per member: a number once.
    sendOnLink: (_linkId: string, frame: { t?: string; n?: number }) => { if (frame.t === "group-msg" && said.at(-1) !== frame.n) said.push(frame.n!); },
    linkReady: () => true,
    contactName: () => undefined,
    edges: (groupId: string) => edges.get(groupId) ?? new Map(),
    openEdge: async (state: { id: string }, peer: string) => {
      const id = `edge:${peer}`;
      if (!edges.has(state.id)) edges.set(state.id, new Map());
      edges.get(state.id)!.set(peer, id);
      return id;
    },
    closeEdge: async () => {},
    edgeNick: () => undefined,
    openEntry: async () => "entry",
    entries: () => new Map(),
    publish: async () => {},
    resolve: async () => null,
    storeMessage: async () => true,
    emit: () => {},
  } as unknown as GroupsHost;
  return { groups: new Groups(host, groupStore), said };
}

const sessionOf = (groups: Groups, id: string) => (groups as unknown as { sessions: Map<string, GroupSession> }).sessions.get(id)!;

/** A group of `size` (me included) after `cycles` members joined and left. */
async function grown(groups: Groups, size: number, cycles: number): Promise<string> {
  const id = await groups.create("Ghosts", "mesh");
  const session = sessionOf(groups, id);
  for (let i = 1; i < size; i++) await session.admit(createIdentity().pubKeyZ32);
  for (let i = 0; i < cycles; i++) {
    const key = createIdentity().pubKeyZ32;
    await session.admit(key);
    await session.remove(key);
  }
  return id;
}

const record = async (id: string) => wrap((await store(STORES.groups, "readonly")).get(id)) as Promise<StoredGroup>;

afterEach(() => { vi.restoreAllMocks(); });

describe("a private group's saves", () => {
  it("a message writes a few KB, however long the group's membership history", async () => {
    const { groups, said } = engine();
    await groups.load();
    const id = await grown(groups, 31, 20);
    expect(JSON.stringify(await record(id)).length, "the record holds the chain").toBeGreaterThan(100_000);
    for (let i = 0; i < 3; i++) {
      const written = writes();
      expect((await groups.send(id, `hello ${i}`)).error).toBeNull();
      const total = Object.values(written).reduce((sum, n) => sum + n, 0);
      expect(total, `message ${i}: ${JSON.stringify(written)}`).toBeLessThan(8_000);
      expect(written[STORES.groups] ?? 0, "the record is not written").toBe(0);
      vi.restoreAllMocks();
    }
    expect(said).toEqual([0, 1, 2]);
    // A commit writes the record, and the next message is small again.
    await sessionOf(groups, id).rotate();
    const written = writes();
    await groups.send(id, "after the rotate");
    expect(written[STORES.groups] ?? 0).toBe(0);
    // Growing the history is the slow part (50 commits, each writing a record of up to 100 KB): 2 s on a quiet machine,
    // past the default 5 s on a busy CI runner.
  }, 30_000);

  it("started again, the group goes on from its last number, without a gap or a number used twice", async () => {
    const first = engine();
    await first.groups.load();
    const id = await grown(first.groups, 3, 0);
    for (const text of ["one", "two", "three"]) await first.groups.send(id, text);
    await first.groups.flush();
    expect(first.said).toEqual([0, 1, 2]);
    expect((await record(id)).state!.seq, "the record reserves numbers above them").toBe(SEQ_BLOCK);

    const again = engine();
    await again.groups.load();
    await again.groups.send(id, "four");
    expect(again.said).toEqual([3]);
  });

  it("an app from before, reading the record alone, sends above every number used; back here, so does this one", async () => {
    const now = engine();
    await now.groups.load();
    const id = await grown(now.groups, 3, 2);
    for (let i = 0; i < 5; i++) await now.groups.send(id, `new ${i}`);
    await now.groups.flush();
    expect(now.said).toEqual([0, 1, 2, 3, 4]);

    // As the apps from before do: the groups' records, no small rows.
    const before: GroupStore = { getGroups: () => db.getGroups(), putGroup: group => db.putGroup(group), deleteGroup: groupId => db.deleteGroup(groupId), getMessages: linkId => db.getMessages(linkId) };
    const old = engine(before);
    await old.groups.load();
    for (let i = 0; i < 2; i++) await old.groups.send(id, `old ${i}`);
    await old.groups.flush();
    expect(Math.min(...old.said)).toBeGreaterThan(Math.max(...now.said));
    // Its small row is still there, from before the old app ran: the record it wrote since counts.
    expect(await wrap((await store(STORES.settings, "readonly")).get(groupLiveKey(id)))).toBeDefined();

    const back = engine();
    await back.groups.load();
    await back.groups.send(id, "back");
    expect(back.said[0]).toBeGreaterThan(Math.max(...old.said));
    expect(new Set([...now.said, ...old.said, ...back.said]).size).toBe(now.said.length + old.said.length + back.said.length);
  });

  it("forgetting a group, or clearing the profile's data, deletes its small row", async () => {
    const { groups } = engine();
    await groups.load();
    const live = async (id: string) => wrap((await store(STORES.settings, "readonly")).get(groupLiveKey(id)));
    const [one, two] = [await grown(groups, 2, 0), await grown(groups, 2, 0)];
    for (const id of [one, two]) await groups.send(id, "hi");
    expect(await live(one)).toBeDefined();
    await db.deleteGroup(one);
    expect(await live(one)).toBeUndefined();
    expect(await live(two)).toBeDefined();
    await clearProfileStores();
    expect(await live(two)).toBeUndefined();
  });
});
