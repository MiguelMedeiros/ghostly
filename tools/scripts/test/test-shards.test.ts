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

  it("cut a package too heavy for one shard by its files, and run each shard's files of it as one part", () => {
    // big weighs 300 of the 450 the 3 shards share (150 each): whole, its shard would take 300 and the others 90 and 60.
    const seconds = { b1: 120, b2: 80, b3: 60, b4: 40, c1: 90, d1: 60 };
    const big = { ...unit("big", ["b1", "b2", "b3", "b4"]), whole: true };
    const shards = split([big, unit("c", ["c1"]), unit("d", ["d1"])], seconds, 3);
    expect(shards.map((s) => s.load)).toEqual([160, 150, 140]);
    expect(shards.map((s) => s.units.map((u) => [u.id, u.files, u.whole]))).toEqual([
      [["big", ["b1", "b4"], false]],
      [["c", ["c1"], undefined], ["d", ["d1"], undefined]],
      [["big", ["b2", "b3"], false]],
    ]);
    // Every file once, and the same split whatever order the units come in.
    expect(shards.flatMap((s) => s.units.flatMap((u) => u.files)).sort()).toEqual(Object.keys(seconds).sort());
    expect(split([unit("d", ["d1"]), unit("c", ["c1"]), { ...big }], seconds, 3)).toEqual(shards);
  });

  it("keep a cut package whole when all its files land on one shard", () => {
    const seconds = { b1: 50, b2: 50, c1: 10 };
    const shards = split([{ ...unit("big", ["b1", "b2"]), whole: true }, unit("c", ["c1"])], seconds, 1);
    expect(shards[0].units.map((u) => [u.id, u.files, u.whole])).toEqual([["big", ["b1", "b2"], true], ["c", ["c1"], undefined]]);
  });

  it("need more shards than files that run alone", () => {
    expect(() => split([unit("long", ["long"], true), unit("a", ["a1"])], {}, 1)).toThrow(/more than 1 shards/);
  });
});
