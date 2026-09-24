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
  secrets: 16,
  /** Per sender and epoch, the sequence numbers remembered below the highest seen. */
  window: 256,
  /** Commits ahead of the chain kept while the gap is fetched. */
  pendingCommits: 16,
  /** Commits carried in one welcome or chain frame. */
  chainPiece: 24,
} as const;

/** What every member should know about who can read what, in the words the apps show. */
export const GROUP_READ_NOTE = `Everyone in the group can read everything sent while they are a member. Someone removed keeps what they already received and cannot read what comes after; someone who joins later cannot read what came before. Messages go directly to each member; whoever was away gets the last ${GROUP_LIMITS.outlog} messages from each member when they meet again.`;

export interface GroupMessageFrame { t: "group-msg"; g: string; e: number; s: string; n: number; ts: number; nn: string; c: string; sig: string }
export interface GroupCommitFrame { t: "group-commit"; g: string; commit: GroupCommit; secret?: SealedSecret }
export interface GroupSyncFrame { t: "group-sync"; g: string; e: number; h: string; have: Record<string, Record<string, number>>; secrets: number[] }
export interface GroupSecretsFrame { t: "group-secrets"; g: string; secrets: { e: number; s: SealedSecret }[] }
export interface GroupLeaveFrame { t: "group-leave"; g: string }
export interface GroupInviteFrame { t: "group-invite"; g: string; name: string; admin: string; e: number; n: number }
export interface GroupAcceptFrame { t: "group-accept"; g: string; key: string }
export interface GroupDeclineFrame { t: "group-decline"; g: string }
export interface GroupChainFrame { t: "group-chain"; g: string; commits: GroupCommit[] }
export interface GroupWelcomeFrame { t: "group-welcome"; g: string; name: string; commits: GroupCommit[]; secrets: { e: number; s: SealedSecret }[] }
export interface GroupRemovedFrame { t: "group-removed"; g: string }
export type GroupEdgeFrame = GroupMessageFrame | GroupCommitFrame | GroupSyncFrame | GroupSecretsFrame | GroupLeaveFrame;
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
  /** Sender → epoch → highest sequence seen and the ones seen below it. */
  seen: Record<string, Record<string, { high: number; window: number[] }>>;
  /** Names members announced on their edges. */
  nicks: Record<string, string>;
}

export interface GroupIncomingMessage { id: string; sender: string; epoch: number; seq: number; timestamp: number; text: string }

export interface GroupSessionHooks {
  save(state: GroupState): Promise<void>;
  /** Best effort, over the pairwise edge to that member if it is open. */
  send(to: string, frame: GroupEdgeFrame): void;
  /** Store before it resolves: replay state advances only afterwards. */
  message(message: GroupIncomingMessage): Promise<void> | void;
  /** Roster, epoch or status changed. */
  changed(): void;
}

const MAX_TEXT_BOX = Math.ceil((GROUP_LIMITS.textBytes + 16) * 4 / 3) + 4;
const B64 = /^[A-Za-z0-9_-]*$/;
const secretAad = (g: string, e: number, member: string) => JSON.stringify(["ghostly-group/1 secret", g, e, member]);
const messageAad = (f: Pick<GroupMessageFrame, "g" | "e" | "s" | "n" | "ts">) => JSON.stringify([f.g, f.e, f.s, f.n, f.ts]);
const messageSigned = (f: Omit<GroupMessageFrame, "sig" | "t">) => utf8Encode(JSON.stringify(["ghostly-group/1 msg", f.g, f.e, f.s, f.n, f.ts, f.nn, f.c]));
export const groupMessageId = (sender: string, epoch: number, seq: number) => `${sender}:${epoch}:${seq}`;

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

export class GroupSession {
  readonly state: GroupState;
  private readonly identity;
  /** Frames for an epoch, or a secret, not here yet. In memory only. */
  private waiting: { from: string; frame: GroupMessageFrame }[] = [];
  private waitingBytes = 0;
  private pendingCommits = new Map<number, GroupCommitFrame>();
  /** When each member was last asked to catch me up, so a stream of unreadable frames is one question, not a loop. */
  private asked = new Map<string, number>();
  private queue = Promise.resolve();

  constructor(state: GroupState, private readonly hooks: GroupSessionHooks) {
    this.state = state;
    this.identity = identityFromSeedB64(state.seedB64);
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
  get name(): string { return this.state.name; }
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
      const chain = this.state.chain;
      const frames: (GroupChainFrame | GroupWelcomeFrame)[] = [];
      for (let i = 0; i < chain.length - GROUP_LIMITS.chainPiece; i += GROUP_LIMITS.chainPiece)
        frames.push({ t: "group-chain", g: this.id, commits: chain.slice(i, i + GROUP_LIMITS.chainPiece) });
      const tail = chain.length % GROUP_LIMITS.chainPiece || GROUP_LIMITS.chainPiece;
      frames.push({ t: "group-welcome", g: this.id, name: this.name, commits: chain.slice(chain.length - tail), secrets: [sealed] });
      return frames;
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
    this.waiting = []; this.waitingBytes = 0; this.pendingCommits.clear();
  }

  /** Encrypts and signs a text, keeps it for catch-up and sends it to every other member. */
  sendText(text: string, now = Date.now()): Promise<{ id: string } | { error: string }> {
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
      const { n: nn, c } = encryptText(epochKeys(secret, this.id, epoch).message, messageAad(header), trimmed);
      const unsigned = { ...header, nn, c };
      const frame: GroupMessageFrame = { t: "group-msg", ...unsigned, sig: toBase64Url(sign(messageSigned(unsigned), this.identity.seed)) };
      this.state.sent.push(frame);
      let bytes = this.state.sent.reduce((sum, f) => sum + f.c.length, 0);
      while (this.state.sent.length > GROUP_LIMITS.outlog || bytes > GROUP_LIMITS.outlogBytes) bytes -= this.state.sent.shift()!.c.length;
      const id = groupMessageId(this.myKey, epoch, n);
      await this.hooks.message({ id, sender: this.myKey, epoch, seq: n, timestamp: now, text: trimmed });
      await this.persist();
      for (const key of this.others) this.hooks.send(key, frame);
      return { id };
    });
  }

  /** What to tell a member whose edge just opened: where I am, and what I have from everyone. */
  syncFrame(): GroupSyncFrame {
    const have: Record<string, Record<string, number>> = {};
    for (const [sender, epochs] of Object.entries(this.state.seen)) {
      have[sender] = {};
      for (const [e, entry] of Object.entries(epochs)) have[sender][e] = entry.high;
    }
    return { t: "group-sync", g: this.id, e: this.epoch, h: commitHash(this.top), have, secrets: this.readableEpochs };
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

  /** A frame from an authenticated member over the pairwise edge. Anything malformed or unauthorized is dropped. */
  handle(from: string, raw: unknown): Promise<void> {
    return this.serialize(async () => {
      if (this.state.status !== "active" || !raw || typeof raw !== "object") return;
      const frame = raw as Record<string, unknown>;
      if (frame.g !== this.id) return;
      switch (frame.t) {
        case "group-msg": return this.receiveMessage(from, raw);
        case "group-commit": return this.receiveCommit(from, raw as GroupCommitFrame);
        case "group-sync": return this.receiveSync(from, raw as GroupSyncFrame);
        case "group-secrets": return this.receiveSecrets(raw as GroupSecretsFrame);
        case "group-leave": if (this.isAdmin && rosterHas(this.roster, from) && from !== this.myKey) await this.commit("remove", from, Date.now()); return;
      }
    });
  }

  private async receiveMessage(from: string, raw: unknown): Promise<void> {
    if (!isMessageFrame(raw) || raw.s !== from || raw.s === this.myKey) return;
    if (raw.e > this.epoch) { this.park(from, raw); return; }
    const commit = this.state.chain[raw.e];
    // Not from a member of that epoch, or from before I was one: nothing to read, nothing to ask for.
    if (!commit || !rosterHas(commit.m, raw.s) || !rosterHas(commit.m, this.myKey)) return;
    if (this.isDuplicate(raw)) return;
    if (!verify(fromBase64Url(raw.sig), messageSigned(raw), publicKeyFromZ32(raw.s))) return;
    const secret = this.secret(raw.e);
    if (!secret) { this.park(from, raw); return; }
    const text = decryptText(epochKeys(secret, this.id, raw.e).message, messageAad(raw), raw.nn, raw.c);
    if (text === null) return;
    await this.hooks.message({ id: groupMessageId(raw.s, raw.e, raw.n), sender: raw.s, epoch: raw.e, seq: raw.n, timestamp: raw.ts, text });
    this.markSeen(raw);
    await this.persist();
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
    const ready = this.waiting.filter(w => w.frame.e <= this.epoch && !!this.state.secrets[w.frame.e]);
    if (!ready.length) return;
    this.waiting = this.waiting.filter(w => !ready.includes(w));
    this.waitingBytes = this.waiting.reduce((sum, w) => sum + w.frame.c.length, 0);
    for (const { from, frame } of ready) await this.receiveMessage(from, frame);
  }

  private async receiveCommit(from: string, frame: GroupCommitFrame): Promise<void> {
    const raw = frame.commit as unknown as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.e)) return;
    const e = raw.e as number;
    if (e <= this.epoch) {
      // Known, or a different history of the same epoch: that is a fork, and nothing here picks a winner.
      const known = this.state.chain[e];
      const result = verifyCommit(raw, this.state.chain[e - 1] ?? null, this.id);
      if ("error" in result) return;
      if (commitHash(result.commit) !== commitHash(known)) await this.fork(`Member ${from.slice(0, 8)} holds a different membership history for epoch ${e}`);
      return;
    }
    if (e > this.epoch + 1) {
      if (this.pendingCommits.size < GROUP_LIMITS.pendingCommits) this.pendingCommits.set(e, frame);
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
    if (frame.e > this.epoch) { this.ask(from); return; }
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
    // Secrets of epochs they were in but do not hold.
    const theirs = new Set(Array.isArray(frame.secrets) ? frame.secrets.filter(n => Number.isSafeInteger(n)) : []);
    const secrets = this.readableEpochs.filter(e => e <= frame.e && !theirs.has(e) && rosterHas(this.state.chain[e].m, from))
      .map(e => ({ e, s: sealSecret(from, this.secret(e)!, secretAad(this.id, e, from)) }));
    if (secrets.length) this.hooks.send(from, { t: "group-secrets", g: this.id, secrets });
    // My own messages they have not seen, from my bounded log. Only the author re-sends.
    const have = frame.have && typeof frame.have === "object" ? (frame.have as Record<string, Record<string, unknown>>)[this.myKey] ?? {} : {};
    for (const sent of this.state.sent) {
      const high = have[sent.e];
      if (rosterHas(this.state.chain[sent.e].m, from) && (!Number.isSafeInteger(high) || (high as number) < sent.n)) this.hooks.send(from, sent);
    }
  }

  private async fork(reason: string): Promise<void> {
    if (this.state.status !== "active") return;
    this.state.status = "forked";
    this.state.statusReason = `${reason}. Membership changes are halted; the admin must re-form the group.`;
    await this.persist();
    this.hooks.changed();
  }
}
