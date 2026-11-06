import { describe, expect, it } from "vitest";
import type { GroupState } from "@ghostly/core";
import type { GroupStore } from "../src/engine/groups";
import { GroupRows } from "../src/engine/groupRows";
import type { GroupLight, GroupLive, StoredGroup } from "../src/shared/types";
// covers: groups.hubs

/**
 * A private group's hubs (`StoredGroup.hubs`) and the members' apps it notes (`StoredGroup.large`) go to the group's
 * `GroupLight` row while nothing else of the record changed (`engine/groupRows.ts`), and come back from it at load.
 */

/** A store as the engine's database keeps a private group: the record, its small row and its `GroupLight` row. */
function memory() {
  const groups = new Map<string, StoredGroup>(), live = new Map<string, GroupLive>(), light = new Map<string, GroupLight>();
  const puts = { whole: 0, light: 0 };
  const store: GroupStore = {
    getGroups: async () => [...groups.values()].map(g => structuredClone(g)),
    putGroup: async (g, row) => { puts.whole++; groups.set(g.id, structuredClone(g)); if (row !== undefined) light.delete(g.id); if (row) live.set(g.id, structuredClone(row)); },
    deleteGroup: async id => { groups.delete(id); },
    getMessages: async () => [],
    getGroupLive: async () => structuredClone(live),
    putGroupLive: async (id, row) => { live.set(id, structuredClone(row)); },
    getGroupLight: async () => structuredClone(light),
    putGroupLight: async (id, row) => { puts.light++; light.set(id, structuredClone(row)); },
  };
  return { store, groups, light, puts };
}

const state = () => ({ seq: 3, seqEpoch: 1, seen: {}, sent: {}, nicks: {}, chain: [{ sig: "top" }], secrets: {} }) as unknown as GroupState;
const group = (): StoredGroup => ({ id: "g", name: "Hubs", state: state(), hubs: ["h1", "h2"], large: ["a", "b"] } as unknown as StoredGroup);

/** A record written whole, then the group as loaded from it by a new engine. */
async function loaded(m: ReturnType<typeof memory>) {
  const rows = new GroupRows(m.store);
  const groups = await m.store.getGroups();
  await rows.load(groups);
  return { rows, group: groups[0] };
}

describe("a private group's hubs, in its GroupLight row", () => {
  it("a change of hubs or a member's app noted writes the row alone, with the members noted since; a restart reads both back", async () => {
    const m = memory(), rows = new GroupRows(m.store), g = group();
    await rows.store.putGroup(g);
    expect(m.puts).toEqual({ whole: 1, light: 0 });
    g.hubs = ["h3", "h2"];
    await rows.store.putGroup(g);
    g.large = [...g.large!, "c"];
    await rows.store.putGroup(g);
    // The record as it was; the row holds the new hubs and only the member noted since.
    expect(m.puts).toEqual({ whole: 1, light: 2 });
    expect(m.groups.get("g")!.hubs).toEqual(["h1", "h2"]);
    expect(m.light.get("g")).toEqual({ removedIds: [], removals: [], hubs: ["h3", "h2"], large: ["c"] });
    const back = await loaded(m);
    expect(back.group.hubs).toEqual(["h3", "h2"]);
    expect(back.group.large).toEqual(["a", "b", "c"]);
    // Written whole again (a commit): the record holds them, and the row goes.
    back.group.state = { ...back.group.state!, chain: [{ sig: "top" }, { sig: "next" }] } as unknown as GroupState;
    await back.rows.store.putGroup(back.group);
    expect(m.groups.get("g")!.hubs).toEqual(["h3", "h2"]);
    expect(m.groups.get("g")!.large).toEqual(["a", "b", "c"]);
    expect(m.light.has("g")).toBe(false);
  });

  it("a row from before hubs were kept there leaves the record's; the record's members' apps are kept beside a row's", async () => {
    const m = memory(), rows = new GroupRows(m.store), g = group();
    await rows.store.putGroup(g);
    // A pin's row written by a build from before: no hubs, no members' apps in it.
    m.light.set("g", { removedIds: ["x:1:1"], removals: [] });
    let back = await loaded(m);
    expect(back.group.hubs).toEqual(["h1", "h2"]);
    expect(back.group.large).toEqual(["a", "b"]);
    expect(back.group.removedIds).toEqual(["x:1:1"]);
    // An app from before noted a member in the record (its state as it was), while a row of this build was there.
    m.light.set("g", { removedIds: [], removals: [], hubs: ["h9"], large: ["c"] });
    m.groups.get("g")!.large = ["a", "b", "d"];
    back = await loaded(m);
    expect(back.group.large).toEqual(["a", "b", "d", "c"]);
    // Its hubs are only where the edges go before the beacon is read: the row's, however old, are as good a start.
    expect(back.group.hubs).toEqual(["h9"]);
  });
});
