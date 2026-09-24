import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { toBase64Url } from "../src/bytes";
import { confirmationTag, epochKeys, newEpochSecret } from "../src/groupCrypto";
import {
  MAX_GROUP_CHAIN, MAX_GROUP_MEMBERS, commitHash, commitUntaggedHash, expectedRoster, rosterAdmin, rosterHas, signCommit, sortRoster,
  verifyChain, verifyCommit, verifyCommitSignature, type GroupCommit, type Roster,
} from "../src/groupCommits";
import { createIdentity, type Identity } from "../src/identity";

// covers: groups.protocol.commits

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const G = toBase64Url(new Uint8Array(16).fill(9));

type Draft = Omit<GroupCommit, "sig" | "c">;
function draft(prev: GroupCommit | null, kind: GroupCommit["k"], m: Roster, by: string, s?: string, g = prev?.g ?? G): Draft {
  return { v: 1, g, e: prev ? prev.e + 1 : 0, p: prev ? commitHash(prev) : "", k: kind, m, by, ...(s ? { s } : {}), ts: 1 };
}
const seal = (d: Draft, by: Identity) =>
  signCommit({ ...d, c: confirmationTag(epochKeys(newEpochSecret(), d.g, d.e).confirm, commitUntaggedHash(d)) }, by.seed);

const admin = createIdentity(), bob = createIdentity(), carol = createIdentity();
const genesis = seal(draft(null, "create", [[admin.pubKeyZ32, "admin"]], admin.pubKeyZ32), admin);
const addBob = seal(draft(genesis, "add", sortRoster([[admin.pubKeyZ32, "admin"], [bob.pubKeyZ32, "member"]]), admin.pubKeyZ32, bob.pubKeyZ32), admin);

describe("commit parsing refuses malformed peer input", () => {
  const mutations: [string, (c: Record<string, unknown>) => void][] = [
    ["an unknown version", c => { c.v = 2; }],
    ["a version as a string", c => { c.v = "1"; }],
    ["a short group id", c => { c.g = "abc"; }],
    ["a group id with a bad character", c => { c.g = G.slice(0, -1) + "+"; }],
    ["a negative epoch", c => { c.e = -1; }],
    ["a fractional epoch", c => { c.e = 0.5; }],
    ["an epoch as a string", c => { c.e = "1"; }],
    ["an unsafe epoch", c => { c.e = 2 ** 53; }],
    ["a previous hash that is not hex", c => { c.p = "z".repeat(64); }],
    ["an uppercase previous hash", c => { c.p = (c.p as string).toUpperCase(); }],
    ["a truncated previous hash", c => { c.p = (c.p as string).slice(1); }],
    ["a previous hash that is not a string", c => { c.p = null; }],
    ["an unknown kind", c => { c.k = "promote"; }],
    ["a roster that is not an array", c => { c.m = {}; }],
    ["an empty roster", c => { c.m = []; }],
    ["a roster entry with three fields", c => { c.m = [[admin.pubKeyZ32, "admin", "x"]]; }],
    ["a roster entry that is not a tuple", c => { c.m = [admin.pubKeyZ32]; }],
    ["a roster key that is not z-base-32", c => { c.m = [["A".repeat(52), "admin"]]; }],
    ["an unknown role", c => { c.m = (c.m as Roster).map(([k, r]) => [k, r === "member" ? "owner" : r]); }],
    ["a committer that is not a key", c => { c.by = "admin"; }],
    ["a committer that is not a string", c => { c.by = 1; }],
    ["a subject that is not a string", c => { c.s = 5; }],
    ["a subject that is not a key", c => { c.s = "bob"; }],
    ["a zero timestamp", c => { c.ts = 0; }],
    ["a fractional timestamp", c => { c.ts = 1.5; }],
    ["a timestamp as a string", c => { c.ts = "1"; }],
    ["a truncated confirmation tag", c => { c.c = (c.c as string).slice(1); }],
    ["a confirmation tag that is not a string", c => { c.c = 0; }],
    ["a truncated signature", c => { c.sig = (c.sig as string).slice(1); }],
    ["a signature with a bad character", c => { c.sig = "+" + (c.sig as string).slice(1); }],
    ["a missing signature", c => { delete c.sig; }],
    ["two admins", c => { c.m = (c.m as Roster).map(([k]) => [k, "admin"]); }],
    ["no admin", c => { c.m = (c.m as Roster).map(([k]) => [k, "member"]); }],
    ["a duplicate key", c => { c.m = [[admin.pubKeyZ32, "admin"], [admin.pubKeyZ32, "member"]]; }],
    ["an unsorted roster", c => { c.m = [...(c.m as Roster)].reverse(); }],
  ];
  it.each(mutations)("refuses a commit with %s", (_, mutate) => {
    const raw = clone(addBob) as unknown as Record<string, unknown>;
    mutate(raw);
    expect(verifyCommit(raw, genesis)).toEqual({ error: "Malformed membership commit" });
    expect(verifyCommitSignature(raw)).toBeNull();
  });

  it("refuses non-objects", () => {
    for (const raw of [null, undefined, 0, "commit", true, []]) {
      expect(verifyCommit(raw, null)).toEqual({ error: "Malformed membership commit" });
      expect(verifyCommitSignature(raw)).toBeNull();
    }
  });

  it("refuses a roster of more than eight members, even if well formed otherwise", () => {
    const keys = Array.from({ length: MAX_GROUP_MEMBERS + 1 }, () => createIdentity().pubKeyZ32);
    const raw = { ...clone(addBob), m: sortRoster(keys.map((k, i) => [k, i === 0 ? "admin" : "member"])) };
    expect(verifyCommit(raw, genesis)).toEqual({ error: "Malformed membership commit" });
  });

  it("drops fields it does not know, so they are not carried or re-signed", () => {
    const raw = { ...clone(addBob), extra: "x" };
    const result = verifyCommit(raw, genesis);
    expect(result).toHaveProperty("commit");
    expect((result as { commit: object }).commit).not.toHaveProperty("extra");
  });

  it("never throws on arbitrary JSON, and never accepts it", () => {
    fc.assert(fc.property(fc.jsonValue(), raw => {
      expect(verifyCommit(raw, genesis)).toHaveProperty("error");
      expect(verifyCommit(raw, null)).toHaveProperty("error");
      expect(verifyCommitSignature(raw)).toBeNull();
    }), { numRuns: 200 });
  });

  it("never accepts a valid commit with any one field replaced by another value", () => {
    const fields = ["v", "g", "e", "p", "k", "m", "by", "s", "ts", "c", "sig"] as const;
    fc.assert(fc.property(fc.constantFrom(...fields), fc.jsonValue(), (field, value) => {
      const raw = clone(addBob) as unknown as Record<string, unknown>;
      fc.pre(JSON.stringify(raw[field]) !== JSON.stringify(value));
      raw[field] = value;
      expect(verifyCommit(raw, genesis)).toHaveProperty("error");
    }), { numRuns: 200 });
  });
});

describe("commit chain rules", () => {
  it("refuses a commit for another group than the one asked for", () => {
    expect(verifyCommit(clone(genesis), null, toBase64Url(new Uint8Array(16)))).toEqual({ error: "Commit for another group" });
    expect(verifyChain(clone([genesis, addBob]), toBase64Url(new Uint8Array(16)))).toEqual({ error: "Commit for another group" });
  });

  it("refuses a commit whose group differs from the previous commit's", () => {
    const other = seal(draft(genesis, "add", addBob.m, admin.pubKeyZ32, bob.pubKeyZ32, toBase64Url(new Uint8Array(16).fill(1))), admin);
    expect(verifyCommit(clone(other), genesis)).toEqual({ error: "Commit for another group" });
  });

  it("refuses a replayed commit: the same commit again, or an older one, is out of sequence", () => {
    expect(verifyCommit(clone(addBob), addBob)).toEqual({ error: "Commit out of sequence" });
    expect(verifyCommit(clone(genesis), addBob)).toEqual({ error: "Commit out of sequence" });
    expect(verifyChain(clone([genesis, addBob, addBob]))).toEqual({ error: "Commit out of sequence" });
  });

  it("refuses a commit that skips an epoch", () => {
    const skip = seal({ ...draft(genesis, "add", addBob.m, admin.pubKeyZ32, bob.pubKeyZ32), e: 2 }, admin);
    expect(verifyCommit(clone(skip), genesis)).toEqual({ error: "Commit out of sequence" });
  });

  it("only starts a chain with a creation at epoch 0 with no previous hash", () => {
    const expected = { error: "The chain does not start with the creation of the group" };
    expect(verifyCommit(clone(addBob), null)).toEqual(expected);
    expect(verifyCommit(clone(seal({ ...draft(null, "create", genesis.m, admin.pubKeyZ32), e: 1 }, admin)), null)).toEqual(expected);
    expect(verifyCommit(clone(seal({ ...draft(null, "create", genesis.m, admin.pubKeyZ32), p: "a".repeat(64) }, admin)), null)).toEqual(expected);
    expect(verifyCommit(clone(seal(draft(null, "rotate", genesis.m, admin.pubKeyZ32), admin)), null)).toEqual(expected);
  });

  it("refuses a creation that names a subject or seats anyone but its creator as admin", () => {
    const withSubject = seal(draft(null, "create", genesis.m, admin.pubKeyZ32, bob.pubKeyZ32), admin);
    expect(verifyCommit(clone(withSubject), null)).toEqual({ error: "Unauthorized or inconsistent membership change" });
    const otherAdmin = seal(draft(null, "create", [[bob.pubKeyZ32, "admin"]], admin.pubKeyZ32), admin);
    expect(verifyCommit(clone(otherAdmin), null)).toEqual({ error: "Unauthorized or inconsistent membership change" });
  });

  it("refuses a second creation in the middle of a chain", () => {
    const recreate = seal(draft(genesis, "create", genesis.m, admin.pubKeyZ32), admin);
    expect(verifyCommit(clone(recreate), genesis)).toEqual({ error: "Unauthorized or inconsistent membership change" });
  });

  it("refuses a commit signed by a key other than its committer", () => {
    const forged = seal(draft(genesis, "add", addBob.m, admin.pubKeyZ32, bob.pubKeyZ32), bob);
    expect(verifyCommit(clone(forged), genesis)).toEqual({ error: "Membership commit signature is invalid" });
    expect(verifyCommitSignature(clone(forged))).toBeNull();
  });

  it("refuses a commit whose confirmation tag was swapped after signing", () => {
    const swapped = { ...clone(addBob), c: confirmationTag(new Uint8Array(32), "x") };
    expect(verifyCommit(swapped, genesis)).toEqual({ error: "Membership commit signature is invalid" });
  });

  it("vouches for a signature on any chain, but not for tampering", () => {
    const foreign = seal(draft(genesis, "rotate", genesis.m, admin.pubKeyZ32), admin);
    expect(verifyCommitSignature(clone(foreign))?.by).toBe(admin.pubKeyZ32);
    expect(verifyCommitSignature({ ...clone(foreign), ts: 2 })).toBeNull();
  });

  it("refuses chains that are not arrays, are empty, or are longer than the limit", () => {
    const expected = { error: "Malformed membership chain" };
    expect(verifyChain(null)).toEqual(expected);
    expect(verifyChain({ 0: genesis, length: 1 })).toEqual(expected);
    expect(verifyChain([])).toEqual(expected);
    expect(verifyChain(new Array(MAX_GROUP_CHAIN + 1).fill(genesis))).toEqual(expected);
  });

  it("reports the first bad commit of a chain", () => {
    expect(verifyChain(clone([genesis, { ...addBob, ts: 2 }]))).toEqual({ error: "Membership commit signature is invalid" });
    expect(verifyChain(clone([genesis, addBob]))).toHaveProperty("chain");
  });

  it("hashes a commit over its tag, and its untagged hash ignores the tag", () => {
    const other = { ...addBob, c: "B".repeat(43) };
    expect(commitHash(other)).not.toBe(commitHash(addBob));
    expect(commitUntaggedHash(other)).toBe(commitUntaggedHash(addBob));
  });
});

describe("roster arithmetic", () => {
  const A = admin.pubKeyZ32, B = bob.pubKeyZ32, C = carol.pubKeyZ32;
  const two = sortRoster([[A, "admin"], [B, "member"]]);

  it("creates only from nothing and without a subject", () => {
    expect(expectedRoster(null, "create", A)).toEqual([[A, "admin"]]);
    expect(expectedRoster(null, "create", A, B)).toBeNull();
    expect(expectedRoster(two, "create", A)).toBeNull();
  });

  it("allows changes only by the admin of the previous roster", () => {
    for (const kind of ["add", "remove", "role", "rotate"] as const) {
      expect(expectedRoster(null, kind, A, C)).toBeNull();
      expect(expectedRoster(two, kind, B, kind === "add" ? C : A)).toBeNull();
    }
  });

  it("adds a new member once, never the admin itself, never past the cap, never without a subject", () => {
    expect(expectedRoster(two, "add", A, C)).toEqual(sortRoster([...two, [C, "member"]]));
    expect(expectedRoster(two, "add", A)).toBeNull();
    expect(expectedRoster(two, "add", A, A)).toBeNull();
    expect(expectedRoster(two, "add", A, B)).toBeNull();
    const full: Roster = sortRoster([[A, "admin"], ...Array.from({ length: MAX_GROUP_MEMBERS - 1 }, () => [createIdentity().pubKeyZ32, "member"] as [string, "member"])]);
    expect(expectedRoster(full, "add", A, C)).toBeNull();
  });

  it("removes only a present member other than the admin", () => {
    expect(expectedRoster(two, "remove", A, B)).toEqual([[A, "admin"]]);
    expect(expectedRoster(two, "remove", A)).toBeNull();
    expect(expectedRoster(two, "remove", A, A)).toBeNull();
    expect(expectedRoster(two, "remove", A, C)).toBeNull();
  });

  it("hands the admin role only to a present member, and the old admin becomes a member", () => {
    const after = expectedRoster(two, "role", A, B)!;
    expect(rosterAdmin(after)).toBe(B);
    expect(after.find(([k]) => k === A)?.[1]).toBe("member");
    expect(expectedRoster(two, "role", A)).toBeNull();
    expect(expectedRoster(two, "role", A, A)).toBeNull();
    expect(expectedRoster(two, "role", A, C)).toBeNull();
  });

  it("rotates without a subject and without changing the roster", () => {
    expect(expectedRoster(two, "rotate", A)).toBe(two);
    expect(expectedRoster(two, "rotate", A, B)).toBeNull();
  });

  it("answers membership and admin questions, and sorts without mutating", () => {
    expect(rosterHas(two, B)).toBe(true);
    expect(rosterHas(two, C)).toBe(false);
    expect(rosterAdmin([[B, "member"]])).toBeUndefined();
    const unsorted: Roster = [["z".repeat(52), "member"], ["y".repeat(52), "admin"]];
    const sorted = sortRoster(unsorted);
    expect(sorted.map(([k]) => k[0])).toEqual(["y", "z"]);
    expect(unsorted[0][0][0]).toBe("z");
  });
});
