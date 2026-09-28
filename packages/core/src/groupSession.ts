import { fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "./bytes";
import { identityFromSeedB64, publicKeyFromZ32, sign, verify } from "./identity";
import { sanitizeNick } from "./text";
import {
  GROUP_PROFILE, confirmationMatches, confirmationTag, decryptText, encryptText, epochKeys, newEpochSecret, openSecret, sealSecret,
  type SealedSecret,
} from "./groupCrypto";
import {
  GROUP_ID, MEMBER_KEY, MAX_GROUP_CHAIN, commitHash, commitUntaggedHash, expectedRoster, rosterAdmin, rosterHas, signCommit, verifyChain, verifyCommit, verifyCommitSignature,
  type CommitKind, type GroupCommit, type GroupRole, type Roster,
} from "./groupCommits";
import {
  encodeGroupMetaBody, groupDisplayName, groupMetaBody, groupMetaChange, groupMetaNewer, groupMetaPicture, parseGroupMetaBody, groupMetaTag, openGroupMeta, parseGroupMetaFrame, parseGroupMetaTag, signGroupMeta, verifyGroupMetaSignature, wrapGroupMeta,
  type GroupMeta, type GroupMetaChange, type GroupMetaFrame,
} from "./groupMeta";
import { MENTION_LIMITS, validMentions, wireMentions, type GroupMention } from "./groupMentions";
import { groupReplyAuthor, readReply, REPLY_LIMITS, wireReply, type WireReply } from "./replies";
import { readForwarded } from "./forwards";
import { GROUP_EDIT_FRAME, meshMessageRef, validEditText, type GroupIncomingEdit } from "./groupEdits";
import { validEditNumber } from "./pairedEdits";
import { MESH_HUBS, meshRendezvous, NO_HUB_POLICY, type MeshHubPolicy } from "./groupHubs";
import { readReaction, type WireReaction } from "./reactions";
import { GROUP_PIN_FRAME, readPin, type WirePin } from "./pins";
import { RateWindow } from "./pairedEdits";

/**
 * One member's view of a `group-mesh/1` group: the membership chain, the epoch
 * secrets it was given, its own bounded log of sent messages and what it has
 * seen from each sender. It is transport-agnostic: frames go out through
 * `send(to, frame)` and come in through `handle(from, frame)`, where `to` and
 * `from` are member keys the caller has authenticated (the pairwise edge of
 * the group is pinned to them). Admission frames travel on the inviter's
 * contact link and are handled by `admit`, `join` and `welcome`.
 */
export const GROUP_LIMITS = {
  /** Application text, UTF-8 bytes. */
  textBytes: 16 * 1024,
  /** Own messages kept for catch-up: count and total ciphertext bytes. */
  outlog: 32,
  outlogBytes: 128 * 1024,
  /** Frames waiting for an epoch (or its secret) that has not arrived yet. */
  waiting: 64,
  waitingBytes: 1024 * 1024,
  /** Epoch secrets kept: past this, older epochs cannot be read or handed on. */
  secrets: 32,
  /** Secrets in one `group-secrets` frame: apps from before revision 0.9 drop a frame with more. */
  secretsPerFrame: 16,
  /**
   * Other members' messages kept to hand on to a member who missed them (any member catches up the others): count
   * and total ciphertext bytes. The oldest go first.
   */
  relay: 256,
  relayBytes: 256 * 1024,
  /** Other members' edits kept to hand on, the latest per message (WISP 9xx § Edits): count and ciphertext bytes. */
  relayEdits: 64,
  relayEditBytes: 512 * 1024,
  /** Edits of one member handed on for one sync that asks for them: fewer than a receiver takes in a window. */
  handOnEdits: 16,
  /** Sequence numbers below the highest seen that a sync names as missing, per sender and epoch. */
  miss: 32,
  /** Per sender and epoch, the sequence numbers remembered below the highest seen. */
  window: 256,
  /** Commits ahead of the chain kept while the gap is fetched. */
  pendingCommits: 16,
  /** Commits carried in one welcome or chain frame, and their size: a frame stays well within the 60 KiB an edge carries. */
  chainPiece: 24,
  chainPieceBytes: 40 * 1024,
  /**
   * Syncs of one member answered in `syncWindowMs`: an edge opening, a question every ten seconds at most and a gossip
   * turn a minute fit well within; a member asking more is not answered until the window has room.
   */
  syncAnswers: 8,
  syncWindowMs: 60_000,
  /** Messages delivered from a copy that was not whole, remembered until a whole copy completes them. */
  provisional: 256,
} as const;

/** What every member should know about who can read what, in the words the apps show. */
export const GROUP_READ_NOTE = `Everyone in the group can read everything sent while they are a member. Someone removed keeps what they already received and cannot read what comes after; someone who joins later cannot read what came before. Messages go directly to each member; whoever was away gets what they missed from any member who has it (the group's last ${GROUP_LIMITS.relay} messages) when they meet again.`;

/**
 * `m`: the message's mentions (`GroupMention[]` as JSON), sealed under the same epoch key with a nonce of their own
 * and bound to the header. Outside the signature, which older apps check as it was: only the author's edge ever
 * carries its frame, so the edge vouches for it. Older apps ignore the field.
 */
/**
 * `xs`: the author's signature over the whole frame, the boxes of `m` and `r` included (revision 0.9), and `f` when
 * there is one. A frame handed on by another member keeps its boxes only with it: the edge it arrives on is not the
 * author's and vouches for nothing.
 * `f`: a forwarded text's hop count (WISP 9xx § Forwards), in the clear like the header: every member reads it anyway.
 */
export interface GroupMessageFrame { t: "group-msg"; g: string; e: number; s: string; n: number; ts: number; nn: string; c: string; sig: string; m?: { n: string; c: string }; r?: { n: string; c: string }; f?: number; xs?: string }
/**
 * An edit of message `<s>:<e>:<n>` by its author (WISP 9xx § Edits): edit number `v`, the new text (and its mentions)
 * as JSON `{ text, m? }` sealed under the key of the message's epoch `e`, signed by the author.
 */
export interface GroupEditFrame { t: "group-edit"; g: string; e: number; s: string; n: number; v: number; ts: number; nn: string; c: string; sig: string }
export interface GroupCommitFrame { t: "group-commit"; g: string; commit: GroupCommit; secret?: SealedSecret }
/**
 * `mt`: which metadata statement I hold (`groupMetaTag`); apps without metadata leave it out. `miss`: sequence numbers
 * below the highest in `have` that never arrived, per sender and epoch. `ask`: members whose messages I want the
 * receiver to hand on (their edges to me are down); apps from before revision 0.9 send neither and are handed nothing.
 */
export interface GroupSyncFrame { t: "group-sync"; g: string; e: number; h: string; have: Record<string, Record<string, number>>; secrets: number[]; mt?: string; miss?: Record<string, Record<string, number[]>>; ask?: string[] }
export interface GroupSecretsFrame { t: "group-secrets"; g: string; secrets: { e: number; s: SealedSecret }[] }
export interface GroupLeaveFrame { t: "group-leave"; g: string }
export interface GroupInviteFrame { t: "group-invite"; g: string; name: string; admin: string; e: number; n: number }
export interface GroupAcceptFrame { t: "group-accept"; g: string; key: string }
export interface GroupDeclineFrame { t: "group-decline"; g: string }
export interface GroupChainFrame { t: "group-chain"; g: string; commits: GroupCommit[] }
export interface GroupWelcomeFrame { t: "group-welcome"; g: string; name: string; commits: GroupCommit[]; secrets: { e: number; s: SealedSecret }[] }
export interface GroupRemovedFrame { t: "group-removed"; g: string }
/**
 * A member's leave, signed by its member key (WISP 9xx · Group Mesh § Hubs): unlike `group-leave`, which the admin
 * believes from the edge it comes on, hubs can carry it to an admin the member has no edge with. Apps from before drop it.
 */
export interface GroupByeFrame { t: "group-bye"; g: string; k: string; e: number; ts: number; sig: string }
export type GroupEdgeFrame = GroupMessageFrame | GroupEditFrame | GroupCommitFrame | GroupSyncFrame | GroupSecretsFrame | GroupLeaveFrame | GroupMetaFrame | GroupByeFrame;
export type GroupAdmissionFrame = GroupInviteFrame | GroupAcceptFrame | GroupDeclineFrame | GroupChainFrame | GroupWelcomeFrame | GroupRemovedFrame;

export type GroupStatus = "active" | "left" | "removed" | "forked";

export interface GroupState {
  id: string;
  name: string;
  profile: typeof GROUP_PROFILE;
  /** My member key seed for this group and nothing else. Wiped once I am out. */
  seedB64: string;
  createdAt: number;
  chain: GroupCommit[];
  /** Epoch → secret (base64url); only the epochs I was a member of, at most `secrets` of them. */
  secrets: Record<string, string>;
  status: GroupStatus;
  statusReason?: string;
  /** My next sequence number, in `seqEpoch`. */
  seq: number;
  seqEpoch: number;
  /** My own frames, newest last, for members who missed them. */
  sent: GroupMessageFrame[];
  /** Other members' frames, in the order they arrived, for members who missed them. Absent in states from before revision 0.9. */
  relay?: GroupMessageFrame[];
  /** Other members' edits, the latest per message, for members who missed them. Absent in states from before edits were handed on. */
  relayEdits?: GroupEditFrame[];
  /** Sender → epoch → highest sequence seen and the ones seen below it. */
  seen: Record<string, Record<string, { high: number; window: number[] }>>;
  /**
   * Messages delivered from a copy that was not whole, waiting for a whole copy to complete them, oldest first, at most
   * `GROUP_LIMITS.provisional`. Absent in states from before they were saved.
   */
  provisional?: string[];
  /** Names members announced on their edges. */
  nicks: Record<string, string>;
  /** The group's metadata (its picture), as the admin last signed it and I accepted it. */
  meta?: GroupMeta;
}

/**
 * `completes`: this message was delivered before from a copy another member handed on without its author's whole
 * signature (its text only); this is the whole one, with the mentions, reply and hop count its author put there.
 */
export interface GroupIncomingMessage { id: string; sender: string; epoch: number; seq: number; timestamp: number; text: string; mentions?: GroupMention[]; reply?: WireReply; forwarded?: number; completes?: true }

export interface GroupSessionHooks {
  save(state: GroupState): Promise<void>;
  /** Best effort, over the pairwise edge to that member if it is open. */
  send(to: string, frame: GroupEdgeFrame): void;
  /** Store before it resolves: replay state advances only afterwards. */
  message(message: GroupIncomingMessage): Promise<void> | void;
  /** An edit of a member's message, authenticated as its author (WISP 9xx § Edits). Apps without edits leave it out. */
  edit?(edit: GroupIncomingEdit): Promise<void> | void;
  /** Roster, epoch or status changed. */
  changed(): void;
  /** The group's name or picture changed (set, replaced or removed), by `by`. */
  metaChanged?(by: string, change: GroupMetaChange): void;
  /** The clock the limits read (the engine's, or a simulation's); the wall clock when absent. */
  clock?(): number;
}

const MAX_TEXT_BOX = Math.ceil((GROUP_LIMITS.textBytes + 16) * 4 / 3) + 4;
/** Sixteen mentions as JSON, each a key and two offsets, with room to spare, sealed. */
const MAX_MENTIONS_BOX = Math.ceil((MENTION_LIMITS.count * 96 + 16) * 4 / 3) + 4;
const mentionsAad = (f: Pick<GroupMessageFrame, "g" | "e" | "s" | "n" | "ts">) => JSON.stringify(["ghostly-group/1 mentions", f.g, f.e, f.s, f.n, f.ts]);
const isSealedBox = (max: number) => (v: unknown): v is { n: string; c: string } => !!v && typeof v === "object" &&
  typeof (v as Record<string, unknown>).n === "string" && (v as Record<string, string>).n.length === 32 && B64.test((v as Record<string, string>).n) &&
  typeof (v as Record<string, unknown>).c === "string" && (v as Record<string, string>).c.length <= max && B64.test((v as Record<string, string>).c);
const isMentionsBox = isSealedBox(MAX_MENTIONS_BOX);
/** A reply as JSON: its id, a line of the original as it may arrive before it is cleaned, and a member key; sealed. */
const MAX_REPLY_BOX = Math.ceil((REPLY_LIMITS.id + REPLY_LIMITS.raw * 4 + 128) * 4 / 3) + 4;
const replyAad = (f: Pick<GroupMessageFrame, "g" | "e" | "s" | "n" | "ts">) => JSON.stringify(["ghostly-group/1 reply", f.g, f.e, f.s, f.n, f.ts]);
const isReplyBox = isSealedBox(MAX_REPLY_BOX);
const B64 = /^[A-Za-z0-9_-]*$/;
const secretAad = (g: string, e: number, member: string) => JSON.stringify(["ghostly-group/1 secret", g, e, member]);
const messageAad = (f: Pick<GroupMessageFrame, "g" | "e" | "s" | "n" | "ts">) => JSON.stringify([f.g, f.e, f.s, f.n, f.ts]);
const messageSigned = (f: Omit<GroupMessageFrame, "sig" | "t">) => utf8Encode(JSON.stringify(["ghostly-group/1 msg", f.g, f.e, f.s, f.n, f.ts, f.nn, f.c]));
/**
 * What `xs` covers: the frame and both boxes, so a member handing it on cannot swap or forge them; a hop count after
 * them, only when there is one, so what an app from before forwards signs and checks stays the same.
 */
const messageSignedWhole = (f: Omit<GroupMessageFrame, "sig" | "t" | "xs">) =>
  utf8Encode(JSON.stringify(["ghostly-group/1 msg+", f.g, f.e, f.s, f.n, f.ts, f.nn, f.c, f.m?.n ?? "", f.m?.c ?? "", f.r?.n ?? "", f.r?.c ?? "", ...(f.f !== undefined ? [f.f] : [])]));
export const groupMessageId = (sender: string, epoch: number, seq: number) => `${sender}:${epoch}:${seq}`;
/** An edit's box holds the text and its mentions as JSON: room for a text whose every character JSON escapes. */
const MAX_EDIT_PLAIN = GROUP_LIMITS.textBytes * 2 + MENTION_LIMITS.count * 96 + 64;
const MAX_EDIT_BOX = Math.ceil((MAX_EDIT_PLAIN + 16) * 4 / 3) + 4;
const editAad = (f: Pick<GroupEditFrame, "g" | "e" | "s" | "n" | "v" | "ts">) => JSON.stringify(["ghostly-group/1 edit", f.g, f.e, f.s, f.n, f.v, f.ts]);
/** What a member signs of its reaction, so that a hub can pass it on (WISP 9xx · Group Mesh § Hubs). */
const reactionSigned = (g: string, r: WireReaction) => utf8Encode(JSON.stringify(["ghostly-group/1 react", g, r.id, r.e, r.n]));
/**
 * A member's reaction as a hub passes it on: signed by the member (`k`), unlike `group-react`, which the edge it comes
 * on vouches for. A frame of its own, which apps from before hubs drop: they would take it as the hub's reaction.
 */
export const GROUP_REACTED_FRAME = "group-reacted";
export interface GroupReactedFrame extends WireReaction { t: typeof GROUP_REACTED_FRAME; g: string; k: string; sig: string }
/** What a member signs of its pin: any member passes it on as it is (WISP 9xx · Group Mesh § Pinned message). */
const pinSigned = (g: string, p: WirePin) => utf8Encode(JSON.stringify(["ghostly-group/1 pin", g, p.id, p.n]));
export interface GroupPinFrame extends WirePin { t: typeof GROUP_PIN_FRAME; g: string; k: string; sig: string }
const byeSigned = (f: Omit<GroupByeFrame, "sig" | "t">) => utf8Encode(JSON.stringify(["ghostly-group/1 bye", f.g, f.k, f.e, f.ts]));
const editSigned = (f: Omit<GroupEditFrame, "sig" | "t">) => utf8Encode(JSON.stringify(["ghostly-group/1 edit", f.g, f.e, f.s, f.n, f.v, f.ts, f.nn, f.c]));
function isEditFrame(v: unknown): v is GroupEditFrame {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return f.t === GROUP_EDIT_FRAME && typeof f.g === "string" && GROUP_ID.test(f.g) && Number.isSafeInteger(f.e) && (f.e as number) >= 0 &&
    typeof f.s === "string" && MEMBER_KEY.test(f.s) && Number.isSafeInteger(f.n) && (f.n as number) >= 0 && validEditNumber(f.v) &&
    Number.isSafeInteger(f.ts) && (f.ts as number) > 0 && typeof f.nn === "string" && f.nn.length === 32 && B64.test(f.nn) &&
    typeof f.c === "string" && f.c.length <= MAX_EDIT_BOX && B64.test(f.c) && typeof f.sig === "string" && f.sig.length === 86 && B64.test(f.sig);
}

/** What a frame weighs in a log, roughly: its boxes plus the fixed fields around them. */
const frameBytes = (f: GroupMessageFrame) => f.c.length + (f.m?.c.length ?? 0) + (f.r?.c.length ?? 0) + 400;

/** Only the fields an edit frame has, as `clean` does for a message. */
const cleanEdit = (f: GroupEditFrame): GroupEditFrame => ({ t: GROUP_EDIT_FRAME, g: f.g, e: f.e, s: f.s, n: f.n, v: f.v, ts: f.ts, nn: f.nn, c: f.c, sig: f.sig });

/** Only the fields a message frame has: what a member keeps and hands on carries nothing else its author put there. */
function clean(f: GroupMessageFrame): GroupMessageFrame {
  return { t: "group-msg", g: f.g, e: f.e, s: f.s, n: f.n, ts: f.ts, nn: f.nn, c: f.c, sig: f.sig,
    ...(isMentionsBox(f.m) ? { m: { n: f.m.n, c: f.m.c } } : {}), ...(isReplyBox(f.r) ? { r: { n: f.r.n, c: f.r.c } } : {}),
    ...(readForwarded(f.f) ? { f: f.f } : {}),
    ...(typeof f.xs === "string" && f.xs.length === 86 && B64.test(f.xs) ? { xs: f.xs } : {}) };
}

/** Whether the member whose sync this is lacks a frame: above what it has from that sender, or one it names as missing. */
function missingIn(frame: GroupSyncFrame, from: string): (f: GroupMessageFrame) => boolean {
  const have = frame.have && typeof frame.have === "object" ? frame.have as Record<string, Record<string, unknown>> : {};
  const miss = frame.miss && typeof frame.miss === "object" ? frame.miss as Record<string, Record<string, unknown>> : {};
  return f => {
    if (f.s === from) return false;
    const high = have[f.s]?.[f.e];
    if (!Number.isSafeInteger(high) || (high as number) < f.n) return true;
    const gaps = miss[f.s]?.[f.e];
    return Array.isArray(gaps) && gaps.length <= GROUP_LIMITS.miss && gaps.includes(f.n);
  };
}

function isSealed(v: unknown): v is SealedSecret {
  return !!v && typeof v === "object" && ["e", "n", "c"].every(k => typeof (v as Record<string, unknown>)[k] === "string" && B64.test((v as Record<string, string>)[k]) && (v as Record<string, string>)[k].length <= 128);
}
function isMessageFrame(v: unknown): v is GroupMessageFrame {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return f.t === "group-msg" && typeof f.g === "string" && GROUP_ID.test(f.g) && Number.isSafeInteger(f.e) && (f.e as number) >= 0 &&
    typeof f.s === "string" && MEMBER_KEY.test(f.s) && Number.isSafeInteger(f.n) && (f.n as number) >= 0 && Number.isSafeInteger(f.ts) && (f.ts as number) > 0 &&
    typeof f.nn === "string" && f.nn.length === 32 && B64.test(f.nn) && typeof f.c === "string" && f.c.length <= MAX_TEXT_BOX && B64.test(f.c) &&
    typeof f.sig === "string" && f.sig.length === 86 && B64.test(f.sig);
}

/** The chain cut in consecutive pieces of at most `chainPiece` commits and `chainPieceBytes`: a roster of 32 makes a commit ~2.4 KB. */
export function chainPieces(chain: GroupCommit[]): GroupCommit[][] {
  const pieces: GroupCommit[][] = [];
  let piece: GroupCommit[] = [], bytes = 0;
  for (const commit of chain) {
    const size = JSON.stringify(commit).length + 1;
    if (piece.length && (piece.length >= GROUP_LIMITS.chainPiece || bytes + size > GROUP_LIMITS.chainPieceBytes)) { pieces.push(piece); piece = []; bytes = 0; }
    piece.push(commit); bytes += size;
  }
  pieces.push(piece);
  return pieces;
}

export class GroupSession {
  readonly state: GroupState;
  private readonly identity;
  /** Frames for an epoch, or a secret, not here yet. In memory only. */
  private waiting: { from: string; frame: GroupMessageFrame }[] = [];
  private waitingBytes = 0;
  /** Edits for an epoch, or a secret, not here yet: tried again with the frames above. In memory only. */
  private waitingEdits: { from: string; frame: GroupEditFrame }[] = [];
  private pendingCommits = new Map<number, GroupCommitFrame>();
  /** When each member was last asked to catch me up, so a stream of unreadable frames is one question, not a loop. */
  private asked = new Map<string, number>();
  private queue = Promise.resolve();
  /** One metadata frame that names a commit or an epoch I do not have yet: tried again when the chain moves. */
  private pendingMeta: { from: string; frame: unknown } | undefined;
  /** While `handle` runs: the frames it took that a hub passes on (`handle`'s result). */
  private passOn: GroupEdgeFrame[] | null = null;
  /** Syncs answered per member, a few a minute (`GROUP_LIMITS.syncAnswers`). In memory only. */
  private syncsAnswered = new Map<string, RateWindow>();
  /**
   * Messages delivered from a copy that was not whole (handed on without its author's whole signature): not seen, so
   * a sync still asks for them and a whole copy completes them. Oldest first, saved as `GroupState.provisional`, so a
   * restart does not let a stripped copy take the message's place.
   */
  private provisional: Set<string>;

  constructor(state: GroupState, private readonly hooks: GroupSessionHooks) {
    this.state = state;
    this.identity = identityFromSeedB64(state.seedB64);
    this.provisional = new Set((state.provisional ?? []).slice(-GROUP_LIMITS.provisional));
  }

  /** A new group: its genesis commit, signed by the creator, who is its admin. */
  static create(name: string, now = Date.now()): GroupState {
    const identity = identityFromSeedB64(toBase64Url(randomBytes(32)));
    const id = toBase64Url(randomBytes(16));
    const secret = newEpochSecret();
    const draft: Omit<GroupCommit, "sig" | "c"> = { v: 1, g: id, e: 0, p: "", k: "create", m: [[identity.pubKeyZ32, "admin"]], by: identity.pubKeyZ32, ts: now };
    const commit = signCommit({ ...draft, c: confirmationTag(epochKeys(secret, id, 0).confirm, commitUntaggedHash(draft)) }, identity.seed);
    return { id, name: sanitizeNick(name) ?? "Group", profile: GROUP_PROFILE, seedB64: identity.seedB64, createdAt: now, chain: [commit],
      secrets: { 0: toBase64Url(secret) }, status: "active", seq: 0, seqEpoch: 0, sent: [], seen: {}, nicks: {} };
  }

  /**
   * Joining from a welcome: the chain must verify from its genesis, admit me
   * in a commit signed by the admin the invitation named (learned over the
   * inviter's authenticated contact link), end with me in the roster, and
   * come with the secret of the current epoch, confirmed against its commit.
   * Earlier epochs I was a member of may come too; nothing before my admission can.
   */
  static join(invite: { name: string; admin: string }, pieces: unknown[], welcome: unknown, seedB64: string, now = Date.now()): { state: GroupState } | { error: string } {
    if (!welcome || typeof welcome !== "object") return { error: "Malformed welcome" };
    const w = welcome as Record<string, unknown>;
    if (w.t !== "group-welcome" || typeof w.g !== "string" || !GROUP_ID.test(w.g) || !Array.isArray(w.commits) || !Array.isArray(w.secrets)) return { error: "Malformed welcome" };
    const commits = [...pieces.flatMap(p => (p && typeof p === "object" && Array.isArray((p as GroupChainFrame).commits)) ? (p as GroupChainFrame).commits : []), ...w.commits];
    if (commits.length > MAX_GROUP_CHAIN) return { error: "Membership chain too long" };
    const verified = verifyChain(commits, w.g);
    if ("error" in verified) return verified;
    const chain = verified.chain;
    const identity = identityFromSeedB64(seedB64);
    const me = identity.pubKeyZ32;
    const top = chain[chain.length - 1];
    if (!rosterHas(top.m, me)) return { error: "The welcome does not admit this member key" };
    let admitted = -1;
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].k === "add" && chain[i].s === me) { admitted = i; break; }
    // The trust anchor: the contact who invited me, authenticated on our chat, is the admin who admitted me.
    if (admitted < 0 || chain[admitted].by !== invite.admin) return { error: "The group's admin is not the contact who invited you" };
    const secrets: Record<string, string> = {};
    for (const entry of w.secrets as unknown[]) {
      if (!entry || typeof entry !== "object") continue;
      const { e, s } = entry as { e?: unknown; s?: unknown };
      if (!Number.isSafeInteger(e) || (e as number) < admitted || (e as number) > top.e || !isSealed(s) || !rosterHas(chain[e as number].m, me)) continue;
      const secret = openSecret(identity.seed, me, s, secretAad(w.g, e as number, me));
      if (secret && confirmationMatches(epochKeys(secret, w.g, e as number).confirm, commitUntaggedHash(chain[e as number]), chain[e as number].c)) secrets[e as number] = toBase64Url(secret);
    }
    if (!secrets[top.e]) return { error: "The welcome carries no usable secret for the current epoch" };
    return { state: { id: w.g, name: sanitizeNick(typeof w.name === "string" ? w.name : invite.name) ?? invite.name, profile: GROUP_PROFILE, seedB64, createdAt: now, chain, secrets,
      status: "active", seq: 0, seqEpoch: top.e, sent: [], seen: {}, nicks: {} } };
  }

  get id(): string { return this.state.id; }
  /** The name the admin gave the group, else the one it had when I got in (WISP 9xx § Metadata). */
  get name(): string { return groupDisplayName(this.state.meta, this.state.name); }
  get myKey(): string { return this.identity.pubKeyZ32; }
  get epoch(): number { return this.state.chain[this.state.chain.length - 1].e; }
  get top(): GroupCommit { return this.state.chain[this.state.chain.length - 1]; }
  get roster(): Roster { return this.top.m; }
  get admin(): string | undefined { return rosterAdmin(this.roster); }
  get isAdmin(): boolean { return this.admin === this.myKey && this.state.status === "active"; }
  get status(): GroupStatus { return this.state.status; }
  /** Members other than me, in the current roster. */
  get others(): string[] { return this.roster.map(([k]) => k).filter(k => k !== this.myKey); }
  role(key: string): GroupRole | undefined { return this.roster.find(([k]) => k === key)?.[1]; }
  /** The group's picture, if it has one. */
  get picture(): string | undefined { return groupMetaPicture(this.state.meta); }
  /** Whom the admin pinned as hubs and excluded (WISP 9xx · Group Mesh § Hubs), from the group's metadata. */
  get hubPolicy(): MeshHubPolicy {
    // Parsed once per statement: the body may hold a picture of 40,000 characters, and views ask for this per member.
    const meta = this.state.meta;
    if (!this.policyOf || this.policyOf.sig !== meta?.sig) this.policyOf = { sig: meta?.sig, policy: (meta && parseGroupMetaBody(meta.body)?.hubs) || NO_HUB_POLICY };
    return this.policyOf.policy;
  }
  private policyOf: { sig: string | undefined; policy: MeshHubPolicy } | undefined;
  /** The current epoch's rendezvous secret (its beacon and lobbies), once its secret is here. */
  get rendezvous(): string | undefined {
    const secret = this.secret(this.epoch);
    return secret && meshRendezvous(secret, this.id, this.epoch);
  }
  /** Epochs whose messages this member can still read. */
  get readableEpochs(): number[] { return Object.keys(this.state.secrets).map(Number).sort((a, b) => a - b); }
  /** How many messages, per sender, are known to be missing in the current epoch. */
  missing(sender: string): number {
    const entry = this.state.seen[sender]?.[this.epoch];
    if (!entry) return 0;
    const lowest = Math.max(0, entry.high - GROUP_LIMITS.window + 1);
    return Math.max(0, entry.high - lowest + 1 - (1 + entry.window.filter(n => n >= lowest).length));
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(run);
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
  private persist(): Promise<void> { return this.hooks.save(structuredClone(this.state)); }
  private secret(epoch: number): Uint8Array | undefined {
    const s = this.state.secrets[epoch];
    return s ? fromBase64Url(s) : undefined;
  }
  private requireAdmin(): void {
    if (this.state.status !== "active") throw new Error("You are no longer in this group");
    if (!this.isAdmin) throw new Error("Only the admin can change the members of this group");
  }

  /** What the admin sends a contact over their chat to invite them. */
  inviteFrame(): GroupInviteFrame {
    this.requireAdmin();
    return { t: "group-invite", g: this.id, name: this.name, admin: this.myKey, e: this.epoch, n: this.roster.length };
  }

  /**
   * Admits a member who accepted: a new epoch whose secret goes to everyone in
   * the new roster. Returns the welcome for the newcomer (to send over the
   * contact link) after telling the existing members over their edges.
   */
  admit(memberKey: string, now = Date.now()): Promise<(GroupChainFrame | GroupWelcomeFrame)[]> {
    return this.serialize(async () => {
      this.requireAdmin();
      if (!MEMBER_KEY.test(memberKey) || memberKey === this.myKey) throw new Error("Invalid member key");
      if (rosterHas(this.roster, memberKey)) throw new Error("Already a member");
      const { secret } = await this.commit("add", memberKey, now);
      const sealed = { e: this.epoch, s: sealSecret(memberKey, secret, secretAad(this.id, this.epoch, memberKey)) };
      const pieces = chainPieces(this.state.chain);
      const tail = pieces.pop()!;
      return [...pieces.map((commits): GroupChainFrame => ({ t: "group-chain", g: this.id, commits })),
        { t: "group-welcome", g: this.id, name: this.name, commits: tail, secrets: [sealed] }];
    });
  }

  remove(memberKey: string, now = Date.now()): Promise<void> {
    return this.serialize(async () => {
      this.requireAdmin();
      if (!rosterHas(this.roster, memberKey) || memberKey === this.myKey) throw new Error("Not a member");
      await this.commit("remove", memberKey, now);
    });
  }

  transferAdmin(memberKey: string, now = Date.now()): Promise<void> {
    return this.serialize(async () => {
      this.requireAdmin();
      if (!rosterHas(this.roster, memberKey) || memberKey === this.myKey) throw new Error("Not a member");
      await this.commit("role", memberKey, now);
    });
  }

  /** A fresh secret without a membership change: whoever holds the old one and is not a member learns nothing new. */
  rotate(now = Date.now()): Promise<void> {
    return this.serialize(async () => { this.requireAdmin(); await this.commit("rotate", undefined, now); });
  }

  private async commit(kind: CommitKind, subject: string | undefined, now: number): Promise<{ secret: Uint8Array }> {
    if (this.state.chain.length >= MAX_GROUP_CHAIN) throw new Error("This group has reached its membership history limit. Create a new group.");
    const previous = this.top;
    const roster = expectedRoster(previous.m, kind, this.myKey, subject);
    if (!roster) throw new Error("This change is not allowed");
    const epoch = previous.e + 1;
    const secret = newEpochSecret();
    const draft: Omit<GroupCommit, "sig" | "c"> = { v: 1, g: this.id, e: epoch, p: commitHash(previous), k: kind, m: roster, by: this.myKey, ...(subject ? { s: subject } : {}), ts: now };
    const commit = signCommit({ ...draft, c: confirmationTag(epochKeys(secret, this.id, epoch).confirm, commitUntaggedHash(draft)) }, this.identity.seed);
    this.state.chain.push(commit);
    this.state.secrets[epoch] = toBase64Url(secret);
    this.pruneSecrets();
    this.pruneRelay();
    this.state.seq = 0; this.state.seqEpoch = epoch;
    await this.persist();
    // The old roster hears about it, the one removed included (without a secret).
    for (const [key] of previous.m) {
      if (key === this.myKey) continue;
      const member = rosterHas(roster, key);
      this.hooks.send(key, { t: "group-commit", g: this.id, commit, ...(member ? { secret: sealSecret(key, secret, secretAad(this.id, epoch, key)) } : {}) });
    }
    this.hooks.changed();
    return { secret };
  }

  /** Someone out of the roster is not handed on any more, whatever they sent while in it (WISP 9xx § Catch-up). */
  private pruneRelay(): void {
    if (this.state.relay?.length) this.state.relay = this.state.relay.filter(f => rosterHas(this.roster, f.s));
    if (this.state.relayEdits?.length) this.state.relayEdits = this.state.relayEdits.filter(f => rosterHas(this.roster, f.s));
  }

  /** Another member's edit, kept to hand on: the latest per message; the oldest go once the log is full. False: one as new was kept. */
  private keepEdit(frame: GroupEditFrame): boolean {
    const same = (f: GroupEditFrame) => f.s === frame.s && f.e === frame.e && f.n === frame.n;
    const log = this.state.relayEdits ?? [];
    if (log.some(f => same(f) && f.v >= frame.v)) return false;
    const next = [...log.filter(f => !same(f)), cleanEdit(frame)];
    let bytes = next.reduce((sum, f) => sum + f.c.length, 0);
    while (next.length > GROUP_LIMITS.relayEdits || bytes > GROUP_LIMITS.relayEditBytes) bytes -= next.shift()!.c.length;
    this.state.relayEdits = next;
    return true;
  }

  /** A frame of another member, kept to hand on; the oldest go once the log is full. */
  private keep(frame: GroupMessageFrame): void {
    const log = (this.state.relay ??= []);
    log.push(frame);
    let bytes = log.reduce((sum, f) => sum + frameBytes(f), 0);
    while (log.length > GROUP_LIMITS.relay || bytes > GROUP_LIMITS.relayBytes) bytes -= frameBytes(log.shift()!);
  }

  private pruneSecrets(): void {
    const epochs = Object.keys(this.state.secrets).map(Number).sort((a, b) => a - b);
    for (const e of epochs.slice(0, Math.max(0, epochs.length - GROUP_LIMITS.secrets))) delete this.state.secrets[e];
  }

  /** Leaves: my secrets go now; the admin removes me from the roster when it hears. */
  leave(): Promise<void> {
    return this.serialize(async () => {
      if (this.state.status !== "active") return;
      if (this.isAdmin && this.others.length) throw new Error("Make someone else the admin before leaving");
      const admin = this.admin;
      this.out("left", "You left this group");
      await this.persist();
      if (admin && admin !== this.myKey) this.hooks.send(admin, { t: "group-leave", g: this.id });
      this.hooks.changed();
    });
  }

  /** Told out of band (the admin's contact chat) that I was removed, before or instead of the commit. */
  markRemoved(): Promise<void> {
    return this.serialize(async () => {
      if (this.state.status !== "active") return;
      this.out("removed", "You were removed from this group");
      await this.persist();
      this.hooks.changed();
    });
  }

  private out(status: GroupStatus, reason: string): void {
    this.state.status = status;
    this.state.statusReason = reason;
    this.state.secrets = {};
    this.state.sent = [];
    this.state.relay = [];
    this.state.relayEdits = [];
    this.waiting = []; this.waitingBytes = 0; this.pendingCommits.clear();
  }

  /**
   * Encrypts and signs a text, keeps it for catch-up and sends it to every other member. `mentions`: places of the
   * text that name members (everyone: the admin only); what does not hold is left out. `reply`: the message it
   * answers, sealed apart from the text (`r`) like the mentions, so an older app still reads the text. `forwarded`: the
   * hop count of a forwarded text (`f`, WISP 9xx § Forwards).
   */
  sendText(text: string, now = Date.now(), mentions: readonly GroupMention[] = [], reply?: WireReply, forwarded?: number): Promise<{ id: string } | { error: string }> {
    return this.serialize(async () => {
      if (this.state.status !== "active") return { error: this.state.statusReason ?? "You are no longer in this group" };
      const trimmed = text.trim();
      if (!trimmed) return { error: "Nothing to send" };
      if (utf8Encode(trimmed).length > GROUP_LIMITS.textBytes) return { error: "Message exceeds 16 KiB" };
      const epoch = this.epoch, secret = this.secret(epoch);
      if (!secret) return { error: "This epoch's key has not arrived yet. Wait for a member to catch you up." };
      if (this.state.seqEpoch !== epoch) { this.state.seq = 0; this.state.seqEpoch = epoch; }
      const n = this.state.seq++;
      const header = { g: this.id, e: epoch, s: this.myKey, n, ts: now };
      const key = epochKeys(secret, this.id, epoch).message;
      const { n: nn, c } = encryptText(key, messageAad(header), trimmed);
      const unsigned = { ...header, nn, c };
      const named = validMentions(wireMentions(mentions), trimmed, this.isAdmin);
      const answers = reply && readReply(wireReply(reply), groupReplyAuthor);
      const boxes = { ...(named.length ? { m: encryptText(key, mentionsAad(header), JSON.stringify(named)) } : {}),
        ...(answers ? { r: encryptText(key, replyAad(header), JSON.stringify(answers)) } : {}), ...(readForwarded(forwarded) ? { f: forwarded } : {}) };
      const frame: GroupMessageFrame = { t: "group-msg", ...unsigned, sig: toBase64Url(sign(messageSigned(unsigned), this.identity.seed)), ...boxes,
        xs: toBase64Url(sign(messageSignedWhole({ ...unsigned, ...boxes }), this.identity.seed)) };
      this.state.sent.push(frame);
      let bytes = this.state.sent.reduce((sum, f) => sum + f.c.length, 0);
      while (this.state.sent.length > GROUP_LIMITS.outlog || bytes > GROUP_LIMITS.outlogBytes) bytes -= this.state.sent.shift()!.c.length;
      const id = groupMessageId(this.myKey, epoch, n);
      await this.hooks.message({ id, sender: this.myKey, epoch, seq: n, timestamp: now, text: trimmed, ...(named.length ? { mentions: named } : {}), ...(answers ? { reply: answers } : {}), ...(boxes.f ? { forwarded: boxes.f } : {}) });
      await this.persist();
      for (const key of this.others) this.hooks.send(key, frame);
      return { id };
    });
  }

  /**
   * Says an edit of one of my messages (WISP 9xx § Edits): edit `v`, the whole new text and its mentions, sealed under
   * the key of the message's epoch and signed, to every member of that epoch still in the group, or to `to` alone (an
   * edge that just opened). Someone admitted after the message cannot open it and is not sent it. The message's
   * epoch key must still be here: past `GROUP_LIMITS.secrets` epochs a message cannot be edited.
   */
  sendEdit(messageId: string, edit: { v: number; ts: number; text: string; mentions?: readonly GroupMention[] }, to?: string): Promise<{ sent: number } | { error: string }> {
    return this.serialize(async () => {
      if (this.state.status !== "active") return { error: this.state.statusReason ?? "You are no longer in this group" };
      const ref = meshMessageRef(messageId);
      const commit = ref && this.state.chain[ref.e];
      if (!ref || ref.s !== this.myKey || !commit || !rosterHas(commit.m, this.myKey)) return { error: "Only your own messages can be edited" };
      if (!validEditNumber(edit.v)) return { error: "This message was edited too many times" };
      const text = edit.text.trim();
      if (!validEditText(text)) return { error: text ? "Message exceeds 16 KiB" : "An edit cannot be empty" };
      const secret = this.secret(ref.e);
      if (!secret) return { error: "This message is too old to edit: its epoch's key is gone" };
      const named = validMentions(wireMentions(edit.mentions ?? []), text, rosterAdmin(commit.m) === this.myKey);
      const plain = JSON.stringify({ text, ...(named.length ? { m: named } : {}) });
      if (utf8Encode(plain).length > MAX_EDIT_PLAIN) return { error: "Message exceeds 16 KiB" };
      const header = { g: this.id, e: ref.e, s: this.myKey, n: ref.n, v: edit.v, ts: edit.ts };
      const { n: nn, c } = encryptText(epochKeys(secret, this.id, ref.e).message, editAad(header), plain);
      const unsigned = { ...header, nn, c };
      const frame: GroupEditFrame = { t: GROUP_EDIT_FRAME, ...unsigned, sig: toBase64Url(sign(editSigned(unsigned), this.identity.seed)) };
      const members = (to === undefined ? this.others : [to]).filter(key => key !== this.myKey && rosterHas(this.roster, key) && rosterHas(commit.m, key));
      for (const key of members) this.hooks.send(key, frame);
      return { sent: members.length };
    });
  }


  /**
   * What to tell a member whose edge just opened: where I am, what I have from everyone and what never arrived below
   * that. `ask`: the members whose messages I want this one to hand on, since their own edges to me are down.
   */
  syncFrame(ask: readonly string[] = []): GroupSyncFrame {
    const have: Record<string, Record<string, number>> = {};
    const miss: Record<string, Record<string, number[]>> = {};
    for (const [sender, epochs] of Object.entries(this.state.seen)) {
      have[sender] = {};
      for (const [e, entry] of Object.entries(epochs)) {
        have[sender][e] = entry.high;
        const gaps = this.gaps(entry);
        if (gaps.length) (miss[sender] ??= {})[e] = gaps;
      }
    }
    const wanted = ask.filter(k => k !== this.myKey && rosterHas(this.roster, k));
    return { t: "group-sync", g: this.id, e: this.epoch, h: commitHash(this.top), have, secrets: this.readableEpochs, mt: groupMetaTag(this.state.meta),
      ...(Object.keys(miss).length ? { miss } : {}), ...(wanted.length ? { ask: wanted } : {}) };
  }

  /** Sequence numbers below the highest seen that never arrived, the newest `miss` of them. */
  private gaps(entry: { high: number; window: number[] }): number[] {
    const got = new Set(entry.window), gaps: number[] = [];
    for (let n = entry.high - 1; n >= Math.max(0, entry.high - GROUP_LIMITS.window + 1) && gaps.length < GROUP_LIMITS.miss; n--) if (!got.has(n)) gaps.push(n);
    return gaps;
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

  /**
   * A frame from an authenticated member over the pairwise edge. Anything malformed or unauthorized is dropped.
   * Resolves to what it took that a hub passes on to its other edges (WISP 9xx · Group Mesh § Hubs): each message,
   * edit, commit (without the secret sealed for me), metadata statement and signed leave, the first time only, so a
   * flood among hubs stops at every member that already has it. Only what its author still in the roster signed.
   */
  handle(from: string, raw: unknown): Promise<GroupEdgeFrame[]> {
    return this.serialize(async () => {
      if (this.state.status !== "active" || !raw || typeof raw !== "object") return [];
      const frame = raw as Record<string, unknown>;
      if (frame.g !== this.id) return [];
      this.passOn = [];
      try {
        switch (frame.t) {
          case "group-msg": await this.receiveMessage(from, raw); break;
          case GROUP_EDIT_FRAME: await this.receiveEdit(from, raw); break;
          case "group-commit": await this.receiveCommit(from, raw as GroupCommitFrame); break;
          case "group-sync": await this.receiveSync(from, raw as GroupSyncFrame); break;
          case "group-secrets": await this.receiveSecrets(raw as GroupSecretsFrame); break;
          case "group-meta": await this.receiveMeta(from, raw); break;
          case "group-bye": await this.receiveBye(from, raw); break;
          case "group-leave": if (this.isAdmin && rosterHas(this.roster, from) && from !== this.myKey) await this.commit("remove", from, Date.now()); break;
        }
        // Removed, the last thing a hub passes on is the commit that says so: it may be the only way the others hear it.
        return this.state.status === "active" ? this.passOn : this.state.status === "removed" ? this.passOn.filter(f => f.t === "group-commit") : [];
      } finally { this.passOn = null; }
    });
  }

  /** Taken for the first time: a hub passes it on (see `handle`). */
  private took(frame: GroupEdgeFrame): void { this.passOn?.push(frame); }

  /**
   * My leave, signed, for hubs to carry to the admin (see `GroupByeFrame`). Made while I am still a member: `leave`
   * forgets everything but my key.
   */
  byeFrame(now = Date.now()): GroupByeFrame {
    const unsigned = { g: this.id, k: this.myKey, e: this.epoch, ts: now };
    return { t: "group-bye", ...unsigned, sig: toBase64Url(sign(byeSigned(unsigned), this.identity.seed)) };
  }

  /** My signature on a reaction of mine, beside its wire fields (older apps read only those). */
  signReaction(reaction: WireReaction): { k: string; sig: string } {
    return { k: this.myKey, sig: toBase64Url(sign(reactionSigned(this.id, reaction), this.identity.seed)) };
  }

  /**
   * A reaction signed by a member still in the roster (not me), with the member and the reaction, or null: what a hub
   * passes on, and what a member takes from a hub.
   */
  signedReaction(raw: unknown): { member: string; reaction: WireReaction; frame: GroupReactedFrame } | null {
    if (this.state.status !== "active" || !raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>, reaction = readReaction(f);
    if (!reaction || f.g !== this.id || typeof f.k !== "string" || !MEMBER_KEY.test(f.k) || f.k === this.myKey || !rosterHas(this.roster, f.k)) return null;
    if (typeof f.sig !== "string" || f.sig.length !== 86 || !B64.test(f.sig)) return null;
    try { if (!verify(fromBase64Url(f.sig), reactionSigned(this.id, reaction), publicKeyFromZ32(f.k))) return null; } catch { return null; }
    return { member: f.k, reaction, frame: { t: GROUP_REACTED_FRAME, g: this.id, k: f.k, ...reaction, sig: f.sig } };
  }

  /** My pin, signed, as it goes over every edge. */
  pinFrame(pin: WirePin): GroupPinFrame {
    return { t: GROUP_PIN_FRAME, g: this.id, id: pin.id, n: pin.n, k: this.myKey, sig: toBase64Url(sign(pinSigned(this.id, pin), this.identity.seed)) };
  }

  /** A pin signed by a member still in the roster (me too: it may come back through another member), or null. */
  signedPin(raw: unknown): { member: string; pin: WirePin; frame: GroupPinFrame } | null {
    if (this.state.status !== "active" || !raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>, pin = readPin(f);
    if (!pin || f.g !== this.id || typeof f.k !== "string" || !MEMBER_KEY.test(f.k) || !rosterHas(this.roster, f.k)) return null;
    if (typeof f.sig !== "string" || f.sig.length !== 86 || !B64.test(f.sig)) return null;
    try { if (!verify(fromBase64Url(f.sig), pinSigned(this.id, pin), publicKeyFromZ32(f.k))) return null; } catch { return null; }
    return { member: f.k, pin, frame: { t: GROUP_PIN_FRAME, g: this.id, id: pin.id, n: pin.n, k: f.k, sig: f.sig } };
  }

  /** A signed leave: the admin removes its member; anyone else passes it on while that member is in the roster. */
  private async receiveBye(from: string, raw: unknown): Promise<void> {
    const f = raw as Record<string, unknown>;
    if (typeof f.k !== "string" || !MEMBER_KEY.test(f.k) || f.k === this.myKey || !rosterHas(this.roster, f.k) || !rosterHas(this.roster, from) ||
      !Number.isSafeInteger(f.e) || (f.e as number) < 0 || !Number.isSafeInteger(f.ts) || (f.ts as number) <= 0 || typeof f.sig !== "string" || f.sig.length !== 86 || !B64.test(f.sig)) return;
    const bye = { t: "group-bye" as const, g: this.id, k: f.k, e: f.e as number, ts: f.ts as number, sig: f.sig };
    try { if (!verify(fromBase64Url(bye.sig), byeSigned(bye), publicKeyFromZ32(bye.k))) return; } catch { return; }
    if (this.isAdmin) { await this.commit("remove", bye.k, Date.now()); return; }
    this.took(bye);
  }

  /**
   * A message, from its author's edge or handed on by another member. Handed on, it is taken only while both are in
   * the roster (someone removed is neither heard from nor handed on, #300), and its boxes only with the author's `xs`.
   */
  private async receiveMessage(from: string, raw: unknown): Promise<void> {
    if (!isMessageFrame(raw) || raw.s === this.myKey) return;
    const relayed = raw.s !== from;
    if (relayed && (!rosterHas(this.roster, from) || !rosterHas(this.roster, raw.s))) return;
    // Signed by its author before it may wait, so a frame no member wrote never takes the place of one that was.
    if (!verify(fromBase64Url(raw.sig), messageSigned(raw), publicKeyFromZ32(raw.s))) return;
    if (raw.e > this.epoch) { this.park(from, raw); return; }
    // Its replay window is gone (markSeen), even if a sparse set of secrets still holds its secret.
    if (raw.e < this.epoch - GROUP_LIMITS.secrets) return;
    const commit = this.state.chain[raw.e];
    // Not from a member of that epoch, or from before I was one: nothing to read, nothing to ask for.
    if (!commit || !rosterHas(commit.m, raw.s) || !rosterHas(commit.m, this.myKey)) return;
    if (this.isDuplicate(raw)) return;
    // Whole: from its author's own edge, or handed on with the author's signature over every field. Anything else a
    // member handing it on may have stripped (the mentions, the reply, the hop count): its text is shown, but it is
    // neither seen nor kept nor handed on, so a sync still asks for it and a whole copy completes it.
    const id = groupMessageId(raw.s, raw.e, raw.n);
    const whole = !relayed || this.wholeSigned(raw);
    if (!whole) {
      if (this.provisional.has(id)) return;
      delete raw.m; delete raw.r; delete raw.f; delete raw.xs;
    }
    const secret = this.secret(raw.e);
    if (!secret) { this.park(from, raw); return; }
    const key = epochKeys(secret, this.id, raw.e).message;
    const text = decryptText(key, messageAad(raw), raw.nn, raw.c);
    if (text === null) return;
    // Everyone is named only by the admin of the message's epoch; a box that does not open is no mentions, not no message.
    const mentions = this.openMentions(key, raw, text, rosterAdmin(commit.m) === raw.s);
    const reply = this.openReply(key, raw);
    const forwarded = readForwarded(raw.f);
    const completes = whole && this.provisional.delete(id);
    await this.hooks.message({ id, sender: raw.s, epoch: raw.e, seq: raw.n, timestamp: raw.ts, text, ...(mentions.length ? { mentions } : {}), ...(reply ? { reply } : {}), ...(forwarded ? { forwarded } : {}), ...(completes ? { completes: true as const } : {}) });
    if (!whole) {
      this.provisional.add(id);
      if (this.provisional.size > GROUP_LIMITS.provisional) this.provisional.delete(this.provisional.values().next().value!);
      this.state.provisional = [...this.provisional];
      await this.persist();
      return;
    }
    if (completes) this.state.provisional = [...this.provisional];
    this.markSeen(raw);
    this.keep(clean(raw));
    await this.persist();
    // Passed on only while its author is a member: someone removed is not carried for, even for epochs it was in.
    if (rosterHas(this.roster, raw.s)) this.took(clean(raw));
  }

  /**
   * An edit of a member's own message, from its author's edge or handed on by another member: believed only while its
   * author is still in the roster (someone removed edits nothing), and the member handing it on too; for an epoch the
   * author and I were both members of, with the author's signature over the whole frame and a box that opens. One for
   * an epoch or a secret not here yet waits, as a message does. Taken, it is kept to hand on in turn.
   */
  private async receiveEdit(from: string, raw: unknown): Promise<void> {
    if (!isEditFrame(raw) || raw.s === this.myKey || !rosterHas(this.roster, raw.s) || !rosterHas(this.roster, from)) return;
    if (!verify(fromBase64Url(raw.sig), editSigned(raw), publicKeyFromZ32(raw.s))) return;
    if (raw.e > this.epoch) { this.parkEdit(from, raw); return; }
    const commit = this.state.chain[raw.e];
    if (!commit || !rosterHas(commit.m, raw.s) || !rosterHas(commit.m, this.myKey)) return;
    const secret = this.secret(raw.e);
    if (!secret) { if (raw.e >= this.epoch - GROUP_LIMITS.secrets) this.parkEdit(from, raw); return; }
    const plain = decryptText(epochKeys(secret, this.id, raw.e).message, editAad(raw), raw.nn, raw.c);
    if (plain === null) return;
    let body: { text?: unknown; m?: unknown };
    try { body = JSON.parse(plain) as typeof body; } catch { return; }
    if (!body || typeof body !== "object" || !validEditText(body.text)) return;
    const k = validMentions(body.m, body.text, rosterAdmin(commit.m) === raw.s);
    await this.hooks.edit?.({ id: groupMessageId(raw.s, raw.e, raw.n), sender: raw.s, e: raw.v, ts: raw.ts, m: body.text, ...(k.length ? { k } : {}) });
    if (this.keepEdit(raw)) { await this.persist(); this.took(cleanEdit(raw)); }
  }

  private parkEdit(from: string, frame: GroupEditFrame): void {
    if (frame.e > this.epoch + GROUP_LIMITS.secrets) return;
    this.waitingEdits = [...this.waitingEdits.filter(w => !(w.frame.s === frame.s && w.frame.e === frame.e && w.frame.n === frame.n && w.frame.v <= frame.v)), { from, frame }]
      .slice(-GROUP_LIMITS.outlog);
    this.ask(from);
  }

  private wholeSigned(raw: GroupMessageFrame): boolean {
    if (typeof raw.xs !== "string" || raw.xs.length !== 86 || !B64.test(raw.xs)) return false;
    try { return verify(fromBase64Url(raw.xs), messageSignedWhole(raw), publicKeyFromZ32(raw.s)); } catch { return false; }
  }

  private openMentions(key: Uint8Array, raw: GroupMessageFrame, text: string, everyone: boolean): GroupMention[] {
    if (!isMentionsBox(raw.m)) return [];
    const plain = decryptText(key, mentionsAad(raw), raw.m.n, raw.m.c);
    if (plain === null) return [];
    try { return validMentions(JSON.parse(plain), text, everyone); } catch { return []; }
  }

  /** The message a text answers; a box that does not open, or does not hold one, is no reply, not no message. */
  private openReply(key: Uint8Array, raw: GroupMessageFrame): WireReply | undefined {
    if (!isReplyBox(raw.r)) return undefined;
    const plain = decryptText(key, replyAad(raw), raw.r.n, raw.r.c);
    if (plain === null) return undefined;
    try { return readReply(JSON.parse(plain), groupReplyAuthor); } catch { return undefined; }
  }

  private isDuplicate(f: GroupMessageFrame): boolean {
    const entry = this.state.seen[f.s]?.[f.e];
    if (!entry) return false;
    if (f.n > entry.high) return false;
    if (f.n <= entry.high - GROUP_LIMITS.window) return true;
    return f.n === entry.high || entry.window.includes(f.n);
  }
  private markSeen(f: GroupMessageFrame): void {
    const bySender = (this.state.seen[f.s] ??= {});
    const entry = (bySender[f.e] ??= { high: -1, window: [] });
    if (f.n > entry.high) {
      if (entry.high >= 0) entry.window.push(entry.high);
      entry.high = f.n;
    } else entry.window.push(f.n);
    entry.window = entry.window.filter(n => n > entry.high - GROUP_LIMITS.window);
    // Epochs older than what I can read are not worth a replay window.
    for (const e of Object.keys(bySender)) if (Number(e) < this.epoch - GROUP_LIMITS.secrets) delete bySender[e];
  }

  private park(from: string, frame: GroupMessageFrame): void {
    if (frame.e > this.epoch + GROUP_LIMITS.secrets) return;
    if (this.waiting.some(w => w.frame.s === frame.s && w.frame.e === frame.e && w.frame.n === frame.n)) return;
    this.waiting.push({ from, frame });
    this.waitingBytes += frame.c.length;
    while (this.waiting.length > GROUP_LIMITS.waiting || this.waitingBytes > GROUP_LIMITS.waitingBytes) this.waitingBytes -= this.waiting.shift()!.frame.c.length;
    this.ask(from);
  }

  /** Whoever sent something I cannot read yet is ahead of me, or holds a secret I lack: ask, but not in a loop. */
  private ask(from: string): void {
    const now = Date.now();
    if (now - (this.asked.get(from) ?? 0) < 10_000) return;
    this.asked.set(from, now);
    this.hooks.send(from, this.syncFrame());
  }

  private async replayWaiting(): Promise<void> {
    await this.metaFollowsChain();
    const ready = this.waiting.filter(w => w.frame.e <= this.epoch && !!this.state.secrets[w.frame.e]);
    this.waiting = this.waiting.filter(w => !ready.includes(w));
    this.waitingBytes = this.waiting.reduce((sum, w) => sum + w.frame.c.length, 0);
    for (const { from, frame } of ready) await this.receiveMessage(from, frame);
    // Edits after the messages they change.
    const edits = this.waitingEdits.filter(w => w.frame.e <= this.epoch && !!this.state.secrets[w.frame.e]);
    this.waitingEdits = this.waitingEdits.filter(w => !edits.includes(w));
    for (const { from, frame } of edits) await this.receiveEdit(from, frame);
  }

  private async receiveCommit(from: string, frame: GroupCommitFrame): Promise<void> {
    const raw = frame.commit as unknown as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.e)) return;
    const e = raw.e as number;
    if (e <= this.epoch) {
      // Known, or a different history of the same epoch: that is a fork, and nothing here picks a winner.
      const known = this.state.chain[e];
      const result = verifyCommit(raw, this.state.chain[e - 1] ?? null, this.id);
      // Evidence of a fork must come from whoever signed my commit for that epoch; at epoch 0 anyone can sign a genesis.
      if ("error" in result || result.commit.by !== known.by) return;
      if (commitHash(result.commit) !== commitHash(known)) await this.fork(`Member ${from.slice(0, 8)} holds a different membership history for epoch ${e}`);
      return;
    }
    if (e > this.epoch + 1) {
      // Kept to wait for the ones before it only when signed, by a member now: its place is not for anyone's junk.
      const signed = verifyCommitSignature(raw);
      if (signed && rosterHas(this.roster, signed.by) && this.pendingCommits.size < GROUP_LIMITS.pendingCommits) this.pendingCommits.set(e, frame);
      this.ask(from);
      return;
    }
    const result = verifyCommit(raw, this.top, this.id);
    if ("error" in result) {
      // The admin's valid signature on a commit that does not follow my chain is evidence of a fork; noise is just dropped.
      if (result.error.startsWith("Commit does not follow") && verifyCommitSignature(raw)?.by === this.admin) await this.fork(`Member ${from.slice(0, 8)} holds a different membership history for epoch ${e}`);
      return;
    }
    await this.apply(result.commit, frame.secret);
    this.took({ t: "group-commit", g: this.id, commit: result.commit });
    // Handed on by a hub, the commit carries no secret sealed for me: whoever handed it on holds it, and seals it to me.
    if (this.state.status === "active" && !this.state.secrets[this.epoch]) this.ask(from);
    const next = this.pendingCommits.get(this.epoch + 1);
    if (next) { this.pendingCommits.delete(this.epoch + 1); await this.receiveCommit(from, next); }
  }

  private async apply(commit: GroupCommit, sealed?: SealedSecret): Promise<void> {
    this.state.chain.push(commit);
    this.state.seq = 0; this.state.seqEpoch = commit.e;
    if (!rosterHas(commit.m, this.myKey)) {
      this.out("removed", "You were removed from this group");
      await this.persist();
      this.hooks.changed();
      return;
    }
    if (sealed) this.takeSecret(commit.e, sealed);
    this.pruneSecrets();
    this.pruneRelay();
    await this.persist();
    this.hooks.changed();
    await this.replayWaiting();
  }

  /** A sealed secret for an epoch of my chain: kept only when it confirms against that epoch's commit. */
  private takeSecret(epoch: number, sealed: unknown): boolean {
    const commit = this.state.chain[epoch];
    if (!commit || this.state.secrets[epoch] || !isSealed(sealed) || !rosterHas(commit.m, this.myKey)) return false;
    if (epoch < this.epoch - GROUP_LIMITS.secrets) return false;
    const secret = openSecret(this.identity.seed, this.myKey, sealed, secretAad(this.id, epoch, this.myKey));
    if (!secret || !confirmationMatches(epochKeys(secret, this.id, epoch).confirm, commitUntaggedHash(commit), commit.c)) return false;
    this.state.secrets[epoch] = toBase64Url(secret);
    return true;
  }

  private async receiveSecrets(frame: GroupSecretsFrame): Promise<void> {
    if (!Array.isArray(frame.secrets) || frame.secrets.length > GROUP_LIMITS.secrets) return;
    let taken = false;
    for (const entry of frame.secrets) {
      if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.e) || entry.e < 0 || entry.e > this.epoch) continue;
      taken = this.takeSecret(entry.e, entry.s) || taken;
    }
    if (!taken) return;
    await this.persist();
    this.hooks.changed();
    await this.replayWaiting();
  }

  private async receiveSync(from: string, frame: GroupSyncFrame): Promise<void> {
    if (!rosterHas(this.roster, from) || !Number.isSafeInteger(frame.e) || frame.e < 0 || typeof frame.h !== "string") return;
    // Each answer may carry the chain, secrets and logs: a few a minute per member, however often it asks.
    let answered = this.syncsAnswered.get(from);
    if (!answered) this.syncsAnswered.set(from, answered = new RateWindow(GROUP_LIMITS.syncAnswers, GROUP_LIMITS.syncWindowMs, () => this.hooks.clock?.() ?? Date.now()));
    if (!answered.take()) return;
    if (frame.e > this.epoch) { this.ask(from); this.offerMeta(from, frame.mt); return; }
    if (frame.h !== commitHash(this.state.chain[frame.e])) {
      // A claim is not a fork: they get my commit for that epoch, and fork on it if their own is validly signed and different.
      this.hooks.send(from, { t: "group-commit", g: this.id, commit: this.state.chain[frame.e] });
      return;
    }
    // Commits they lack, each with its secret sealed for them when they were in that roster and I still hold it.
    for (let e = frame.e + 1; e <= this.epoch; e++) {
      const commit = this.state.chain[e], secret = this.secret(e);
      this.hooks.send(from, { t: "group-commit", g: this.id, commit, ...(secret && rosterHas(commit.m, from) ? { secret: sealSecret(from, secret, secretAad(this.id, e, from)) } : {}) });
    }
    // Secrets of epochs they were in but do not hold, sixteen to a frame (what apps from before revision 0.9 take).
    const theirs = new Set(Array.isArray(frame.secrets) ? frame.secrets.filter(n => Number.isSafeInteger(n)) : []);
    const secrets = this.readableEpochs.filter(e => e <= frame.e && !theirs.has(e) && rosterHas(this.state.chain[e].m, from))
      .map(e => ({ e, s: sealSecret(from, this.secret(e)!, secretAad(this.id, e, from)) }));
    for (let i = 0; i < secrets.length; i += GROUP_LIMITS.secretsPerFrame) this.hooks.send(from, { t: "group-secrets", g: this.id, secrets: secrets.slice(i, i + GROUP_LIMITS.secretsPerFrame) });
    // Messages they have not seen, for epochs they were in: my own, from my bounded log, and those of the members they
    // asked me for (whose edges to them are down), from what I received. Signed by their authors, so nothing to trust me for.
    const lacks = missingIn(frame, from);
    for (const sent of this.state.sent) if (rosterHas(this.state.chain[sent.e].m, from) && lacks(sent)) this.hooks.send(from, sent);
    const asked = new Set(Array.isArray(frame.ask) ? frame.ask.filter(k => typeof k === "string" && k !== from && k !== this.myKey && rosterHas(this.roster, k)) : []);
    if (asked.size) for (const kept of this.state.relay ?? []) if (asked.has(kept.s) && this.state.chain[kept.e] && rosterHas(this.state.chain[kept.e].m, from) && lacks(kept)) this.hooks.send(from, kept);
    // Their latest edits too, after the messages they change (a sync says nothing of edits: one they have changes nothing).
    for (const author of asked) {
      const edits = (this.state.relayEdits ?? []).filter(f => f.s === author && this.state.chain[f.e] && rosterHas(this.state.chain[f.e].m, from));
      for (const edit of edits.slice(-GROUP_LIMITS.handOnEdits)) this.hooks.send(from, edit);
    }
    // The group's picture, when theirs is older (after the commits and secrets above, which it may need).
    this.offerMeta(from, frame.mt);
  }

  // -- metadata (WISP 9xx § Metadata) ---------------------------------------

  /** Sets (or, with null, removes) the group's picture: only the admin, signed under the current commit. */
  setPicture(picture: string | null, now = Date.now()): Promise<void> {
    return this.serialize(async () => {
      if (this.state.status !== "active") throw new Error("You are no longer in this group");
      if (!this.isAdmin) throw new Error("Only the admin can change the group's picture");
      await this.publishMeta(encodeGroupMetaBody({ ...groupMetaBody(this.state.meta), pic: picture ?? undefined }), now);
    });
  }

  /** Renames the group: only the admin, signed under the current commit, beside the picture and the hubs. */
  rename(name: string, now = Date.now()): Promise<void> {
    return this.serialize(async () => {
      if (this.state.status !== "active") throw new Error("You are no longer in this group");
      if (!this.isAdmin) throw new Error("Only the admin can rename the group");
      const body = encodeGroupMetaBody({ ...groupMetaBody(this.state.meta), name });
      if (body !== this.state.meta?.body) await this.publishMeta(body, now);
    });
  }

  /**
   * Pins a member as a hub, excludes one from being a hub, or leaves it to the member's app (`null`): only the admin,
   * in the group's metadata beside the picture (WISP 9xx · Group Mesh § Hubs).
   */
  setHub(key: string, role: "pin" | "exclude" | null, now = Date.now()): Promise<void> {
    return this.serialize(async () => {
      if (this.state.status !== "active") throw new Error("You are no longer in this group");
      if (!this.isAdmin) throw new Error("Only the admin can choose the group's hubs");
      if (!rosterHas(this.roster, key)) throw new Error("Not a member");
      const current = this.hubPolicy;
      const policy = { pin: current.pin.filter(k => k !== key && rosterHas(this.roster, k)), no: current.no.filter(k => k !== key && rosterHas(this.roster, k)) };
      if (role === "pin") policy.pin.push(key);
      if (role === "exclude") policy.no.push(key);
      if (policy.pin.length > MESH_HUBS.pinned) throw new Error(`At most ${MESH_HUBS.pinned} members can be pinned as hubs`);
      await this.publishMeta(encodeGroupMetaBody({ ...groupMetaBody(this.state.meta), hubs: policy }), now);
    });
  }

  /** Signs a body under my current commit, keeps it and sends it to every member. Inside `serialize`. */
  private async publishMeta(body: string, now: number): Promise<void> {
    const before = this.state.meta;
    const meta = signGroupMeta({ g: this.id, e: this.epoch, h: commitHash(this.top), r: (before?.r ?? 0) + 1, ts: now }, body, this.identity.seed, this.myKey);
    this.state.meta = meta;
    await this.persist();
    const secret = this.secret(this.epoch);
    if (secret) {
      const frame = wrapGroupMeta(meta, this.epoch, epochKeys(secret, this.id, this.epoch).message);
      for (const key of this.others) this.hooks.send(key, frame);
    }
    const change = groupMetaChange(before, meta);
    if (change) this.hooks.metaChanged?.(this.myKey, change);
    this.hooks.changed();
  }

  /** My statement, to a member whose sync says it holds an older one (or none); nothing to an app that says nothing. */
  private offerMeta(to: string, theirTag: unknown): void {
    const meta = this.state.meta, theirs = parseGroupMetaTag(theirTag);
    if (!meta || theirs === null || !groupMetaNewer(meta, theirs) || !rosterHas(this.roster, to)) return;
    const secret = this.secret(this.epoch);
    if (secret) this.hooks.send(to, wrapGroupMeta(meta, this.epoch, epochKeys(secret, this.id, this.epoch).message));
  }

  /**
   * A metadata statement: kept when it is newer than mine, its commit is on my chain, its signer was
   * the admin of that commit and is the admin now, its signature holds, and it opens under the epoch
   * it names into metadata Ghostly shows. One naming what I do not have yet waits for the chain.
   */
  private async receiveMeta(from: string, raw: unknown): Promise<void> {
    const frame = parseGroupMetaFrame(raw);
    if (!frame || frame.statement.g !== this.id || typeof frame.k !== "number" || !rosterHas(this.roster, from)) return;
    const s = frame.statement;
    if (!groupMetaNewer(s, this.state.meta)) return;
    if (s.e > this.epoch || frame.k > this.epoch) { this.pendingMeta = { from, frame: raw }; this.ask(from); return; }
    const commit = this.state.chain[s.e];
    if (commitHash(commit) !== s.h || rosterAdmin(commit.m) !== s.by || this.admin !== s.by || !verifyGroupMetaSignature(s)) return;
    const secret = this.secret(frame.k);
    if (!secret) { this.pendingMeta = { from, frame: raw }; this.ask(from); return; }
    const opened = openGroupMeta(frame, epochKeys(secret, this.id, frame.k).message);
    if (!opened) return;
    const before = this.state.meta;
    this.state.meta = opened.meta;
    await this.persist();
    // A change of hubs alone is no line in the history.
    const change = groupMetaChange(before, opened.meta);
    if (change) this.hooks.metaChanged?.(s.by, change);
    this.hooks.changed();
    this.took({ t: "group-meta", ...s, k: frame.k as number, nn: frame.nn, c: frame.c });
  }

  /** After the chain or my secrets moved: the waiting statement, and, if I became the admin, the name and picture signed again as mine. */
  private async metaFollowsChain(): Promise<void> {
    const pending = this.pendingMeta;
    this.pendingMeta = undefined;
    if (pending) await this.receiveMeta(pending.from, pending.frame);
    // Joiners accept only the current admin's statement: a new admin signs the picture again.
    if (this.isAdmin && this.state.meta && this.state.meta.by !== this.myKey) await this.publishMeta(this.state.meta.body, Date.now());
  }

  private async fork(reason: string): Promise<void> {
    if (this.state.status !== "active") return;
    this.state.status = "forked";
    this.state.statusReason = `${reason}. Membership changes are halted; the admin must re-form the group.`;
    await this.persist();
    this.hooks.changed();
  }
}
