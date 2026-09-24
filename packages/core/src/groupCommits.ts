import { fromBase64Url, toBase64Url, utf8Encode } from "./bytes";
import { publicKeyFromZ32, sign, verify } from "./identity";
import { sha256Hex } from "./groupCrypto";

/**
 * Membership of a `group-mesh/1` group is a chain of signed commits. Each
 * commit carries the whole roster after it, so any member can name the roster
 * of any epoch from the chain alone; the chain, from its genesis, is what
 * authenticates a roster to a member who was not there for the changes.
 *
 * Exactly one admin per epoch (the coordinator of WISP 900): every commit is
 * signed by the admin of the previous epoch, and admission of a new member,
 * removal, transfer of the admin role and a bare rotation each advance the
 * epoch by one. Two different commits after the same epoch are a fork, which
 * halts the group rather than picking a winner.
 */
export type GroupRole = "admin" | "member";
export type CommitKind = "create" | "add" | "remove" | "role" | "rotate";
export type Roster = [key: string, role: GroupRole][];

export interface GroupCommit {
  v: 1;
  /** Group id: 22 base64url characters. */
  g: string;
  /** Epoch: the commit's index in the chain, from 0. */
  e: number;
  /** Hash of the previous commit; empty for the genesis. */
  p: string;
  k: CommitKind;
  /** The roster after this commit, sorted by key. */
  m: Roster;
  /** The committer. */
  by: string;
  /** The member added, removed or made admin. */
  s?: string;
  ts: number;
  /** Confirmation tag: HMAC of the untagged commit under the new epoch's confirm key. */
  c: string;
  sig: string;
}

export const MAX_GROUP_MEMBERS = 8;
export const MAX_GROUP_CHAIN = 1024;
export const GROUP_ID = /^[A-Za-z0-9_-]{22}$/;
export const MEMBER_KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const TAG = /^[A-Za-z0-9_-]{43}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const HASH = /^[a-f0-9]{64}$/;

const tuple = (c: Omit<GroupCommit, "sig">, tag = c.c) => JSON.stringify([c.v, c.g, c.e, c.p, c.k, c.m, c.by, c.s ?? "", c.ts, tag]);

export function commitHash(commit: Omit<GroupCommit, "sig">): string { return sha256Hex(utf8Encode(tuple(commit))); }
/** What the confirmation tag covers: the commit with an empty tag. */
export function commitUntaggedHash(commit: Omit<GroupCommit, "sig" | "c">): string { return sha256Hex(utf8Encode(tuple({ ...commit, c: "" }, ""))); }

export function signCommit(commit: Omit<GroupCommit, "sig">, seed: Uint8Array): GroupCommit {
  return { ...commit, sig: toBase64Url(sign(utf8Encode(tuple(commit)), seed)) };
}

export function rosterAdmin(roster: Roster): string | undefined { return roster.find(([, role]) => role === "admin")?.[0]; }
export function rosterHas(roster: Roster, key: string): boolean { return roster.some(([k]) => k === key); }
export const sortRoster = (roster: Roster): Roster => [...roster].sort((a, b) => a[0] < b[0] ? -1 : 1);

function parseCommit(raw: unknown): GroupCommit | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (c.v !== 1 || typeof c.g !== "string" || !GROUP_ID.test(c.g) || !Number.isSafeInteger(c.e) || (c.e as number) < 0 ||
    typeof c.p !== "string" || (c.p !== "" && !HASH.test(c.p)) || !["create", "add", "remove", "role", "rotate"].includes(c.k as string) ||
    !Array.isArray(c.m) || c.m.length === 0 || c.m.length > MAX_GROUP_MEMBERS ||
    !c.m.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && MEMBER_KEY.test(entry[0]) && (entry[1] === "admin" || entry[1] === "member")) ||
    typeof c.by !== "string" || !MEMBER_KEY.test(c.by) || (c.s !== undefined && (typeof c.s !== "string" || !MEMBER_KEY.test(c.s))) ||
    !Number.isSafeInteger(c.ts) || (c.ts as number) <= 0 || typeof c.c !== "string" || !TAG.test(c.c) || typeof c.sig !== "string" || !SIG.test(c.sig)) return null;
  const m = c.m as Roster;
  if (new Set(m.map(([k]) => k)).size !== m.length || m.filter(([, r]) => r === "admin").length !== 1) return null;
  for (let i = 1; i < m.length; i++) if (!(m[i - 1][0] < m[i][0])) return null;
  return { v: 1, g: c.g, e: c.e as number, p: c.p, k: c.k as CommitKind, m, by: c.by, ...(c.s !== undefined ? { s: c.s as string } : {}), ts: c.ts as number, c: c.c, sig: c.sig };
}

/** The roster a commit must carry, given the previous one; null when the change is not allowed. */
export function expectedRoster(previous: Roster | null, kind: CommitKind, by: string, subject?: string): Roster | null {
  if (kind === "create") return previous === null && !subject ? [[by, "admin"]] : null;
  if (!previous || rosterAdmin(previous) !== by) return null;
  switch (kind) {
    case "add":
      if (!subject || subject === by || rosterHas(previous, subject) || previous.length >= MAX_GROUP_MEMBERS) return null;
      return sortRoster([...previous, [subject, "member"]]);
    case "remove":
      if (!subject || subject === by || !rosterHas(previous, subject)) return null;
      return previous.filter(([k]) => k !== subject);
    case "role":
      if (!subject || subject === by || !rosterHas(previous, subject)) return null;
      return previous.map(([k]) => [k, k === subject ? "admin" : "member"]);
    case "rotate":
      return subject ? null : previous;
  }
}

const sameRoster = (a: Roster, b: Roster) => a.length === b.length && a.every(([k, r], i) => b[i][0] === k && b[i][1] === r);

/**
 * Checks one commit against the chain so far (`previous` is its last commit,
 * or null for a genesis): index, link, authority, roster arithmetic and
 * signature. The confirmation tag is checked separately, once the secret is known.
 */
export function verifyCommit(raw: unknown, previous: GroupCommit | null, groupId?: string): { commit: GroupCommit } | { error: string } {
  const commit = parseCommit(raw);
  if (!commit) return { error: "Malformed membership commit" };
  if (groupId && commit.g !== groupId) return { error: "Commit for another group" };
  if (previous) {
    if (commit.g !== previous.g) return { error: "Commit for another group" };
    if (commit.e !== previous.e + 1) return { error: "Commit out of sequence" };
    if (commit.p !== commitHash(previous)) return { error: "Commit does not follow the last known membership" };
  } else if (commit.e !== 0 || commit.p !== "" || commit.k !== "create") return { error: "The chain does not start with the creation of the group" };
  const expected = expectedRoster(previous?.m ?? null, commit.k, commit.by, commit.s);
  if (!expected || !sameRoster(expected, commit.m)) return { error: "Unauthorized or inconsistent membership change" };
  if (!verify(fromBase64Url(commit.sig), utf8Encode(tuple(commit)), publicKeyFromZ32(commit.by))) return { error: "Membership commit signature is invalid" };
  return { commit };
}

/** Only shape and signature: evidence that `by` signed this, whatever chain it belongs to. */
export function verifyCommitSignature(raw: unknown): GroupCommit | null {
  const commit = parseCommit(raw);
  return commit && verify(fromBase64Url(commit.sig), utf8Encode(tuple(commit)), publicKeyFromZ32(commit.by)) ? commit : null;
}

/** A whole chain, from genesis. */
export function verifyChain(raw: unknown, groupId?: string): { chain: GroupCommit[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_GROUP_CHAIN) return { error: "Malformed membership chain" };
  const chain: GroupCommit[] = [];
  for (const entry of raw) {
    const result = verifyCommit(entry, chain[chain.length - 1] ?? null, groupId);
    if ("error" in result) return result;
    chain.push(result.commit);
  }
  return { chain };
}
