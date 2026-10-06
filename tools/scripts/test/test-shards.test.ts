import { describe, expect, it } from "vitest";
import { ALONE, packages, split } from "../test-shards.mjs";

const unit = (id: string, files: string[], alone = false) => ({ id, dir: id, files, alone });

describe("the packages shards", () => {
  it("test what npm run test:packages tests", () => {
    expect(packages().map((p) => p.name)).toEqual(["@ghostly/core", "@ghostly/browser", "@ghostlytools/sdk", "@ghostly/extension", "@ghostlytools/cli", "@ghostly/mini-chess"]);
    expect(ALONE).toContain("packages/cli/test/twoPeers.test.ts");
  });

  it("give a file that runs alone a shard nothing else joins, and the rest heaviest first to the least loaded", () => {
    const seconds = { a1: 100, a2: 50, b1: 120, c1: 30, long: 200 };
    const shards = split([unit("a", ["a1", "a2"]), unit("b", ["b1"]), unit("c", ["c1"]), unit("long", ["long"], true)], seconds, 3);
    expect(shards.map((s) => s.units.map((u) => u.id))).toEqual([["long"], ["a"], ["b", "c"]]);
    expect(shards.map((s) => s.load)).toEqual([200, 150, 150]);
  });

  it("count a file with no recorded time as a typical one, and split the same way every time", () => {
    const seconds = { a1: 1, b1: 2, c1: 3 };
    const units = [unit("x", ["new1", "new2"]), unit("a", ["a1"]), unit("b", ["b1"]), unit("c", ["c1"])];
    const once = split(units, seconds, 2).map((s) => s.units.map((u) => u.id));
    expect(once).toEqual([["x", "a"], ["c", "b"]]);
    expect(split([...units].reverse(), seconds, 2).map((s) => s.units.map((u) => u.id))).toEqual(once);
  });

  it("need more shards than files that run alone", () => {
    expect(() => split([unit("long", ["long"], true), unit("a", ["a1"])], {}, 1)).toThrow(/more than 1 shards/);
  });
});
