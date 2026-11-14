import { describe, expect, it } from "vitest";
import type { GroupState } from "@ghostly/core";
import type { GroupStore } from "../src/engine/groups";
import { GroupRows } from "../src/engine/groupRows";
import type { GroupLive, StoredGroup } from "../src/shared/types";
// covers: groups.send

/**
 * What my stored rows hold, read once at a start (`GroupSession.ownRows`), is kept with the state (`GroupState.rowHigh`)
 * so a later start reads none of them. Only while the record is this build's: an app from before that wrote it since
 * may have stored rows of mine above what was read (one killed mid-send), and they are read again.
 */

function memory() {
  const groups = new Map<string, StoredGroup>(), live = new Map<string, GroupLive>();
  const store: GroupStore = {
    getGroups: async () => [...groups.values()].map(g => structuredClone(g)),
    putGroup: async (g, row) => { groups.set(g.id, structuredClone(g)); if (row) live.set(g.id, structuredClone(row)); },
    deleteGroup: async id => { groups.delete(id); },
    getMessages: async () => [],
    getGroupLive: async () => structuredClone(live),
    putGroupLive: async (id, row) => { live.set(id, structuredClone(row)); },
  };
  return { store, groups, live };
}

const group = (): StoredGroup => ({ id: "g", name: "Rows", createdAt: 1,
  state: { seq: 3, seqEpoch: 1, seen: {}, sent: [], nicks: {}, chain: [{ sig: "top" }], secrets: {}, rowHigh: { 1: 7 } } as unknown as GroupState });

async function loaded(m: ReturnType<typeof memory>): Promise<StoredGroup> {
  const groups = await m.store.getGroups();
  await new GroupRows(m.store).load(groups);
  return groups[0];
}

describe("my rows' highest numbers, kept with a private group's state", () => {
  it("stay at the next start when the record is this build's", async () => {
    const m = memory();
    await new GroupRows(m.store).store.putGroup(group());
    expect((await loaded(m)).state!.rowHigh).toEqual({ 1: 7 });
  });

  it("go when an app from before sent since (the record's counter is not the one reserved): the rows are read again", async () => {
    const m = memory();
    await new GroupRows(m.store).store.putGroup(group());
    const record = m.groups.get("g")!;
    record.state = { ...record.state!, seq: record.state!.seq + 1 };
    expect((await loaded(m)).state!.rowHigh).toBeUndefined();
  });

  it("go when the record has no small row (written by an app from before the small rows)", async () => {
    const m = memory();
    await new GroupRows(m.store).store.putGroup(group());
    m.live.clear();
    expect((await loaded(m)).state!.rowHigh).toBeUndefined();
  });
});
