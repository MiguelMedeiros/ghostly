import { describe, expect, it } from "vitest";
import { ALONE, PARTS, packages, partPattern, partTests, split } from "../test-shards.mjs";

const unit = (id: string, files: string[], alone = false) => ({ id, dir: id, files, alone });

describe("the packages shards", () => {
  it("test what npm run test:packages tests", () => {
    expect(packages().map((p) => p.name)).toEqual(["@ghostly/core", "@ghostly/browser", "@ghostly/sdk", "@ghostly/extension", "@ghostly/cli"]);
    expect(ALONE).toContain("packages/cli/test/twoPeers.test.ts");
    for (const file of Object.keys(PARTS)) expect(ALONE).toContain(file);
  });

  it("give a file that runs alone a shard nothing else joins, and the rest heaviest first to the least loaded", () => {
    const seconds = { a1: 100, a2: 50, b1: 120, c1: 30, long: 200 };
    const shards = split([unit("a", ["a1", "a2"]), unit("b", ["b1"]), unit("c", ["c1"]), unit("long", ["long"], true)], seconds, 3);
    expect(shards.map((s) => s.units.map((u) => u.id))).toEqual([["long"], ["b"], ["a", "c"]]);
    expect(shards.map((s) => s.load)).toEqual([200, 120, 130]);
  });

  it("count a package by its longest file, or its sum over two when that is more: its files run side by side", () => {
    // Summed ("many" 240, "slow" 200, "few" 190), "slow" and "few" would share a shard: 360 s where they run.
    const seconds = { slow: 170, s2: 30, m1: 60, m2: 60, m3: 60, m4: 60, f1: 190 };
    const shards = split([unit("slow", ["slow", "s2"]), unit("many", ["m1", "m2", "m3", "m4"]), unit("few", ["f1"])], seconds, 2);
    expect(shards.map((s) => s.units.map((u) => u.id))).toEqual([["few"], ["slow", "many"]]);
    expect(shards.map((s) => s.load)).toEqual([190, 290]);
  });

  it("count a file with no recorded time as a typical one, and split the same way every time", () => {
    const seconds = { a1: 1, b1: 2, c1: 3 };
    const units = [unit("x", ["new1", "new2"]), unit("a", ["a1"]), unit("b", ["b1"]), unit("c", ["c1"])];
    const once = split(units, seconds, 2).map((s) => s.units.map((u) => u.id));
    expect(once).toEqual([["c", "a"], ["b", "x"]]);
    expect(split([...units].reverse(), seconds, 2).map((s) => s.units.map((u) => u.id))).toEqual(once);
  });

  it("give each part of a cut file a shard of its own, weighed as its share of the file", () => {
    const parts = [1, 2].map((part) => ({ ...unit(`long (part ${part}/2)`, ["long"], true), share: 1 / 2 }));
    const shards = split([...parts, unit("a", ["a1"]), unit("b", ["b1"])], { long: 200, a1: 150, b1: 40 }, 3);
    expect(shards.map((s) => s.units.map((u) => u.id))).toEqual([["long (part 1/2)"], ["long (part 2/2)"], ["a", "b"]]);
    expect(shards.map((s) => s.load)).toEqual([100, 100, 190]);
  });

  it("need more shards than files that run alone", () => {
    expect(() => split([unit("long", ["long"], true), unit("a", ["a1"])], {}, 1)).toThrow(/more than 1 shards/);
  });
});

describe("a file cut into parts by test name", () => {
  const cut = { setup: ["set up (one)"], parts: [["b", "c+d"]] };
  const all = ["story > set up (one)", "story > a", "story > b", "story > c+d", "story > e"];

  it("runs the setup and its own tests in each part but the last, and every other test in the last", () => {
    expect(partTests(all, cut)).toEqual([
      ["story > set up (one)", "story > b", "story > c+d"],
      ["story > set up (one)", "story > a", "story > e"],
    ]);
  });

  it("fails on a name the file no longer has, rather than run a part without it", () => {
    expect(() => partTests(all, { ...cut, parts: [["b", "gone"]] })).toThrow(/"gone"/);
  });

  it("selects by the end of the name Vitest matches, with the names taken literally", () => {
    // What Vitest matches -t against: a prefix of its own, then the names joined by spaces.
    const name = (test: string) => `x story ${test.split(" > ").pop()}`;
    const selected = (index: number) => all.filter((t) => new RegExp(partPattern(cut, index)).test(name(t)));
    expect([0, 1].map(selected)).toEqual(partTests(all, cut));
  });

  it("names each of twoPeers' tests once at most", () => {
    const { setup, parts } = PARTS["packages/cli/test/twoPeers.test.ts"];
    expect(new Set([...setup, ...parts.flat()]).size).toBe(setup.length + parts.flat().length);
  });
});
