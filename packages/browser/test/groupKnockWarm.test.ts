import { describe, expect, it } from "vitest";
import { decodeGroupEntryLink, knockIdentity, knockRecords, readKnocks, type GhostRecord } from "@ghostly/core";
import { Groups, type GroupStore, type GroupsHost } from "../src/engine/groups";
import type { StoredGroup } from "../src/shared/types";
// covers: groups.link.enable, groups.protocol.entry

/** An admin's engine over a Pkarr map: what it publishes under which key, and what a read finds. */
function admin() {
  const pkarr = new Map<string, GhostRecord[]>();
  const published: string[] = [];
  const groups = new Map<string, StoredGroup>();
  const host = {
    entries: () => new Map(), edges: () => new Map(), linkReady: () => false, closeEdge: async () => {},
    publish: async (identity: { pubKeyZ32: string }, records: GhostRecord[]) => { published.push(identity.pubKeyZ32); pkarr.set(identity.pubKeyZ32, records); },
    resolve: async (key: string) => pkarr.get(key) ?? null,
    storeMessage: async () => {}, emit: () => {},
  } as unknown as GroupsHost;
  const store: GroupStore = {
    getGroups: async () => [...groups.values()], putGroup: async g => { groups.set(g.id, g); },
    deleteGroup: async id => { groups.delete(id); }, getMessages: async () => [],
  };
  return { engine: new Groups(host, store), pkarr, published };
}

describe("a private group's link: the knock record on the relays", () => {
  it("is there, empty, from the moment the link is made: the first joiner reads and writes a key the relays know", async () => {
    const { engine, pkarr, published } = admin();
    await engine.load();
    const groupId = await engine.create("Ghosts", "mesh");
    const link = decodeGroupEntryLink(await engine.enableLink(groupId))!;
    const key = knockIdentity(link).pubKeyZ32;
    await Promise.resolve();
    expect(published).toEqual([key]);
    expect(readKnocks(link, pkarr.get(key)!)).toEqual([]);
    // Handed out again: nothing more is written while the record is there.
    await engine.enableLink(groupId);
    await engine.tick();
    await engine.enableLink(groupId);
    expect(published).toEqual([key]);
  });

  it("never replaces a record it read: a knock that is there stays, and a new link gets a record of its own", async () => {
    const { engine, pkarr, published } = admin();
    await engine.load();
    const groupId = await engine.create("Ghosts", "mesh");
    const first = decodeGroupEntryLink(await engine.enableLink(groupId))!;
    const key = knockIdentity(first).pubKeyZ32;
    // Someone knocked, and their app is gone again: the admin opens an entry session nobody answers. The record is theirs.
    pkarr.set(key, knockRecords(first, [{ key: first.host, ts: Date.now() }]));
    await engine.tick();
    await engine.enableLink(groupId);
    expect(readKnocks(first, pkarr.get(key)!)).toHaveLength(1);
    expect(published).toEqual([key]);
    const second = decodeGroupEntryLink(await engine.enableLink(groupId, true))!;
    await Promise.resolve();
    expect(published).toEqual([key, knockIdentity(second).pubKeyZ32]);
  });
});
