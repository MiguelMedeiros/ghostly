// covers: groups.protocol.community-topology
import { describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { hubRank, rankHubs } from "../src/communityRendezvous";

const hashed = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@noble/hashes/sha2.js", async importOriginal => {
  const actual = await importOriginal<typeof import("@noble/hashes/sha2.js")>();
  const sha256 = Object.assign((...args: Parameters<typeof actual.sha256>) => { hashed.calls++; return actual.sha256(...args); }, actual.sha256);
  return { ...actual, sha256 };
});

/*
 * When a hub carrying many members goes and one hub is left, its members take turns stepping in by their rank for its
 * key among the roster's members (`stepsIn`), worked out a few times a tick for a minute. `rankHubs` hashed both keys
 * of each comparison its sort made: ~16 hashes a member for a roster of 256, about 20 ms a time on a desktop CPU.
 */
describe("rankHubs", () => {
  const roster = Array.from({ length: 256 }, () => createIdentity().pubKeyZ32);
  const subject = roster[0];

  it("hashes each key once", () => {
    hashed.calls = 0;
    rankHubs(subject, roster);
    expect(hashed.calls).toBe(roster.length);
  });

  it("orders as before: by hubRank, highest first, the same for any order it is given", () => {
    const expected = [...roster].sort((a, b) => { const ra = hubRank(subject, a), rb = hubRank(subject, b); return ra < rb ? 1 : ra > rb ? -1 : 0; });
    expect(rankHubs(subject, roster)).toEqual(expected);
    expect(rankHubs(subject, [...roster].reverse())).toEqual(expected);
    // A key listed twice stays twice, side by side.
    const twice = rankHubs(subject, [roster[5], ...roster.slice(0, 10)]);
    expect(twice).toHaveLength(11);
    expect(twice.filter(k => k === roster[5])).toHaveLength(2);
    expect(twice.indexOf(roster[5]) + 1).toBe(twice.lastIndexOf(roster[5]));
  });
});
