import { describe, expect, it } from "vitest";
import { HubClocks } from "../src/engine/hubClocks";
// covers: groups.hubs, groups.protocol.community-topology

/**
 * How a reader learns a hub's clock from the beacon (WISP 9xx · Group Community § Topology, Clocks that differ; WISP
 * 9xx · Group Mesh § Hubs): the private group's hubs and the community's share it. `t`: my clock; a hub two minutes
 * ahead dates its entries `t + 120 s`.
 */
const AHEAD = 120_000;
const entry = (ts: number, since?: number) => ({ key: "hub", ts, load: 3, ...(since !== undefined && { since }) });

describe("HubClocks", () => {
  it("learns a hub's clock once its entry moved between two readings, and reads it in my time", () => {
    const clocks = new HubClocks(() => "me", 75_000);
    // First reading: nothing says how far apart the clocks are; taken as written.
    expect(clocks.inMyTime([entry(1_000_000 + AHEAD)], 1_000_000)[0].ts).toBe(1_000_000 + AHEAD);
    // A minute later the entry moved (written 30 s ago by its clock): the hub is about two minutes ahead of me.
    const read = clocks.inMyTime([entry(1_030_000 + AHEAD, 900_000 + AHEAD)], 1_060_000);
    expect(clocks.ahead("hub")).toBe(-AHEAD);
    expect(read[0]).toEqual({ key: "hub", ts: 1_030_000, load: 3, since: 900_000 });
    // What goes back into the beacon is the entry as the hub dated it.
    expect(clocks.asWritten(read)).toEqual([entry(1_030_000 + AHEAD, 900_000 + AHEAD)]);
  });

  it("reads clocks that agree as written, and learns nothing from readings too far apart", () => {
    const clocks = new HubClocks(() => "me", 75_000);
    clocks.inMyTime([entry(1_000_000)], 1_000_000);
    clocks.inMyTime([entry(1_059_000)], 1_060_000);
    expect(clocks.ahead("hub")).toBe(0);
    const far = new HubClocks(() => "me", 45_000);
    far.inMyTime([entry(1_000_000 + AHEAD)], 1_000_000);
    far.inMyTime([entry(1_030_000 + AHEAD)], 1_060_000);
    expect(far.ahead("hub")).toBe(0);
  });

  it("never moves my own entry, and a reading of a new beacon says nothing of a move", () => {
    const clocks = new HubClocks(() => "hub", 75_000);
    clocks.inMyTime([entry(1_000_000 + AHEAD)], 1_000_000);
    expect(clocks.inMyTime([entry(1_030_000 + AHEAD)], 1_060_000)[0].ts).toBe(1_030_000 + AHEAD);
    const other = new HubClocks(() => "me", 75_000);
    other.inMyTime([entry(1_000_000 + AHEAD)], 1_000_000);
    other.restart();
    other.inMyTime([entry(1_030_000 + AHEAD)], 1_060_000);
    expect(other.ahead("hub")).toBe(0);
  });
});
