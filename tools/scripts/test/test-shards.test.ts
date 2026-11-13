import { describe, expect, it } from "vitest";
import { ALONE, WORKERS, packages, split, staleWarning } from "../test-shards.mjs";

const unit = (id: string, files: string[], alone = false) => ({ id, dir: id, files, alone });

describe("the packages shards", () => {
  it("test what npm run test:packages tests", () => {
    expect(packages().map((p) => p.name)).toEqual(["@ghostly/core", "@ghostly/browser", "@ghostlytools/sdk", "@ghostly/extension", "@ghostlytools/cli", "@ghostly/mini-chess"]);
    expect(ALONE).toContain("packages/cli/test/twoPeers.test.ts");
  });

  it("run a file that runs alone first on a shard of its own, and the rest heaviest first to the least loaded", () => {
    const seconds = { a1: 100, a2: 50, b1: 120, c1: 30, long: 200 };
    const shards = split([unit("a", ["a1", "a2"]), unit("b", ["b1"]), unit("c", ["c1"]), unit("long", ["long"], true)], seconds, 3);
    expect(shards.map((s) => s.units.map((u) => u.id))).toEqual([["long"], ["a"], ["b", "c"]]);
    expect(shards.map((s) => s.load)).toEqual([200 * WORKERS, 150, 150]);
  });

  it("run other units after a file that runs alone, so its shard does not idle", () => {
    // Before, the long file's shard ran it only while the other ran a, b and c (210). Alone, long holds its runner
    // as long as 120 s of files that share it.
    const seconds = { a1: 120, b1: 60, c1: 30, long: 120 / WORKERS };
    const shards = split([unit("a", ["a1"]), unit("b", ["b1"]), unit("c", ["c1"]), unit("long", ["long"], true)], seconds, 2);
    expect(shards.map((s) => s.units.map((u) => u.id))).toEqual([["long", "b"], ["a", "c"]]);
    expect(shards.map((s) => s.load)).toEqual([180, 150]);
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

  it("warn when more than a tenth of the files have no recorded time", () => {
    const files = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const seconds = Object.fromEntries(files.map((f) => [f, 1]));
    expect(staleWarning([unit("a", files)], seconds)).toBeNull();
    expect(staleWarning([unit("a", files), unit("b", ["new1", "new2"])], seconds)).toBeNull();
    expect(staleWarning([unit("a", files), unit("b", ["new1", "new2", "new3"])], seconds)).toMatch(/^::warning::3 of the 23 test files have no time/);
  });

  it("need a shard for each file that runs alone", () => {
    expect(() => split([unit("long", ["long"], true), unit("other", ["other"], true)], {}, 1)).toThrow(/at least 2 shards/);
    expect(split([unit("long", ["long"], true), unit("a", ["a1"])], {}, 1)[0].units.map((u) => u.id)).toEqual(["long", "a"]);
  });
});
