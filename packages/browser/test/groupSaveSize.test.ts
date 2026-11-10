import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOVED_TEXT, createIdentity, type GroupSession } from "@ghostly/core";
import { db } from "../src/engine/db";
import { Groups, type GroupStore, type GroupsHost } from "../src/engine/groups";
import { SEQ_BLOCK } from "../src/engine/groupRows";
import { openRows } from "../src/engine/sealedRows";
import { STORES, clearProfileStores, committed, groupLightKey, groupLiveKey, store, wrap } from "../src/shared/idb";
import type { GroupLight, StoredGroup } from "../src/shared/types";
import { CommunityWorld } from "./communityWorld";
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
function engine(groupStore: GroupStore = db): { groups: Groups; said: number[]; host: GroupsHost } {
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
  return { groups: new Groups(host, groupStore), said, host };
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

  it("a pin and a deletion for everyone, mine or a member's, write the small row, and are there when the app starts again", async () => {
    await clearProfileStores();
    const first = engine();
    await first.groups.load();
    const id = await grown(first.groups, 31, 20);
    const sent = await first.groups.send(id, "pin me");
    await first.groups.flush();
    const now = Date.now();
    const actions: Array<[string, () => Promise<unknown>]> = [
      ["a pin", () => first.groups.setPin(id, { id: sent.messageId!, n: now, by: "me", at: now })],
      ["a member's deletion", async () => { await first.groups.removed(id, "member:0:1"); await first.groups.flush(); }],
      ["my deletion", () => first.groups.setRemovals(id, [{ id: sent.messageId!, e: 1, at: now, pending: true }])],
      ["my deletion said", async () => { await first.groups.setRemovals(id, [{ id: sent.messageId!, e: 1, at: now }]); await first.groups.flush(); }],
    ];
    for (const [action, act] of actions) {
      const written = writes();
      await act();
      const total = Object.values(written).reduce((sum, n) => sum + n, 0);
      expect(total, `${action}: ${JSON.stringify(written)}`).toBeLessThan(8_000);
      expect(written[STORES.groups] ?? 0, `${action}: the record is not written`).toBe(0);
      vi.restoreAllMocks();
    }

    // Many deletions kept: a message does not write them again.
    for (let i = 2; i < 200; i++) await first.groups.removed(id, `member:0:${i}`);
    await first.groups.flush();
    const written = writes();
    await first.groups.send(id, "still small");
    expect(Object.values(written).reduce((sum, n) => sum + n, 0)).toBeLessThan(2_000);
    vi.restoreAllMocks();

    const again = engine();
    await again.groups.load();
    expect(again.groups.pinOf(id)).toMatchObject({ id: sent.messageId, n: now });
    expect(again.groups.isRemoved(id, "member:0:1")).toBe(true);
    expect(again.groups.isRemoved(id, "member:0:199")).toBe(true);
    expect(again.groups.removals(id)).toEqual([{ id: sent.messageId, e: 1, at: now }]);
    // A commit writes the record whole, with them in it: they are still there after the next start.
    await sessionOf(again.groups, id).rotate();
    await again.groups.flush();
    const third = engine();
    await third.groups.load();
    expect(third.groups.pinOf(id)).toMatchObject({ id: sent.messageId, n: now });
    expect(third.groups.isRemoved(id, "member:0:199")).toBe(true);
  }, 30_000);

  it("a member's edit or deletion for everyone that comes in writes the edits it keeps to hand on, not the whole record, and they are there when the app starts again", async () => {
    const world = new CommunityWorld();
    vi.spyOn(Date, "now").mockImplementation(() => world.now);
    const [alice, bob] = ["alice", "bob"].map(name => world.add(name));
    const id = await alice.groups.create("Ghosts", "mesh");
    await bob.groups.joinByLink(await alice.groups.enableLink(id));
    await world.until(() => world.member(bob, id), 5 * 60_000);
    for (let i = 0; i < 40; i++) {
      const key = createIdentity().pubKeyZ32;
      await sessionOf(alice.groups, id).admit(key);
      await sessionOf(alice.groups, id).remove(key);
    }
    await world.run(60_000);
    const { messageId } = await bob.groups.send(id, "hello");
    await world.until(() => alice.messages.some(m => m.id === messageId), 60_000);
    await alice.groups.flush();
    const raw = alice.store as Required<GroupStore>;
    expect(JSON.stringify((await raw.getGroups()).find(g => g.id === id)).length, "the record holds the chain").toBeGreaterThan(40_000);
    const edits: Array<[string, { e: number; m: string; rm?: true }]> = [["an edit", { e: 1, m: "hello again" }], ["another", { e: 2, m: "hello, all" }], ["a deletion for everyone", { e: 3, m: REMOVED_TEXT, rm: true }]];
    for (const [action, edit] of edits) {
      const record = vi.spyOn(raw, "putGroup");
      expect(await bob.groups.sendEdit(id, { id: messageId!, ts: world.now, ...edit })).toBeNull();
      await world.run(5_000);
      await alice.groups.flush();
      expect(record.mock.calls.filter(([g]) => g.id === id).length, `${action}: the record is not written`).toBe(0);
      record.mockRestore();
    }
    const kept = sessionOf(alice.groups, id).state.relayEdits!.map(f => f.v);
    expect(kept).toEqual([3]);
    await world.restart(alice);
    expect(sessionOf(alice.groups, id).state.relayEdits!.map(f => f.v), "kept to hand on after a restart").toEqual(kept);
  }, 60_000);

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

  it("a pin, an unpin or a member's deletion for everyone taken by an app from before is not undone back here by the row of their own", async () => {
    await clearProfileStores();
    const now = engine();
    await now.groups.load();
    const [one, two] = [await grown(now.groups, 3, 0), await grown(now.groups, 3, 0)];
    const m1 = (await now.groups.send(one, "m1")).messageId!, m2 = (await now.groups.send(one, "m2")).messageId!;
    const at = Date.now();
    // Group two: its record holds a pin (a commit wrote it whole), then a newer one goes to their row.
    await now.groups.setPin(two, { id: "first", n: at, by: "me", at });
    await sessionOf(now.groups, two).rotate();
    await now.groups.setPin(two, { id: "second", n: at + 1, by: "me", at });
    // Group one: a pin and a member's deletion in their row alone.
    await now.groups.setPin(one, { id: m1, n: at, by: "me", at });
    await now.groups.removed(one, "member:0:1");
    await now.groups.flush();

    // As the apps from before do: the groups' records, no small rows, no row for the pin and the deletions.
    const before: GroupStore = { getGroups: () => db.getGroups(), putGroup: group => db.putGroup(group), deleteGroup: groupId => db.deleteGroup(groupId), getMessages: linkId => db.getMessages(linkId) };
    const old = engine(before);
    await old.groups.load();
    expect(old.groups.pinOf(one)).toBeUndefined();
    expect(old.groups.pinOf(two)).toMatchObject({ id: "first" });
    // It pins, unpins and hears a deletion; it sends nothing and takes no commit.
    await old.groups.setPin(one, { id: m2, n: at + 2, by: "me", at });
    await old.groups.setPin(two, { id: "", n: at + 2, by: "me", at });
    await old.groups.removed(one, "member:0:2");
    await old.groups.flush();

    const back = engine();
    await back.groups.load();
    expect(back.groups.pinOf(one)).toMatchObject({ id: m2 });
    expect(back.groups.pinOf(two)).toMatchObject({ id: "" });
    expect(back.groups.isRemoved(one, "member:0:2")).toBe(true);
    // What the app from before never saw is lost with its row, as when it sends.
    expect(back.groups.isRemoved(one, "member:0:1")).toBe(false);

    // What this app takes from here on goes to their row again, and counts at the next start.
    await back.groups.removed(one, "member:0:3");
    await back.groups.setPin(one, { id: m1, n: at + 3, by: "me", at });
    await back.groups.flush();
    const third = engine();
    await third.groups.load();
    expect(third.groups.pinOf(one)).toMatchObject({ id: m1, n: at + 3 });
    expect(third.groups.isRemoved(one, "member:0:2")).toBe(true);
    expect(third.groups.isRemoved(one, "member:0:3")).toBe(true);
  });

  it("v1.10.1 loads a group whose small row carries `of` as if the row were not there; a row without `of`, from builds before, still counts here", async () => {
    await clearProfileStores();
    const now = engine();
    await now.groups.load();
    const id = await grown(now.groups, 3, 0);
    const sent = (await now.groups.send(id, "pin me")).messageId!;
    const at = Date.now();
    await now.groups.setPin(id, { id: sent, n: at, by: "me", at });
    await now.groups.removed(id, "member:0:1");
    await now.groups.flush();
    const getLight = async () => wrap((await store(STORES.settings, "readonly")).get(groupLightKey(id))) as Promise<GroupLight>;
    const putLight = async (light: GroupLight) => committed((await store(STORES.settings, "readwrite")).put(light, groupLightKey(id)));
    const light = await getLight();
    expect(light.of, "the row carries `of`").toEqual(expect.any(String));
    expect(light).toMatchObject({ pin: { id: sent }, removedIds: ["member:0:1"] });

    // v1.10.1's db.getGroups (`git show v1.10.1:packages/browser/src/engine/db.ts`): the groups store alone.
    const getGroupsV1101 = async () => openRows(STORES.groups, await wrap((await store(STORES.groups, "readonly")).getAll()) as StoredGroup[]);
    const read = await getGroupsV1101();
    await committed((await store(STORES.settings, "readwrite")).delete(groupLightKey(id)));
    expect(await getGroupsV1101(), "the row and its `of` change nothing it reads").toEqual(read);
    await putLight(light);

    // A row as builds before `of` wrote it: this one takes its pin and deletion, as it did.
    const { of: _, ...withoutOf } = light;
    await putLight(withoutOf);
    const back = engine();
    await back.groups.load();
    expect(back.groups.pinOf(id)).toMatchObject({ id: sent, n: at });
    expect(back.groups.isRemoved(id, "member:0:1")).toBe(true);
    await putLight(light);

    // v1.10.1 itself: the group loads, without the pin and deletion it never saw, and goes on sending.
    const v1101: GroupStore = { getGroups: getGroupsV1101, putGroup: group => db.putGroup(group), deleteGroup: groupId => db.deleteGroup(groupId), getMessages: linkId => db.getMessages(linkId) };
    const old = engine(v1101);
    await old.groups.load();
    expect(old.groups.pinOf(id)).toBeUndefined();
    expect(old.groups.isRemoved(id, "member:0:1")).toBe(false);
    await old.groups.send(id, "from 1.10.1");
    expect(old.said[0]).toBeGreaterThan(Math.max(...now.said));
  });

  it("killed right after a send saved its counter and frame: that save went to the small row, and opened again the text is stored and said", async () => {
    // The other tests' groups would be opened again too.
    await clearProfileStores();
    let dead = false;
    const die = () => { dead = true; throw new Error("killed"); };
    // A killed app writes nothing more.
    const disk: GroupStore = { getGroups: () => db.getGroups(), deleteGroup: groupId => db.deleteGroup(groupId), getMessages: linkId => db.getMessages(linkId),
      getGroupLive: () => db.getGroupLive(), putGroup: (group, live) => dead ? die() : db.putGroup(group, live), putGroupLive: (groupId, live) => dead ? die() : db.putGroupLive(groupId, live) };
    const first = engine(disk);
    await first.groups.load();
    const id = await grown(first.groups, 3, 0);
    await first.groups.send(id, "one");
    await first.groups.flush();
    // The kill: once the send saved, as its row is stored.
    first.host.storeMessage = async () => die();
    const written = writes();
    await first.groups.send(id, "two").catch(() => {});
    expect(dead).toBe(true);
    expect(written[STORES.groups] ?? 0, "the record is not written").toBe(0);
    expect(first.said).toEqual([0]);
    vi.restoreAllMocks();

    const again = engine(), stored: string[] = [];
    again.host.storeMessage = async message => { stored.push(message.text); return true; };
    await again.groups.load();
    await again.groups.tick();
    await vi.waitFor(() => expect(again.said).toEqual([1]));
    expect(stored).toEqual(["two"]);
    await again.groups.send(id, "three");
    expect(again.said).toEqual([1, 2]);
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
