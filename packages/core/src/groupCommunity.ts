import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "./bytes";
import { identityFromSeedB64, publicKeyFromZ32, sign, verify } from "./identity";
import { sanitizeNick } from "./text";
import {
  confirmationMatches, confirmationTag, decryptText, encryptText, epochKeys, newEpochSecret, openSecret, sealSecret, sha256Hex,
  type SealedSecret,
} from "./groupCrypto";
import { GROUP_ID, MEMBER_KEY, rosterAdmin, rosterHas, sortRoster, type GroupRole, type Roster } from "./groupCommits";
import {
  encodeGroupMetaBody, groupMetaNewer, groupMetaPicture, groupMetaTag, openGroupMeta, parseGroupMetaFrame, parseGroupMetaTag, signGroupMeta, verifyGroupMetaSignature, wrapGroupMeta,
  type GroupMeta, type GroupMetaFrame,
} from "./groupMeta";

/**
 * `group-community/1` (WISP 9xx · Group Community): a group whose link is the way in, for hundreds
 * of members, where the admin need not be online for anyone to join.
 *
 * What differs from `group-mesh/1`:
 *  - any member may commit `add` (admission) and `leave` (on the leaver's signed request); the admin
 *    keeps `remove`, `role`, `rotate` and `link`;
 *  - a commit carries the hash of the roster after it, not the roster, and members replay the chain;
 *  - `add`, `role` and `link` derive the next epoch's secret from the previous one and the commit, so
 *    only a newcomer is sent it; `leave`, `remove` and `rotate` get a fresh secret sealed to everyone;
 *  - concurrent commits are a race with a deterministic winner (longest branch, then lowest hash of
 *    the first commit after the common parent), not a fork. Two commits by the admin after the same
 *    commit are still a fork and halt the group;
 *  - messages name the commit of their epoch, so messages under a commit that lost stay readable;
 *    every member keeps recent frames from everyone and re-sends them to whoever was away.
 *
 * Transport-agnostic, like `GroupSession`: frames go out through the hooks and come in through
 * `handle(from, frame)`, where `from` is the member key of the edge the frame arrived on (which
 * may be a hub relaying someone else's frame: everything relayed is signed by its author).
 */
export const COMMUNITY_PROFILE = "group-community/1" as const;

export const COMMUNITY_LIMITS = {
  members: 256,
  chain: 2048,
  textBytes: 16 * 1024,
  /** Frames from everyone kept for whoever was away. */
  store: 256,
  storeBytes: 1024 * 1024,
  /** Epoch secrets kept (by commit), main branch and losing ones together. */
  secrets: 96,
  /** How far back a competing branch may start; older ones are refused and their authors commit again. */
  window: 64,
  /** Commits known off the main branch. */
  side: 512,
  /** Commits waiting for their parent. */
  pendingCommits: 64,
  waiting: 64,
  waitingBytes: 1024 * 1024,
  replay: 256,
  /** Commits in one welcome or chain piece. */
  chainPiece: 100,
  pendingLeaves: 64,
} as const;

/** What every member should know about who can read what, and what the link does, in the words the apps show. */
export const GROUP_READ_NOTE_COMMUNITY = `Anyone with the group's link can join, and any member can let people in. Everyone in the group can read everything sent while they are a member; someone removed cannot read what comes after, someone who joins later cannot read what came before. Members who were away get the last ${COMMUNITY_LIMITS.store} messages from whoever is there when they return.`;

/** A community group's link: `group2/<group id>/<entry key>` (web: `#/join/group2/…`). */
export function encodeCommunityLink(link: { g: string; host: string }): string { return `group2/${link.g}/${link.host}`; }
/** A pasted link, a `/join/…` path or the bare code; null when it is not a community group's link. */
export function decodeCommunityLink(input: string): { g: string; host: string } | null {
  const clean = input.trim().replace(/^.*#/, "").replace(/^.*?\/join\//, "").replace(/^\/+/, "");
  const parts = clean.split("/");
  if (parts.length !== 3 || parts[0] !== "group2" || !GROUP_ID.test(parts[1]) || !MEMBER_KEY.test(parts[2])) return null;
  try { publicKeyFromZ32(parts[2]); return { g: parts[1], host: parts[2] }; } catch { return null; }
}

export type CommunityKind = "create" | "add" | "leave" | "remove" | "role" | "rotate" | "link";
const KINDS: CommunityKind[] = ["create", "add", "leave", "remove", "role", "rotate", "link"];
/** Kinds whose epoch secret is fresh: they take someone out, or start or re-key the group. */
const FRESH: ReadonlySet<CommunityKind> = new Set(["create", "leave", "remove", "rotate"]);

export interface CommunityCommit {
  v: 2;
  g: string;
  e: number;
  /** Hash of the parent commit; empty for the genesis. */
  p: string;
  k: CommunityKind;
  /** SHA-256 (hex) of the canonical roster after this commit. */
  m: string;
  by: string;
  s?: string;
  /** Entry key (`create`, `link`); empty in a `link` turns the link off. */
  x?: string;
  /** Genesis nonce: the group id derives from it and the creator. */
  n?: string;
  /** The leaver's signature, in a `leave`. */
  ls?: string;
  ts: number;
  c: string;
  sig: string;
}

const HASH = /^[a-f0-9]{64}$/;
const TAG = /^[A-Za-z0-9_-]{43}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const B64 = /^[A-Za-z0-9_-]*$/;

const tuple = (c: Omit<CommunityCommit, "sig">, tag = c.c) =>
  JSON.stringify([2, c.g, c.e, c.p, c.k, c.m, c.by, c.s ?? "", c.x ?? "", c.n ?? "", c.ls ?? "", c.ts, tag]);
export function communityCommitHash(c: Omit<CommunityCommit, "sig">): string { return sha256Hex(utf8Encode(tuple(c))); }
export function communityUntaggedHash(c: Omit<CommunityCommit, "sig" | "c">): string { return sha256Hex(utf8Encode(tuple({ ...c, c: "" }, ""))); }
export const shortHash = (hash: string) => hash.slice(0, 16);
export function rosterHash(roster: Roster): string { return sha256Hex(utf8Encode(JSON.stringify(roster))); }

/** The id of a community group: from its creator and a nonce, so no other genesis can claim it. */
export function communityGroupId(creator: string, nonce: string): string {
  return toBase64Url(sha256(concatBytes(utf8Encode("ghostly-group-community/1 id"), publicKeyFromZ32(creator), fromBase64Url(nonce))).slice(0, 16));
}

export const leaveStatement = (g: string, s: string) => utf8Encode(JSON.stringify(["ghostly-group/2 leave", g, s]));

/** The secret of an epoch that adds, re-roles or re-links: from the previous one and the commit. */
export function derivedSecret(previous: Uint8Array, untaggedHash: string): Uint8Array {
  return hkdf(sha256, previous, utf8Encode(untaggedHash), utf8Encode("ghostly-group/2 derived"), 32);
}

function parseCommit(raw: unknown): CommunityCommit | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const key = (v: unknown) => typeof v === "string" && MEMBER_KEY.test(v);
  if (c.v !== 2 || typeof c.g !== "string" || !GROUP_ID.test(c.g) || !Number.isSafeInteger(c.e) || (c.e as number) < 0 ||
    typeof c.p !== "string" || (c.p !== "" && !HASH.test(c.p)) || !KINDS.includes(c.k as CommunityKind) ||
    typeof c.m !== "string" || !HASH.test(c.m) || !key(c.by) || (c.s !== undefined && !key(c.s)) ||
    (c.x !== undefined && !(c.x === "" || key(c.x))) || (c.n !== undefined && (typeof c.n !== "string" || !NONCE.test(c.n))) ||
    (c.ls !== undefined && (typeof c.ls !== "string" || !SIG.test(c.ls))) ||
    !Number.isSafeInteger(c.ts) || (c.ts as number) <= 0 || typeof c.c !== "string" || !TAG.test(c.c) || typeof c.sig !== "string" || !SIG.test(c.sig)) return null;
  const out: CommunityCommit = { v: 2, g: c.g, e: c.e as number, p: c.p, k: c.k as CommunityKind, m: c.m, by: c.by as string, ts: c.ts as number, c: c.c, sig: c.sig };
  if (c.s !== undefined) out.s = c.s as string;
  if (c.x !== undefined) out.x = c.x as string;
  if (c.n !== undefined) out.n = c.n as string;
  if (c.ls !== undefined) out.ls = c.ls as string;
  return out;
}

/** The roster a commit of this kind makes of the previous one; null when it is not allowed. */
export function communityRoster(previous: Roster | null, c: Pick<CommunityCommit, "k" | "by" | "s" | "x" | "n" | "ls" | "g">): Roster | null {
  if (c.k === "create") return previous === null && !c.s && !!c.x && !!c.n ? [[c.by, "admin"]] : null;
  if (!previous || !rosterHas(previous, c.by)) return null;
  const admin = rosterAdmin(previous);
  switch (c.k) {
    case "add":
      if (!c.s || c.x !== undefined || rosterHas(previous, c.s) || previous.length >= COMMUNITY_LIMITS.members) return null;
      return sortRoster([...previous, [c.s, "member"]]);
    case "leave":
      if (!c.s || c.s === c.by || c.s === admin || !rosterHas(previous, c.s) || !c.ls) return null;
      if (!verify(fromBase64Url(c.ls), leaveStatement(c.g, c.s), publicKeyFromZ32(c.s))) return null;
      return previous.filter(([k]) => k !== c.s);
    case "remove":
      if (c.by !== admin || !c.s || c.s === c.by || !rosterHas(previous, c.s)) return null;
      return previous.filter(([k]) => k !== c.s);
    case "role":
      if (c.by !== admin || !c.s || c.s === c.by || !rosterHas(previous, c.s)) return null;
      return previous.map(([k]) => [k, k === c.s ? "admin" : "member"] as [string, GroupRole]);
    case "rotate":
      return c.by === admin && !c.s && c.x === undefined ? previous : null;
    case "link":
      return c.by === admin && !c.s && c.x !== undefined ? previous : null;
    default:
      return null;
  }
}

/**
 * One commit against its parent (null for a genesis) and the parent's roster: shape, id, link,
 * authority, roster arithmetic, roster hash and signature. The confirmation tag is checked once
 * the secret is known.
 */
export function verifyCommunityCommit(raw: unknown, parent: CommunityCommit | null, parentRoster: Roster | null, groupId?: string): { commit: CommunityCommit; roster: Roster } | { error: string } {
  const commit = parseCommit(raw);
  if (!commit) return { error: "Malformed membership commit" };
  if (groupId && commit.g !== groupId) return { error: "Commit for another group" };
  if (parent) {
    if (commit.g !== parent.g) return { error: "Commit for another group" };
    if (commit.e !== parent.e + 1) return { error: "Commit out of sequence" };
    if (commit.p !== communityCommitHash(parent)) return { error: "Commit does not follow its parent" };
  } else {
    if (commit.e !== 0 || commit.p !== "" || commit.k !== "create") return { error: "The chain does not start with the creation of the group" };
    if (communityGroupId(commit.by, commit.n ?? "") !== commit.g) return { error: "The group id is not this genesis's" };
  }
  if (commit.k !== "create" && commit.n !== undefined) return { error: "Malformed membership commit" };
  if (commit.k !== "leave" && commit.ls !== undefined) return { error: "Malformed membership commit" };
  const roster = communityRoster(parent ? parentRoster : null, commit);
  if (!roster) return { error: "Unauthorized or inconsistent membership change" };
  if (rosterHash(roster) !== commit.m) return { error: "The roster hash does not match the change" };
  if (!verify(fromBase64Url(commit.sig), utf8Encode(tuple(commit)), publicKeyFromZ32(commit.by))) return { error: "Membership commit signature is invalid" };
  return { commit, roster };
}

/** A whole chain from its genesis; the rosters after each commit and the entry key at the end. */
export function verifyCommunityChain(raw: unknown, groupId?: string): { chain: CommunityCommit[]; roster: Roster; entry: string; rosters: Roster[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > COMMUNITY_LIMITS.chain) return { error: "Malformed membership chain" };
  const chain: CommunityCommit[] = [], rosters: Roster[] = [];
  let entry = "";
  for (const entryRaw of raw) {
    const result = verifyCommunityCommit(entryRaw, chain[chain.length - 1] ?? null, rosters[rosters.length - 1] ?? null, groupId);
    if ("error" in result) return result;
    chain.push(result.commit); rosters.push(result.roster);
    if (result.commit.x !== undefined) entry = result.commit.x;
  }
  return { chain, roster: rosters[rosters.length - 1], entry, rosters };
}

// -- frames ---------------------------------------------------------------------------------------

export interface CommunityMessageFrame { t: "group-msg"; v: 2; g: string; e: number; h: string; s: string; n: number; ts: number; nn: string; c: string; sig: string }
export interface CommunityCommitFrame { t: "group-commit"; v: 2; g: string; commit: CommunityCommit }
/** An epoch secret sealed to one member (`to`): relayed by hubs to whoever holds that member's edge. */
export interface CommunitySecretFrame { t: "group-secret"; v: 2; g: string; to: string; h: string; s: SealedSecret }
export interface CommunitySecretsFrame { t: "group-secrets"; v: 2; g: string; secrets: { h: string; s: SealedSecret }[] }
/** `loc`: hashes of my branch at 1, 2, 4, 8… commits back from my tip, so whoever is on another branch finds where we part. */
export interface CommunitySyncFrame { t: "group-sync"; v: 2; g: string; e: number; h: string; loc?: string[]; have: Record<string, Record<string, number>>; secrets: string[]; mt?: string }
export interface CommunityLeaveFrame { t: "group-leave"; v: 2; g: string; s: string; ls: string }
/** The seed of the link's current entry key, sealed to one member: after a `link` commit, or at a sync. */
export interface CommunityEntryFrame { t: "group-entry"; v: 2; g: string; to: string; x: string; s: SealedSecret }
export interface CommunityInviteFrame { t: "group-invite"; v: 2; g: string; name: string; admin: string; e: number; n: number }
export interface CommunityChainFrame { t: "group-chain"; v: 2; g: string; commits: CommunityCommit[] }
export interface CommunityWelcomeFrame {
  t: "group-welcome"; v: 2; g: string; name: string; commits: CommunityCommit[];
  secrets: { h: string; s: SealedSecret }[]; rv: SealedSecret; entry: SealedSecret;
}
export type CommunityFrame = CommunityMessageFrame | CommunityCommitFrame | CommunitySecretFrame | CommunitySecretsFrame | CommunitySyncFrame | CommunityLeaveFrame | CommunityEntryFrame | GroupMetaFrame;

export type CommunityStatus = "active" | "left" | "removed" | "forked" | "lost";

export interface CommunityState {
  id: string;
  name: string;
  profile: typeof COMMUNITY_PROFILE;
  seedB64: string;
  createdAt: number;
  /** The branch followed, from the genesis. */
  chain: CommunityCommit[];
  /** Commits known off it, within the window: losing branches, or a better one being assembled. */
  side: CommunityCommit[];
  /** Commit hash (full) → epoch secret (base64url). */
  secrets: Record<string, string>;
  /** The group's link: its entry key and seed (every member holds the seed); empty key when off. */
  entry: { key: string; seedB64: string };
  /** Rendezvous secret: the beacon and lobbies derive from it. */
  rv: string;
  status: CommunityStatus;
  statusReason?: string;
  /** My next sequence number under the commit `seqH` (full hash). */
  seq: number;
  seqH: string;
  /** Sender → `e:h16` → highest seen and the window below it. */
  seen: Record<string, Record<string, { high: number; window: number[] }>>;
  nicks: Record<string, string>;
  /** Recent frames from everyone (mine included), oldest first. */
  store: CommunityMessageFrame[];
  /** Leave requests waiting for a member to commit them. */
  pendingLeaves: { s: string; ls: string }[];
  /** The group's metadata (its picture), as the admin last signed it and I accepted it. */
  meta?: GroupMeta;
}

export interface CommunityIncomingMessage { id: string; sender: string; epoch: number; seq: number; timestamp: number; text: string }

export interface CommunitySessionHooks {
  save(state: CommunityState): Promise<void>;
  /** To everyone this member has an edge to (hubs relay it on). */
  broadcast(frame: CommunityFrame): void;
  /** To the member at the other end of an edge, if there is one. */
  direct(to: string, frame: CommunityFrame): void;
  /** To one member, wherever they are: over their edge if I have it, else to the hubs with `to`. */
  addressed(to: string, frame: CommunitySecretFrame | CommunityEntryFrame): void;
  message(message: CommunityIncomingMessage): Promise<void> | void;
  changed(): void;
  /** The group's picture changed (set, replaced or removed), by `by`. */
  metaChanged?(by: string, picture: string | undefined): void;
  /** A frame that waited here (a commit ahead of its parent) and is now placed: a hub passes it on. */
  relay?(frame: CommunityFrame): void;
  /** The engine's clock, for how often a member is asked for what I lack (defaults to Date.now). */
  clock?(): number;
}

const MAX_TEXT_BOX = Math.ceil((COMMUNITY_LIMITS.textBytes + 256 + 16) * 4 / 3) + 4;
const secretAad = (g: string, h: string, member: string) => JSON.stringify(["ghostly-group/2 secret", g, h, member]);
const rvAad = (g: string, member: string) => JSON.stringify(["ghostly-group/2 rendezvous", g, member]);
const entryAad = (g: string, member: string) => JSON.stringify(["ghostly-group/2 entry", g, member]);
const messageAad = (f: Pick<CommunityMessageFrame, "g" | "e" | "h" | "s" | "n" | "ts">) => JSON.stringify([f.g, f.e, f.h, f.s, f.n, f.ts]);
const messageSigned = (f: Omit<CommunityMessageFrame, "sig" | "t" | "v">) => utf8Encode(JSON.stringify(["ghostly-group/2 msg", f.g, f.e, f.h, f.s, f.n, f.ts, f.nn, f.c]));
export const communityMessageId = (sender: string, epoch: number, h: string, seq: number) => `${sender}:${epoch}:${h}:${seq}`;
const seenKey = (e: number, h: string) => `${e}:${h}`;

function isSealed(v: unknown): v is SealedSecret {
  return !!v && typeof v === "object" && ["e", "n", "c"].every(k => typeof (v as Record<string, unknown>)[k] === "string" && B64.test((v as Record<string, string>)[k]) && (v as Record<string, string>)[k].length <= 128);
}
function isMessageFrame(v: unknown): v is CommunityMessageFrame {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return f.t === "group-msg" && f.v === 2 && typeof f.g === "string" && GROUP_ID.test(f.g) && Number.isSafeInteger(f.e) && (f.e as number) >= 0 &&
    typeof f.h === "string" && /^[a-f0-9]{16}$/.test(f.h) && typeof f.s === "string" && MEMBER_KEY.test(f.s) && Number.isSafeInteger(f.n) && (f.n as number) >= 0 &&
    Number.isSafeInteger(f.ts) && (f.ts as number) > 0 && typeof f.nn === "string" && f.nn.length === 32 && B64.test(f.nn) &&
    typeof f.c === "string" && f.c.length <= MAX_TEXT_BOX && B64.test(f.c) && typeof f.sig === "string" && f.sig.length === 86 && B64.test(f.sig);
}

/**
 * One member's view of a community group: the branch it follows and the ones it knows, the
 * secrets it holds, what it has seen, and the recent frames it keeps for others.
 */
export class CommunitySession {
  readonly state: CommunityState;
  private readonly identity;
  /** Commit hash → commit, for everything known (main and side). */
  private known = new Map<string, CommunityCommit>();
  /** Commit hash → roster after it, for the window of the main branch and the side commits. */
  private rosters = new Map<string, Roster>();
  private mainIndex = new Map<string, number>();
  private pendingCommits = new Map<string, { from: string; commit: unknown }>();
  private pendingSecrets = new Map<string, SealedSecret>();
  private waiting: { from: string; frame: CommunityMessageFrame }[] = [];
  private waitingBytes = 0;
  private asked = new Map<string, number>();
  private queue = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** One metadata frame naming a commit or a secret I do not have yet: tried again when the chain or my secrets move. */
  private pendingMeta: { from: string; frame: unknown } | undefined;

  constructor(state: CommunityState, private readonly hooks: CommunitySessionHooks) {
    this.state = state;
    this.identity = identityFromSeedB64(state.seedB64);
    this.rebuild();
  }

  // -- creation and joining ----------------------------------------------------------------------

  static create(name: string, now = Date.now()): CommunityState {
    const me = identityFromSeedB64(toBase64Url(randomBytes(32)));
    const entry = identityFromSeedB64(toBase64Url(randomBytes(32)));
    const n = toBase64Url(randomBytes(16));
    const g = communityGroupId(me.pubKeyZ32, n);
    const secret = newEpochSecret();
    const roster: Roster = [[me.pubKeyZ32, "admin"]];
    const draft: Omit<CommunityCommit, "sig" | "c"> = { v: 2, g, e: 0, p: "", k: "create", m: rosterHash(roster), by: me.pubKeyZ32, x: entry.pubKeyZ32, n, ts: now };
    const commit = signCommunity({ ...draft, c: confirmationTag(epochKeys(secret, g, 0).confirm, communityUntaggedHash(draft)) }, me.seed);
    const h = communityCommitHash(commit);
    return { id: g, name: sanitizeNick(name) ?? "Group", profile: COMMUNITY_PROFILE, seedB64: me.seedB64, createdAt: now, chain: [commit], side: [],
      secrets: { [h]: toBase64Url(secret) }, entry: { key: entry.pubKeyZ32, seedB64: entry.seedB64 }, rv: toBase64Url(randomBytes(32)),
      status: "active", seq: 0, seqH: h, seen: {}, nicks: {}, store: [], pendingLeaves: [] };
  }

  /**
   * Joining from a welcome over the link's entry session: the whole chain verifies from its
   * genesis (which produces the group id), the link's entry key is the chain's current one, the
   * chain admits me in an `add` (signed by a member, as the chain rules require), and the secrets,
   * rendezvous secret and entry seed open and confirm. Who sent the welcome does not matter: the
   * entry session is pinned to the link's entry key, which only members hold, and a welcome whose
   * add was made by another member (the first one to answer me went away) is as good.
   */
  static join(link: { g: string; host: string }, pieces: unknown[], welcome: unknown, seedB64: string, now = Date.now()): { state: CommunityState } | { error: string } {
    if (!welcome || typeof welcome !== "object") return { error: "Malformed welcome" };
    const w = welcome as Record<string, unknown>;
    if (w.t !== "group-welcome" || w.v !== 2 || w.g !== link.g || !Array.isArray(w.commits) || !Array.isArray(w.secrets) || !isSealed(w.rv) || !isSealed(w.entry)) return { error: "Malformed welcome" };
    const commits = [...pieces.flatMap(p => (p && typeof p === "object" && Array.isArray((p as CommunityChainFrame).commits)) ? (p as CommunityChainFrame).commits : []), ...w.commits];
    if (commits.length > COMMUNITY_LIMITS.chain) return { error: "Membership chain too long" };
    const verified = verifyCommunityChain(commits, link.g);
    if ("error" in verified) return verified;
    const { chain, roster, entry } = verified;
    const me = identityFromSeedB64(seedB64);
    if (!rosterHas(roster, me.pubKeyZ32)) return { error: "The welcome does not admit this member key" };
    if (entry !== link.host) return { error: "This link was replaced or turned off" };
    let admitted = -1;
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].k === "add" && chain[i].s === me.pubKeyZ32) { admitted = i; break; }
    if (admitted < 0) return { error: "The welcome does not admit this member key" };
    const secrets: Record<string, string> = {};
    const byHash = new Map(chain.map((c, i) => [communityCommitHash(c), i]));
    for (const entryRaw of w.secrets as unknown[]) {
      const { h, s } = (entryRaw ?? {}) as { h?: unknown; s?: unknown };
      if (typeof h !== "string" || !isSealed(s)) continue;
      const i = byHash.get(h);
      if (i === undefined || i < admitted) continue;
      const secret = openSecret(me.seed, me.pubKeyZ32, s, secretAad(link.g, h, me.pubKeyZ32));
      if (secret && confirmationMatches(epochKeys(secret, link.g, chain[i].e).confirm, communityUntaggedHash(chain[i]), chain[i].c)) secrets[h] = toBase64Url(secret);
    }
    // Later derived epochs follow from the admitting one.
    for (let i = admitted + 1; i < chain.length; i++) {
      const h = communityCommitHash(chain[i]), before = secrets[communityCommitHash(chain[i - 1])];
      if (!secrets[h] && before && !FRESH.has(chain[i].k)) secrets[h] = toBase64Url(derivedSecret(fromBase64Url(before), communityUntaggedHash(chain[i])));
    }
    const top = communityCommitHash(chain[chain.length - 1]);
    if (!secrets[top]) return { error: "The welcome carries no usable secret for the current epoch" };
    const rv = openSecret(me.seed, me.pubKeyZ32, w.rv as SealedSecret, rvAad(link.g, me.pubKeyZ32));
    const entrySeed = openSecret(me.seed, me.pubKeyZ32, w.entry as SealedSecret, entryAad(link.g, me.pubKeyZ32));
    if (!rv || !entrySeed || identityFromSeedB64(toBase64Url(entrySeed)).pubKeyZ32 !== entry) return { error: "The welcome's keys do not open" };
    return { state: { id: link.g, name: sanitizeNick(typeof w.name === "string" ? w.name : "") ?? "Group", profile: COMMUNITY_PROFILE, seedB64, createdAt: now,
      chain, side: [], secrets, entry: { key: entry, seedB64: toBase64Url(entrySeed) }, rv: toBase64Url(rv), status: "active", seq: 0, seqH: top,
      seen: {}, nicks: {}, store: [], pendingLeaves: [] } };
  }

  // -- views ---------------------------------------------------------------------------------------

  get id(): string { return this.state.id; }
  get name(): string { return this.state.name; }
  get myKey(): string { return this.identity.pubKeyZ32; }
  get top(): CommunityCommit { return this.state.chain[this.state.chain.length - 1]; }
  get topHash(): string { return communityCommitHash(this.top); }
  get epoch(): number { return this.top.e; }
  get roster(): Roster { return this.rosters.get(this.topHash)!; }
  get admin(): string | undefined { return rosterAdmin(this.roster); }
  get isAdmin(): boolean { return this.admin === this.myKey && this.state.status === "active"; }
  get status(): CommunityStatus { return this.state.status; }
  get others(): string[] { return this.roster.map(([k]) => k).filter(k => k !== this.myKey); }
  get isMember(): boolean { return this.state.status === "active" && rosterHas(this.roster, this.myKey); }
  get canSend(): boolean { return this.isMember && !!this.state.secrets[this.topHash]; }
  /** The entry key of the group's link, or "" when it is off. */
  get entryKey(): string { return this.state.entry.key; }
  role(key: string): GroupRole | undefined { return this.roster.find(([k]) => k === key)?.[1]; }
  /** The group's picture, if it has one. */
  get picture(): string | undefined { return groupMetaPicture(this.state.meta); }
  /** Members of any epoch in the window: whom a frame may come from. */
  isRecentMember(key: string): boolean {
    for (const roster of this.rosters.values()) if (rosterHas(roster, key)) return true;
    return false;
  }
  /** Someone the chain took out (removed or left) and who is not back in. */
  wasRemoved(key: string): boolean {
    if (rosterHas(this.roster, key)) return false;
    for (let i = this.state.chain.length - 1; i >= 0; i--) { const c = this.state.chain[i]; if ((c.k === "remove" || c.k === "leave") && c.s === key) return true; }
    return false;
  }
  missing(sender: string): number {
    const entry = this.state.seen[sender]?.[seenKey(this.epoch, shortHash(this.topHash))];
    if (!entry) return 0;
    const lowest = Math.max(0, entry.high - COMMUNITY_LIMITS.replay + 1);
    return Math.max(0, entry.high - lowest + 1 - (1 + entry.window.filter(n => n >= lowest).length));
  }

  // -- the tree of commits -------------------------------------------------------------------------

  /** Replays the main branch (rosters kept for its window) and places the side commits. */
  private rebuild(): void {
    this.known.clear(); this.rosters.clear(); this.mainIndex.clear();
    let roster: Roster | null = null;
    const keepFrom = Math.max(0, this.state.chain.length - 1 - COMMUNITY_LIMITS.window);
    this.state.chain.forEach((commit, i) => {
      roster = communityRoster(roster, commit);
      if (!roster) throw new Error("Stored membership chain does not replay");
      const h = communityCommitHash(commit);
      this.known.set(h, commit); this.mainIndex.set(h, i);
      if (i >= keepFrom) this.rosters.set(h, roster);
    });
    for (const commit of this.state.side) this.placeSide(commit);
  }

  private placeSide(commit: CommunityCommit): boolean {
    const parent = this.known.get(commit.p), parentRoster = parent ? this.rosterAt(commit.p) : undefined;
    if (!parentRoster || !parent) return false;
    const result = verifyCommunityCommit(commit, parent, parentRoster, this.id);
    if ("error" in result) return false;
    const h = communityCommitHash(result.commit);
    this.known.set(h, result.commit); this.rosters.set(h, result.roster);
    return true;
  }

  private rosterOf(h: string): Roster | undefined { return this.rosterAt(h); }
  /** The roster after a commit: cached for the window and the side, replayed for an older commit of the main branch. */
  private rosterAt(h: string): Roster | undefined {
    const cached = this.rosters.get(h);
    if (cached) return cached;
    const i = this.mainIndex.get(h);
    if (i === undefined) return undefined;
    let roster: Roster | null = null;
    for (let j = 0; j <= i; j++) roster = communityRoster(roster, this.state.chain[j]);
    if (roster) this.rosters.set(h, roster);
    return roster ?? undefined;
  }
  commitByShort(e: number, h16: string): { commit: CommunityCommit; hash: string } | undefined {
    const i = this.state.chain.length - 1 - (this.epoch - e);
    const candidates = [...(i >= 0 && i < this.state.chain.length ? [this.state.chain[i]] : []), ...this.state.side.filter(c => c.e === e)];
    for (const commit of candidates) {
      const hash = communityCommitHash(commit);
      if (hash.startsWith(h16) && this.rosters.has(hash)) return { commit, hash };
    }
    return undefined;
  }

  /** The commits from `hash` back to the main branch (exclusive), oldest first; null when it does not reach it. */
  private pathToMain(hash: string): string[] | null {
    const path: string[] = [];
    let h = hash;
    while (!this.mainIndex.has(h)) {
      const c = this.known.get(h);
      if (!c) return null;
      path.unshift(h);
      h = c.p;
    }
    return path;
  }

  /** Is branch tip `a` better than tip `b`? Longer first; then the lower hash of the first commit after their common parent. */
  private better(a: string, b: string): boolean {
    const ca = this.known.get(a)!, cb = this.known.get(b)!;
    if (ca.e !== cb.e) return ca.e > cb.e;
    if (a === b) return false;
    const chain = (h: string) => { const out: string[] = []; let x: string | undefined = h; while (x) { out.unshift(x); x = this.known.get(x)?.p || undefined; } return out; };
    const pa = chain(a), pb = chain(b);
    let i = 0;
    while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
    return (pa[i] ?? "") < (pb[i] ?? "");
  }

  /**
   * Takes in a commit (from a frame or from me): placed in the tree if it verifies against its
   * parent, a fork if the admin signed another commit after the same parent, and then the best
   * branch is followed. Returns whether it was new.
   */
  private async receiveCommit(from: string, raw: unknown): Promise<boolean> {
    if (!raw || typeof raw !== "object") return false;
    const p = (raw as { p?: unknown }).p, e = (raw as { e?: unknown }).e;
    if (typeof p !== "string" || !Number.isSafeInteger(e)) return false;
    const parent = this.known.get(p), parentRoster = parent ? this.rosterAt(p) : undefined;
    if (!parent || !parentRoster) {
      // Its parent is not here yet: kept, within bounds, while I ask for what comes before.
      if (this.pendingCommits.size < COMMUNITY_LIMITS.pendingCommits) {
        this.pendingCommits.set(p + ":" + String(e), { from, commit: raw });
        this.ask(from);
      }
      return false;
    }
    const result = verifyCommunityCommit(raw, parent, parentRoster, this.id);
    if ("error" in result) return false;
    const commit = result.commit, h = communityCommitHash(commit);
    if (this.known.has(h)) return false;
    // Two commits by the admin after the same commit: equivocation.
    const admin = rosterAdmin(parentRoster);
    if (commit.by === admin) {
      for (const [other, c] of this.known) if (other !== h && c.p === commit.p && c.by === admin) {
        this.known.set(h, commit); this.rosters.set(h, result.roster);
        await this.fork(`The admin signed two different changes after epoch ${parent.e}`);
        return true;
      }
    }
    this.known.set(h, commit); this.rosters.set(h, result.roster);
    if (!this.mainIndex.has(h)) this.state.side.push(commit);
    this.takeDerived(h);
    const sealed = this.pendingSecrets.get(h);
    if (sealed) { this.pendingSecrets.delete(h); this.takeSecret(h, sealed); }
    await this.chooseBranch();
    // Anything that was waiting for this one; hubs relay those too.
    for (const [key, pending] of [...this.pendingCommits]) if (key.startsWith(h + ":")) {
      this.pendingCommits.delete(key);
      if (await this.receiveCommit(pending.from, pending.commit)) this.hooks.relay?.({ t: "group-commit", v: 2, g: this.id, commit: pending.commit as CommunityCommit });
    }
    return true;
  }

  /**
   * Follows the best branch among the known tips; reorganizes the main branch when it changed. A
   * longer branch wins however far back it parts (a member away through a race must end up where
   * everyone is); a branch of the same length only within the window.
   */
  private async chooseBranch(): Promise<void> {
    let best = this.topHash;
    const floor = this.epoch - COMMUNITY_LIMITS.window;
    for (const c of this.state.side) {
      const h = communityCommitHash(c);
      if (this.mainIndex.has(h) || c.e < this.epoch) continue;
      const path = this.pathToMain(h);
      if (!path) continue;
      if (c.e === this.epoch && this.known.get(this.known.get(path[0])!.p)!.e < floor) continue;
      if (this.better(h, best)) best = h;
    }
    if (best !== this.topHash) await this.adopt(best);
    if (this.state.status === "lost" && rosterHas(this.roster, this.myKey)) { this.state.status = "active"; delete this.state.statusReason; }
    this.followEntry();
    this.pruneSide();
    await this.persist();
    this.hooks.changed();
    await this.replayWaiting();
  }

  private async adopt(tip: string): Promise<void> {
    const path = this.pathToMain(tip)!;
    const ancestor = this.mainIndex.get(this.known.get(path[0])!.p)!;
    const dropped = this.state.chain.splice(ancestor + 1);
    for (const c of dropped) { const h = communityCommitHash(c); this.mainIndex.delete(h); this.state.side.push(c); }
    for (const h of path) {
      const c = this.known.get(h)!;
      this.state.side = this.state.side.filter(x => communityCommitHash(x) !== h);
      this.mainIndex.set(h, this.state.chain.length);
      this.state.chain.push(c);
      this.takeDerived(h);
    }
    const lostMine = !rosterHas(this.roster, this.myKey);
    if (lostMine && this.state.status === "active") {
      const out = [...path].reverse().map(h => this.known.get(h)!).find(c => (c.k === "remove" || c.k === "leave") && c.s === this.myKey);
      if (out) this.out(out.k === "remove" ? "removed" : "left", out.k === "remove" ? "You were removed from this group" : "You left this group");
      else { this.state.status = "lost"; this.state.statusReason = "Two members let people in at the same moment and yours did not count. Asking to be let in again…"; }
    }
  }

  /** The entry key is the one the main branch names; its seed comes with a `group-entry` from whoever holds it. */
  private followEntry(): void {
    const key = this.currentEntryKey();
    if (key !== this.state.entry.key) this.state.entry = { key, seedB64: "" };
  }

  /** Side commits stay up to a bound, the most recent ones (a longer branch being assembled included). */
  private pruneSide(): void {
    this.state.side = this.state.side.slice(-COMMUNITY_LIMITS.side);
    const keep = new Set(this.state.side.map(c => communityCommitHash(c)));
    for (const [h, c] of [...this.known]) {
      if (this.mainIndex.has(h)) { if (this.mainIndex.get(h)! < this.state.chain.length - 1 - COMMUNITY_LIMITS.window) this.rosters.delete(h); continue; }
      if (!keep.has(h)) { this.known.delete(h); this.rosters.delete(h); void c; }
    }
    this.pruneSecrets();
  }

  private pruneSecrets(): void {
    const order = [...this.state.chain.slice(-COMMUNITY_LIMITS.window - 1), ...this.state.side].map(c => communityCommitHash(c));
    const keep = new Set(order.slice(-COMMUNITY_LIMITS.secrets));
    for (const h of Object.keys(this.state.secrets)) if (!keep.has(h)) delete this.state.secrets[h];
  }

  /** A derived epoch's secret, from its parent's, when that is held. */
  private takeDerived(h: string): void {
    const c = this.known.get(h);
    if (!c || this.state.secrets[h] || FRESH.has(c.k)) return;
    const parent = this.state.secrets[c.p];
    if (!parent || !rosterHas(this.rosterAt(h) ?? [], this.myKey)) return;
    const secret = derivedSecret(fromBase64Url(parent), communityUntaggedHash(c));
    if (confirmationMatches(epochKeys(secret, this.id, c.e).confirm, communityUntaggedHash(c), c.c)) {
      this.state.secrets[h] = toBase64Url(secret);
      // …and the derived ones after it, on any branch.
      for (const [child, cc] of this.known) if (cc.p === h) this.takeDerived(child);
    }
  }

  /** A sealed secret for a known commit I am in the roster of: kept only when it confirms. */
  private takeSecret(h: string, sealed: unknown): boolean {
    const c = this.known.get(h);
    if (!c) { if (isSealed(sealed) && this.pendingSecrets.size < 32) this.pendingSecrets.set(h, sealed); return false; }
    if (this.state.secrets[h] || !isSealed(sealed) || !rosterHas(this.rosterAt(h) ?? [], this.myKey)) return false;
    const secret = openSecret(this.identity.seed, this.myKey, sealed, secretAad(this.id, h, this.myKey));
    if (!secret || !confirmationMatches(epochKeys(secret, this.id, c.e).confirm, communityUntaggedHash(c), c.c)) return false;
    this.state.secrets[h] = toBase64Url(secret);
    for (const [child, cc] of this.known) if (cc.p === h) this.takeDerived(child);
    return true;
  }

  // -- what a member does --------------------------------------------------------------------------

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(run);
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
  private persist(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    return this.hooks.save(structuredClone(this.state));
  }
  /**
   * A save within a second, for what may happen many times a second (every message received, in a
   * group of hundreds): the state holds the chain and the store, and is not worth writing each time.
   */
  private persistSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.hooks.save(structuredClone(this.state)); }, 1000);
  }
  /** Writes what is waiting to be saved now (before a restart, in tests). */
  async flush(): Promise<void> { if (this.saveTimer) await this.persist(); }
  private requireMember(): void { if (!this.isMember) throw new Error(this.state.statusReason ?? "You are not in this group"); }
  private requireAdmin(): void { this.requireMember(); if (!this.isAdmin) throw new Error("Only the admin can do that"); }

  private async commit(kind: CommunityKind, fields: { s?: string; x?: string; ls?: string }, now: number): Promise<{ commit: CommunityCommit; hash: string; secret: Uint8Array }> {
    if (this.state.chain.length >= COMMUNITY_LIMITS.chain) throw new Error("This group has reached its membership history limit. Create a new group.");
    const parent = this.top, parentHash = this.topHash;
    const draftBase = { v: 2 as const, g: this.id, e: parent.e + 1, p: parentHash, k: kind, by: this.myKey, ...fields, ts: now };
    const roster = communityRoster(this.roster, draftBase);
    if (!roster) throw new Error("This change is not allowed");
    const draft: Omit<CommunityCommit, "sig" | "c"> = { ...draftBase, m: rosterHash(roster) };
    const untagged = communityUntaggedHash(draft);
    let secret: Uint8Array;
    if (FRESH.has(kind)) secret = newEpochSecret();
    else {
      const previous = this.state.secrets[parentHash];
      if (!previous) throw new Error("This epoch's key has not arrived yet. Wait for a member to catch you up.");
      secret = derivedSecret(fromBase64Url(previous), untagged);
    }
    const commit = signCommunity({ ...draft, c: confirmationTag(epochKeys(secret, this.id, draft.e).confirm, untagged) }, this.identity.seed);
    const hash = communityCommitHash(commit);
    this.known.set(hash, commit); this.rosters.set(hash, roster);
    this.mainIndex.set(hash, this.state.chain.length);
    this.state.chain.push(commit);
    this.state.secrets[hash] = toBase64Url(secret);
    this.state.seq = 0; this.state.seqH = hash;
    this.pruneSide();
    await this.persist();
    this.hooks.broadcast({ t: "group-commit", v: 2, g: this.id, commit });
    if (FRESH.has(kind)) for (const [key] of roster) if (key !== this.myKey) this.hooks.addressed(key, { t: "group-secret", v: 2, g: this.id, to: key, h: hash, s: sealSecret(key, secret, secretAad(this.id, hash, key)) });
    this.hooks.changed();
    return { commit, hash, secret };
  }

  /** What an entry session sends a joiner first. */
  inviteFrame(): CommunityInviteFrame {
    this.requireMember();
    return { t: "group-invite", v: 2, g: this.id, name: this.name, admin: this.myKey, e: this.epoch, n: this.roster.length };
  }

  /** Admits a joiner who knocked with the link: an `add`, then the welcome for them (in pieces). */
  admit(memberKey: string, now = Date.now()): Promise<(CommunityChainFrame | CommunityWelcomeFrame)[]> {
    return this.serialize(async () => {
      this.requireMember();
      if (!MEMBER_KEY.test(memberKey) || memberKey === this.myKey) throw new Error("Invalid member key");
      if (rosterHas(this.roster, memberKey)) throw new Error("Already a member");
      if (this.roster.length >= COMMUNITY_LIMITS.members) throw new Error(`The group is full (${COMMUNITY_LIMITS.members} members)`);
      const { hash } = await this.commit("add", { s: memberKey }, now);
      return this.welcomeFor(memberKey, hash);
    });
  }

  /**
   * A welcome for someone already in the roster who knocks again: their admission reached the
   * roster but its welcome never reached them. Nothing is committed; what they get is sealed to their key.
   */
  rewelcome(memberKey: string): Promise<(CommunityChainFrame | CommunityWelcomeFrame)[]> {
    return this.serialize(async () => {
      this.requireMember();
      if (!rosterHas(this.roster, memberKey) || memberKey === this.myKey) throw new Error("Not a member");
      for (let i = this.state.chain.length - 1; i >= 0; i--) {
        const c = this.state.chain[i];
        if (c.k === "add" && c.s === memberKey) return this.welcomeFor(memberKey, communityCommitHash(c));
      }
      throw new Error("Not a member");
    });
  }

  /** The chain, the secrets from the admitting commit on, the rendezvous secret and the entry seed, for one newcomer. */
  private welcomeFor(memberKey: string, admittedAt: string): (CommunityChainFrame | CommunityWelcomeFrame)[] {
    const chain = this.state.chain, from = this.mainIndex.get(admittedAt)!;
    const secrets = chain.slice(from).map(c => communityCommitHash(c)).filter(h => this.state.secrets[h])
      .map(h => ({ h, s: sealSecret(memberKey, fromBase64Url(this.state.secrets[h]), secretAad(this.id, h, memberKey)) }));
    const piece = COMMUNITY_LIMITS.chainPiece, frames: (CommunityChainFrame | CommunityWelcomeFrame)[] = [];
    for (let i = 0; i < chain.length - piece; i += piece) frames.push({ t: "group-chain", v: 2, g: this.id, commits: chain.slice(i, i + piece) });
    const tail = chain.length % piece || piece;
    frames.push({ t: "group-welcome", v: 2, g: this.id, name: this.name, commits: chain.slice(chain.length - tail), secrets,
      rv: sealSecret(memberKey, fromBase64Url(this.state.rv), rvAad(this.id, memberKey)),
      entry: sealSecret(memberKey, fromBase64Url(this.state.entry.seedB64), entryAad(this.id, memberKey)) });
    return frames;
  }

  remove(memberKey: string, now = Date.now()): Promise<void> {
    return this.serialize(async () => {
      this.requireAdmin();
      if (!rosterHas(this.roster, memberKey) || memberKey === this.myKey) throw new Error("Not a member");
      await this.commit("remove", { s: memberKey }, now);
    });
  }
  transferAdmin(memberKey: string, now = Date.now()): Promise<void> {
    return this.serialize(async () => {
      this.requireAdmin();
      if (!rosterHas(this.roster, memberKey) || memberKey === this.myKey) throw new Error("Not a member");
      await this.commit("role", { s: memberKey }, now);
    });
  }
  rotate(now = Date.now()): Promise<void> { return this.serialize(async () => { this.requireAdmin(); await this.commit("rotate", {}, now); }); }

  /** A new entry key (the old link reaches nobody), or none (`off`): a `link` commit every member follows. */
  replaceLink(off = false, now = Date.now()): Promise<string> {
    return this.serialize(async () => {
      this.requireAdmin();
      const entry = off ? null : identityFromSeedB64(toBase64Url(randomBytes(32)));
      await this.commit("link", { x: entry?.pubKeyZ32 ?? "" }, now);
      this.state.entry = { key: entry?.pubKeyZ32 ?? "", seedB64: entry?.seedB64 ?? "" };
      await this.persist();
      // Every member can answer the new link: its seed, sealed to each.
      if (entry) for (const key of this.others) this.hooks.addressed(key, this.entryFrame(key)!);
      this.hooks.changed();
      return this.state.entry.key;
    });
  }

  /**
   * Leaves: a signed request any other member commits, and my secrets go now. The admin must
   * hand over the role first (the engine does it for a leaving admin).
   */
  leave(): Promise<CommunityLeaveFrame | null> {
    return this.serialize(async () => {
      if (this.state.status !== "active") return null;
      if (this.isAdmin && this.others.length) throw new Error("Make someone else the admin before leaving");
      const frame: CommunityLeaveFrame = { t: "group-leave", v: 2, g: this.id, s: this.myKey, ls: toBase64Url(sign(leaveStatement(this.id, this.myKey), this.identity.seed)) };
      this.hooks.broadcast(frame);
      this.out("left", "You left this group");
      await this.persist();
      this.hooks.changed();
      return frame;
    });
  }

  /** Commits the leave requests I hold whose members are still in: the engine calls this on hubs. */
  commitPendingLeaves(now = Date.now()): Promise<number> {
    return this.serialize(async () => {
      if (!this.isMember) return 0;
      let done = 0;
      for (const request of [...this.state.pendingLeaves]) {
        if (!rosterHas(this.roster, request.s) || request.s === this.myKey || request.s === this.admin) { this.state.pendingLeaves = this.state.pendingLeaves.filter(r => r !== request); continue; }
        try { await this.commit("leave", { s: request.s, ls: request.ls }, now); done++; } catch { /* not allowed right now */ }
        this.state.pendingLeaves = this.state.pendingLeaves.filter(r => r !== request);
      }
      if (done) await this.persist();
      return done;
    });
  }

  private out(status: CommunityStatus, reason: string): void {
    this.state.status = status;
    this.state.statusReason = reason;
    this.state.secrets = {};
    this.state.store = [];
    this.state.entry = { key: this.state.entry.key, seedB64: "" };
    this.waiting = []; this.waitingBytes = 0; this.pendingCommits.clear(); this.pendingSecrets.clear();
  }

  sendText(text: string, nick?: string, now = Date.now()): Promise<{ id: string } | { error: string }> {
    return this.serialize(async () => {
      if (!this.isMember) return { error: this.state.statusReason ?? "You are not in this group" };
      const trimmed = text.trim();
      if (!trimmed) return { error: "Nothing to send" };
      if (utf8Encode(trimmed).length > COMMUNITY_LIMITS.textBytes) return { error: "Message exceeds 16 KiB" };
      const h = this.topHash, secret = this.state.secrets[h];
      if (!secret) return { error: "This epoch's key has not arrived yet. Wait for a member to catch you up." };
      if (this.state.seqH !== h) { this.state.seq = 0; this.state.seqH = h; }
      const n = this.state.seq++;
      const header = { g: this.id, e: this.epoch, h: shortHash(h), s: this.myKey, n, ts: now };
      const clean = sanitizeNick(nick);
      const payload = JSON.stringify(clean ? { text: trimmed, nick: clean } : { text: trimmed });
      const { n: nn, c } = encryptText(epochKeys(fromBase64Url(secret), this.id, this.epoch).message, messageAad(header), payload);
      const unsigned = { ...header, nn, c };
      const frame: CommunityMessageFrame = { t: "group-msg", v: 2, ...unsigned, sig: toBase64Url(sign(messageSigned(unsigned), this.identity.seed)) };
      this.markSeen(frame);
      this.keep(frame);
      const id = communityMessageId(this.myKey, header.e, header.h, n);
      await this.hooks.message({ id, sender: this.myKey, epoch: header.e, seq: n, timestamp: now, text: trimmed });
      await this.persist();
      this.hooks.broadcast(frame);
      return { id };
    });
  }

  private keep(frame: CommunityMessageFrame): void {
    this.state.store.push(frame);
    let bytes = this.state.store.reduce((sum, f) => sum + f.c.length, 0);
    while (this.state.store.length > COMMUNITY_LIMITS.store || bytes > COMMUNITY_LIMITS.storeBytes) bytes -= this.state.store.shift()!.c.length;
  }

  /** Where I am and what I have, for the member at the other end of an edge that just opened. */
  syncFrame(): CommunitySyncFrame {
    const have: Record<string, Record<string, number>> = {};
    const recent = new Set(this.state.store.map(f => seenKey(f.e, f.h)));
    for (const [sender, byKey] of Object.entries(this.state.seen)) for (const [key, entry] of Object.entries(byKey)) {
      if (!recent.has(key)) continue;
      (have[sender] ??= {})[key] = entry.high;
    }
    const secrets = this.state.chain.slice(-COMMUNITY_LIMITS.window - 1).map(c => communityCommitHash(c)).filter(h => this.state.secrets[h]).map(shortHash);
    const loc: string[] = [];
    for (let back = 1; back < this.state.chain.length && loc.length < 12; back *= 2) loc.push(communityCommitHash(this.state.chain[this.state.chain.length - 1 - back]));
    return { t: "group-sync", v: 2, g: this.id, e: this.epoch, h: this.topHash, loc, have, secrets, mt: groupMetaTag(this.state.meta) };
  }

  // -- frames from others --------------------------------------------------------------------------

  /**
   * A frame from the edge of member `from` (the author, or a hub relaying it). Returns whether it
   * was new and valid, so a hub knows to relay it on.
   */
  handle(from: string, raw: unknown): Promise<boolean> {
    return this.serialize(async () => {
      if (!raw || typeof raw !== "object") return false;
      const frame = raw as Record<string, unknown>;
      if (frame.g !== this.id || frame.v !== 2) return false;
      // A member who lost its admission still hears commits: the next one may take it in.
      if (this.state.status !== "active" && !(this.state.status === "lost" && (frame.t === "group-commit" || frame.t === "group-secret" || frame.t === "group-secrets"))) return false;
      switch (frame.t) {
        case "group-msg": return this.receiveMessage(from, raw);
        case "group-commit": return this.receiveCommit(from, frame.commit);
        case "group-secret": {
          if (frame.to !== this.myKey || typeof frame.h !== "string") return false;
          const took = this.takeSecret(frame.h, frame.s);
          if (took) { await this.persist(); this.hooks.changed(); await this.replayWaiting(); }
          return took;
        }
        case "group-secrets": {
          if (!Array.isArray(frame.secrets) || frame.secrets.length > COMMUNITY_LIMITS.secrets) return false;
          let took = false;
          for (const entry of frame.secrets as { h?: unknown; s?: unknown }[]) if (entry && typeof entry.h === "string") took = this.takeSecret(entry.h, entry.s) || took;
          if (took) { await this.persist(); this.hooks.changed(); await this.replayWaiting(); }
          return false;
        }
        case "group-sync": await this.receiveSync(from, frame as unknown as CommunitySyncFrame); return false;
        case "group-meta": return this.receiveMeta(from, raw);
        case "group-leave": return this.receiveLeave(frame);
        case "group-entry": {
          if (frame.to !== this.myKey || !isSealed(frame.s) || frame.x !== this.currentEntryKey()) return false;
          const seed = openSecret(this.identity.seed, this.myKey, frame.s, entryAad(this.id, this.myKey));
          return !!seed && this.takeEntrySeed(toBase64Url(seed));
        }
        default: return false;
      }
    });
  }

  private receiveLeave(frame: Record<string, unknown>): boolean {
    const s = frame.s, ls = frame.ls;
    if (typeof s !== "string" || !MEMBER_KEY.test(s) || typeof ls !== "string" || !SIG.test(ls) || !rosterHas(this.roster, s)) return false;
    if (this.state.pendingLeaves.some(r => r.s === s)) return false;
    if (!verify(fromBase64Url(ls), leaveStatement(this.id, s), publicKeyFromZ32(s))) return false;
    this.state.pendingLeaves = [...this.state.pendingLeaves, { s, ls }].slice(-COMMUNITY_LIMITS.pendingLeaves);
    this.persistSoon();
    return true;
  }

  private async receiveMessage(from: string, raw: unknown): Promise<boolean> {
    if (!isMessageFrame(raw) || raw.s === this.myKey) return false;
    const found = this.commitByShort(raw.e, raw.h);
    if (!found) { this.park(from, raw); return false; }
    const roster = this.rosterOf(found.hash)!;
    // Not a member of that epoch, or I was not one: nothing to read, nothing to relay.
    if (!rosterHas(roster, raw.s) || !rosterHas(roster, this.myKey)) return false;
    if (this.isDuplicate(raw)) return false;
    if (!verify(fromBase64Url(raw.sig), messageSigned(raw), publicKeyFromZ32(raw.s))) return false;
    const secret = this.state.secrets[found.hash];
    if (!secret) { this.park(from, raw); return true; }
    const payload = decryptText(epochKeys(fromBase64Url(secret), this.id, raw.e).message, messageAad(raw), raw.nn, raw.c);
    if (payload === null) return false;
    let text: string, nick: string | undefined;
    try {
      const parsed = JSON.parse(payload) as { text?: unknown; nick?: unknown };
      if (typeof parsed.text !== "string") return false;
      text = parsed.text.slice(0, COMMUNITY_LIMITS.textBytes);
      nick = typeof parsed.nick === "string" ? sanitizeNick(parsed.nick) : undefined;
    } catch { return false; }
    if (nick && this.state.nicks[raw.s] !== nick) { this.state.nicks[raw.s] = nick; this.hooks.changed(); }
    await this.hooks.message({ id: communityMessageId(raw.s, raw.e, raw.h, raw.n), sender: raw.s, epoch: raw.e, seq: raw.n, timestamp: raw.ts, text });
    this.markSeen(raw);
    this.keep(raw);
    // The message itself is stored already; what changed here (seen, store) is saved in a batch.
    this.persistSoon();
    return true;
  }

  private isDuplicate(f: CommunityMessageFrame): boolean {
    const entry = this.state.seen[f.s]?.[seenKey(f.e, f.h)];
    if (!entry || f.n > entry.high) return false;
    if (f.n <= entry.high - COMMUNITY_LIMITS.replay) return true;
    return f.n === entry.high || entry.window.includes(f.n);
  }
  private markSeen(f: CommunityMessageFrame): void {
    const bySender = (this.state.seen[f.s] ??= {});
    const entry = (bySender[seenKey(f.e, f.h)] ??= { high: -1, window: [] });
    if (f.n > entry.high) { if (entry.high >= 0) entry.window.push(entry.high); entry.high = f.n; }
    else entry.window.push(f.n);
    entry.window = entry.window.filter(n => n > entry.high - COMMUNITY_LIMITS.replay);
    for (const key of Object.keys(bySender)) if (Number(key.split(":")[0]) < this.epoch - COMMUNITY_LIMITS.window) delete bySender[key];
    if (!Object.keys(bySender).length) delete this.state.seen[f.s];
  }

  private park(from: string, frame: CommunityMessageFrame): void {
    if (frame.e > this.epoch + COMMUNITY_LIMITS.window) return;
    if (this.waiting.some(w => w.frame.s === frame.s && w.frame.e === frame.e && w.frame.h === frame.h && w.frame.n === frame.n)) return;
    this.waiting.push({ from, frame });
    this.waitingBytes += frame.c.length;
    while (this.waiting.length > COMMUNITY_LIMITS.waiting || this.waitingBytes > COMMUNITY_LIMITS.waitingBytes) this.waitingBytes -= this.waiting.shift()!.frame.c.length;
    this.ask(from);
  }

  /** Something is missing here: the current epoch's secret, or the epoch of frames waiting. */
  get needsCatchUp(): boolean { return this.isMember && (!this.state.secrets[this.topHash] || this.waiting.length > 0 || this.pendingCommits.size > 0); }
  /** Asks a member I have an edge to for what I lack (the engine calls it now and then while `needsCatchUp`). */
  catchUp(to: string): void { this.ask(to); }

  private ask(from: string): void {
    const now = this.hooks.clock?.() ?? Date.now();
    if (now - (this.asked.get(from) ?? 0) < 5_000) return;
    this.asked.set(from, now);
    this.hooks.direct(from, this.syncFrame());
  }

  private async replayWaiting(): Promise<void> {
    await this.metaFollowsChain();
    const ready = this.waiting.filter(w => { const found = this.commitByShort(w.frame.e, w.frame.h); return !!found && !!this.state.secrets[found.hash]; });
    if (!ready.length) return;
    this.waiting = this.waiting.filter(w => !ready.includes(w));
    this.waitingBytes = this.waiting.reduce((sum, w) => sum + w.frame.c.length, 0);
    for (const { from, frame } of ready) await this.receiveMessage(from, frame);
  }

  private async receiveSync(from: string, frame: CommunitySyncFrame): Promise<void> {
    if (!this.isRecentMember(from) || !Number.isSafeInteger(frame.e) || typeof frame.h !== "string") return;
    const theirs = this.known.get(frame.h);
    let start: number;
    if (theirs && this.mainIndex.has(frame.h)) start = this.mainIndex.get(frame.h)! + 1;
    else if (theirs) {
      // On a branch I did not follow: mine from where they part.
      const path = this.pathToMain(frame.h);
      start = path ? this.mainIndex.get(this.known.get(path[0])!.p)! + 1 : this.state.chain.length;
    } else {
      // Unknown to me: they may be ahead, or on a branch I never saw. From where our branches part (their
      // locator says), or my recent commits; my sync makes them send theirs.
      const common = (Array.isArray(frame.loc) ? frame.loc : []).find(x => typeof x === "string" && this.mainIndex.has(x));
      start = common !== undefined ? this.mainIndex.get(common)! + 1 : Math.max(0, this.state.chain.length - COMMUNITY_LIMITS.side);
      this.ask(from);
    }
    for (let i = start; i < this.state.chain.length; i++) {
      const commit = this.state.chain[i], h = communityCommitHash(commit);
      this.hooks.direct(from, { t: "group-commit", v: 2, g: this.id, commit });
      const secret = this.state.secrets[h];
      if (secret && rosterHas(this.rosterAt(h) ?? [], from) && FRESH.has(commit.k))
        this.hooks.direct(from, { t: "group-secret", v: 2, g: this.id, to: from, h, s: sealSecret(from, fromBase64Url(secret), secretAad(this.id, h, from)) });
    }
    // Secrets of the window they were in and lack (derived ones included: they may lack the parent).
    const held = new Set(Array.isArray(frame.secrets) ? frame.secrets.filter(x => typeof x === "string") : []);
    const secrets = this.state.chain.slice(-COMMUNITY_LIMITS.window - 1).map(c => communityCommitHash(c))
      .filter(h => this.state.secrets[h] && !held.has(shortHash(h)) && rosterHas(this.rosterAt(h) ?? [], from))
      .map(h => ({ h, s: sealSecret(from, fromBase64Url(this.state.secrets[h]), secretAad(this.id, h, from)) }));
    if (secrets.length) this.hooks.direct(from, { t: "group-secrets", v: 2, g: this.id, secrets: secrets.slice(-COMMUNITY_LIMITS.secrets) });
    // What was said while they were away, by anyone, for epochs they were in.
    const have = frame.have && typeof frame.have === "object" ? frame.have as Record<string, Record<string, unknown>> : {};
    for (const stored of this.state.store) {
      if (stored.s === from) continue;
      const found = this.commitByShort(stored.e, stored.h);
      if (!found || !rosterHas(this.rosterAt(found.hash) ?? [], from)) continue;
      const high = have[stored.s]?.[seenKey(stored.e, stored.h)];
      if (!Number.isSafeInteger(high) || (high as number) < stored.n) this.hooks.direct(from, stored);
    }
    // The link's seed, so they can answer it too.
    if (rosterHas(this.roster, from)) { const entry = this.entryFrame(from); if (entry) this.hooks.direct(from, entry); }
    // Pending leaves travel too, so whoever commits next can.
    for (const request of this.state.pendingLeaves) this.hooks.direct(from, { t: "group-leave", v: 2, g: this.id, ...request });
    // The group's picture, when theirs is older (after the commits and secrets above, which it may need).
    this.offerMeta(from, frame.mt);
    // And where I am, so they can hand me what I lack (asked once in a while, not in a loop).
    this.ask(from);
  }

  /** The current entry seed sealed to a member, when I hold it. */
  private entryFrame(to: string): CommunityEntryFrame | null {
    const { key, seedB64 } = this.state.entry;
    if (!key || !seedB64) return null;
    return { t: "group-entry", v: 2, g: this.id, to, x: key, s: sealSecret(to, fromBase64Url(seedB64), entryAad(this.id, to)) };
  }

  /** A newer entry seed, from a member who holds it (see `replaceLink`): only the one the chain names. */
  takeEntrySeed(seedB64: string): boolean {
    try {
      if (!this.isMember || identityFromSeedB64(seedB64).pubKeyZ32 !== this.currentEntryKey() || this.state.entry.seedB64 === seedB64) return false;
    } catch { return false; }
    this.state.entry = { key: this.currentEntryKey(), seedB64 };
    void this.persist();
    this.hooks.changed();
    return true;
  }
  /** The entry key the main branch names now. */
  currentEntryKey(): string {
    for (let i = this.state.chain.length - 1; i >= 0; i--) if (this.state.chain[i].x !== undefined) return this.state.chain[i].x!;
    return "";
  }

  setNick(key: string, nick: string | undefined): Promise<void> {
    return this.serialize(async () => {
      const clean = sanitizeNick(nick);
      if ((this.state.nicks[key] ?? undefined) === clean) return;
      if (clean) this.state.nicks[key] = clean; else delete this.state.nicks[key];
      await this.persist();
      this.hooks.changed();
    });
  }

  // -- metadata (WISP 9xx § Metadata) ------------------------------------------------------------

  /** Sets (or, with null, removes) the group's picture: only the admin, signed under the current commit. */
  setPicture(picture: string | null, now = Date.now()): Promise<void> {
    return this.serialize(async () => {
      this.requireMember();
      if (!this.isAdmin) throw new Error("Only the admin can change the group's picture");
      await this.publishMeta(encodeGroupMetaBody({ pic: picture ?? undefined }), now);
    });
  }

  /** Signs a body under my current commit, keeps it and sends it to everyone (hubs relay it). Inside `serialize`. */
  private async publishMeta(body: string, now: number): Promise<void> {
    const before = this.state.meta;
    const meta = signGroupMeta({ g: this.id, e: this.epoch, h: this.topHash, r: (before?.r ?? 0) + 1, ts: now }, body, this.identity.seed, this.myKey);
    this.state.meta = meta;
    await this.persist();
    const frame = this.metaFrame();
    if (frame) this.hooks.broadcast(frame);
    if (before?.d !== meta.d) this.hooks.metaChanged?.(this.myKey, this.picture);
    this.hooks.changed();
  }

  /** My statement sealed under my current epoch, when I hold its secret. */
  private metaFrame(): GroupMetaFrame | null {
    const meta = this.state.meta, secret = this.state.secrets[this.topHash];
    return meta && secret ? wrapGroupMeta(meta, this.topHash, epochKeys(fromBase64Url(secret), this.id, this.epoch).message, true) : null;
  }

  /** My statement, to a member whose sync says it holds an older one (or none); nothing to an app that says nothing. */
  private offerMeta(to: string, theirTag: unknown): void {
    const meta = this.state.meta, theirs = parseGroupMetaTag(theirTag);
    if (!meta || theirs === null || !groupMetaNewer(meta, theirs) || !this.isMember || !rosterHas(this.roster, to)) return;
    const frame = this.metaFrame();
    if (frame) this.hooks.direct(to, frame);
  }

  /**
   * A metadata statement (from its author's edge or a hub's): kept when it is newer than mine, its
   * commit is on my main branch, its signer was the admin after that commit and is the admin now,
   * its signature holds, and it opens under the epoch it names into metadata Ghostly shows. Returns
   * whether it was new, so a hub relays it. One naming what I do not have yet waits for the chain.
   */
  private async receiveMeta(from: string, raw: unknown): Promise<boolean> {
    const frame = parseGroupMetaFrame(raw);
    if (!frame || frame.statement.g !== this.id || typeof frame.k !== "string" || !this.isRecentMember(from)) return false;
    const s = frame.statement;
    if (!groupMetaNewer(s, this.state.meta)) return false;
    const at = this.mainIndex.get(s.h);
    if (at === undefined) {
      if (s.e >= this.epoch - COMMUNITY_LIMITS.window) { this.pendingMeta = { from, frame: raw }; this.ask(from); }
      return false;
    }
    if (at !== s.e || rosterAdmin(this.rosterAt(s.h) ?? []) !== s.by || this.admin !== s.by || !verifyGroupMetaSignature(s)) return false;
    // The epoch it is sealed under: a commit I know and hold the secret of, or one that may still come.
    const secret = this.state.secrets[frame.k], sealedUnder = this.known.get(frame.k);
    if (!secret || !sealedUnder) { this.pendingMeta = { from, frame: raw }; this.ask(from); return false; }
    const opened = openGroupMeta(frame, epochKeys(fromBase64Url(secret), this.id, sealedUnder.e).message);
    if (!opened) return false;
    const before = this.state.meta;
    this.state.meta = opened.meta;
    await this.persist();
    if (before?.d !== opened.meta.d) this.hooks.metaChanged?.(s.by, opened.body.pic);
    this.hooks.changed();
    return true;
  }

  /** After the chain or my secrets moved: the waiting statement, and, if I became the admin, the picture signed again as mine. */
  private async metaFollowsChain(): Promise<void> {
    const pending = this.pendingMeta;
    this.pendingMeta = undefined;
    if (pending && await this.receiveMeta(pending.from, pending.frame)) this.hooks.relay?.(pending.frame as GroupMetaFrame);
    // Joiners accept only the current admin's statement: a new admin signs the picture again.
    if (this.isAdmin && this.state.meta && this.state.meta.by !== this.myKey) await this.publishMeta(this.state.meta.body, this.hooks.clock?.() ?? Date.now());
  }

  private async fork(reason: string): Promise<void> {
    if (this.state.status !== "active") return;
    this.state.status = "forked";
    this.state.statusReason = `${reason}. Membership changes are halted; the admin must re-form the group.`;
    await this.persist();
    this.hooks.changed();
  }
}

export function signCommunity(commit: Omit<CommunityCommit, "sig">, seed: Uint8Array): CommunityCommit {
  return { ...commit, sig: toBase64Url(sign(utf8Encode(tuple(commit)), seed)) };
}

