import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBase64Url, toBase64Url, utf8Encode } from "../src/bytes";
import { confirmationTag, encryptText, epochKeys, newEpochSecret, sealSecret } from "../src/groupCrypto";
import { MAX_GROUP_CHAIN, MAX_GROUP_MEMBERS, commitHash, commitUntaggedHash, signCommit, type GroupCommit, type Roster } from "../src/groupCommits";
import { createIdentity, identityFromSeedB64, sign } from "../src/identity";
import {
  GROUP_LIMITS, GroupSession, type GroupCommitFrame, type GroupEdgeFrame, type GroupIncomingMessage, type GroupMessageFrame, type GroupState,
} from "../src/groupSession";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const secretAad = (g: string, e: number, member: string) => JSON.stringify(["ghostly-group/1 secret", g, e, member]);

/** Members wired back to back; an edge delivers unless cut. Every frame sent is recorded, delivered or not. */
class Net {
  readonly sessions = new Map<string, GroupSession>();
  readonly inbox = new Map<string, GroupIncomingMessage[]>();
  readonly sent: { from: string; to: string; frame: GroupEdgeFrame }[] = [];
  readonly saves = new Map<string, number>();
  readonly changes = new Map<string, number>();
  private cut = new Set<string>();
  private pending: Promise<unknown>[] = [];
  private key(a: string, b: string) { return [a, b].sort().join("|"); }
  setEdge(a: GroupSession, b: GroupSession, open: boolean) { if (open) this.cut.delete(this.key(a.myKey, b.myKey)); else this.cut.add(this.key(a.myKey, b.myKey)); }
  add(state: GroupState): GroupSession {
    const session: GroupSession = new GroupSession(state, {
      save: async () => { this.saves.set(session.myKey, (this.saves.get(session.myKey) ?? 0) + 1); },
      send: (to, frame) => {
        this.sent.push({ from: session.myKey, to, frame: clone(frame) });
        const target = this.sessions.get(to);
        if (target && !this.cut.has(this.key(session.myKey, to))) this.pending.push(target.handle(session.myKey, clone(frame)));
      },
      message: m => { this.inbox.get(session.myKey)!.push(m); },
      changed: () => { this.changes.set(session.myKey, (this.changes.get(session.myKey) ?? 0) + 1); },
    });
    this.sessions.set(session.myKey, session);
    this.inbox.set(session.myKey, []);
    return session;
  }
  async settle() { while (this.pending.length) await Promise.all(this.pending.splice(0)); }
  texts(s: GroupSession) { return this.inbox.get(s.myKey)!.map(m => m.text); }
}

async function join(net: Net, admin: GroupSession): Promise<GroupSession> {
  const seed = createIdentity().seedB64;
  const frames = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
  const joined = GroupSession.join({ name: admin.name, admin: admin.myKey }, frames.slice(0, -1), frames[frames.length - 1], seed);
  if ("error" in joined) throw new Error(joined.error);
  const session = net.add(joined.state);
  await net.settle();
  return session;
}

async function trio() {
  const net = new Net();
  const alice = net.add(GroupSession.create("Ghosts"));
  const bob = await join(net, alice), carol = await join(net, alice);
  return { net, alice, bob, carol };
}

/** A message frame signed by the member whose state is given, with any header or ciphertext. */
function forgeMessage(state: GroupState, o: { e?: number; n: number; ts?: number; text?: string; c?: string }): GroupMessageFrame {
  const id = identityFromSeedB64(state.seedB64);
  const e = o.e ?? state.chain[state.chain.length - 1].e, ts = o.ts ?? 1_000, g = state.id, s = id.pubKeyZ32, n = o.n;
  const secret = state.secrets[e] ? fromBase64Url(state.secrets[e]) : newEpochSecret();
  const box = encryptText(epochKeys(secret, g, e).message, JSON.stringify([g, e, s, n, ts]), o.text ?? "forged");
  const c = o.c ?? box.c;
  const sig = toBase64Url(sign(utf8Encode(JSON.stringify(["ghostly-group/1 msg", g, e, s, n, ts, box.n, c])), id.seed));
  return { t: "group-msg", g, e, s, n, ts, nn: box.n, c, sig };
}

/** A commit following `previous`, signed by whoever holds `seedB64`. */
function forgeCommit(previous: GroupCommit, seedB64: string, kind: GroupCommit["k"], m: Roster, o: { s?: string; p?: string; secret?: Uint8Array } = {}): GroupCommit {
  const id = identityFromSeedB64(seedB64);
  const draft = { v: 1 as const, g: previous.g, e: previous.e + 1, p: o.p ?? commitHash(previous), k: kind, m, by: id.pubKeyZ32, ...(o.s ? { s: o.s } : {}), ts: 5 };
  return signCommit({ ...draft, c: confirmationTag(epochKeys(o.secret ?? newEpochSecret(), draft.g, draft.e).confirm, commitUntaggedHash(draft)) }, id.seed);
}

afterEach(() => { vi.useRealTimers(); });

describe("joining from a welcome", () => {
  async function welcome() {
    const net = new Net();
    const alice = net.add(GroupSession.create("Ghosts"));
    const seed = createIdentity().seedB64, key = identityFromSeedB64(seed).pubKeyZ32;
    const frames = await alice.admit(key);
    return { alice, seed, key, w: clone(frames[frames.length - 1]) as unknown as Record<string, unknown>, invite: { name: "Ghosts", admin: alice.myKey } };
  }

  it("refuses welcomes that are not well-formed objects", async () => {
    const { seed, w, invite } = await welcome();
    for (const bad of [null, "welcome", 7, { ...w, t: "group-invite" }, { ...w, g: "short" }, { ...w, g: 5 }, { ...w, commits: "x" }, { ...w, secrets: {} }]) {
      expect(GroupSession.join(invite, [], bad, seed)).toEqual({ error: "Malformed welcome" });
    }
  });

  it("refuses a chain longer than the chain limit before verifying any of it", async () => {
    const { seed, w, invite } = await welcome();
    const pieces = [{ commits: new Array(MAX_GROUP_CHAIN).fill((w.commits as unknown[])[0]) }];
    expect(GroupSession.join(invite, pieces, w, seed)).toEqual({ error: "Membership chain too long" });
  });

  it("ignores pieces that carry no commits, and refuses a chain that does not verify", async () => {
    const { seed, w, invite } = await welcome();
    expect(GroupSession.join(invite, [null, 5, { commits: "no" }, {}], w, seed)).toHaveProperty("state");
    expect(GroupSession.join(invite, [], { ...w, commits: [] }, seed)).toEqual({ error: "Malformed membership chain" });
    const commits = clone(w.commits as GroupCommit[]);
    commits[1].ts += 1;
    expect(GroupSession.join(invite, [], { ...w, commits }, seed)).toEqual({ error: "Membership commit signature is invalid" });
    // A welcome whose chain belongs to another group than it names.
    expect(GroupSession.join(invite, [], { ...w, g: toBase64Url(new Uint8Array(16)) }, seed)).toEqual({ error: "Commit for another group" });
  });

  it("refuses a chain that admits somebody else, or one where this key was never added", async () => {
    const { alice, seed, w, invite } = await welcome();
    expect(GroupSession.join(invite, [], w, createIdentity().seedB64)).toEqual({ error: "The welcome does not admit this member key" });
    // The creator's own genesis puts it in the roster without an "add": that is not an admission.
    const creator = { t: "group-welcome", g: alice.id, name: "x", commits: [alice.state.chain[0]], secrets: [] };
    expect(GroupSession.join(invite, [], creator, alice.state.seedB64)).toEqual({ error: "The group's admin is not the contact who invited you" });
    expect(GroupSession.join({ ...invite, admin: createIdentity().pubKeyZ32 }, [], w, seed)).toEqual({ error: "The group's admin is not the contact who invited you" });
  });

  it("skips secrets that are malformed, out of range, sealed to someone else or not the commit's, and needs the current one", async () => {
    const { alice, seed, key, w, invite } = await welcome();
    const good = (w.secrets as { e: number; s: unknown }[])[0];
    const other = createIdentity().pubKeyZ32;
    const junk = [
      null, 5, { e: "1", s: good.s }, { e: -1, s: good.s }, { e: 0, s: good.s }, { e: 9, s: good.s }, { e: 1, s: { e: "!", n: "", c: "" } },
      { e: 1, s: { ...(good.s as object), c: "A".repeat(129) } },
      { e: 1, s: sealSecret(other, newEpochSecret(), secretAad(alice.id, 1, other)) },
      // Sealed to me with the right context, but not the secret the commit confirms.
      { e: 1, s: sealSecret(key, newEpochSecret(), secretAad(alice.id, 1, key)) },
    ];
    expect(GroupSession.join(invite, [], { ...w, secrets: junk }, seed)).toEqual({ error: "The welcome carries no usable secret for the current epoch" });
    const joined = GroupSession.join(invite, [], { ...w, secrets: [...junk, good] }, seed);
    expect("state" in joined && Object.keys(joined.state.secrets)).toEqual(["1"]);
  });

  it("names the group from the welcome, falling back to the invitation when the welcome's name is unusable", async () => {
    const { seed, w, invite } = await welcome();
    const named = (name: unknown) => { const r = GroupSession.join({ ...invite, name: "From invite" }, [], { ...w, name }, seed); return "state" in r ? r.state.name : r.error; };
    expect(named("  Spooky\u202e ")).toBe("Spooky");
    expect(named(42)).toBe("From invite");
    expect(named("\u200b\u202e")).toBe("From invite");
  });

  it("takes every secret it was given for the epochs since its admission", async () => {
    const net = new Net();
    const alice = net.add(GroupSession.create("Ghosts"));
    const seed = createIdentity().seedB64, key = identityFromSeedB64(seed).pubKeyZ32;
    const frames = await alice.admit(key);
    await alice.rotate();
    const w = clone(frames[frames.length - 1]) as unknown as { commits: GroupCommit[]; secrets: { e: number; s: unknown }[] };
    const rotated = alice.state.chain[2];
    w.commits.push(rotated);
    w.secrets.push({ e: 2, s: sealSecret(key, fromBase64Url(alice.state.secrets[2]), secretAad(alice.id, 2, key)) });
    const joined = GroupSession.join({ name: "Ghosts", admin: alice.myKey }, [], w, seed);
    expect("state" in joined && Object.keys(joined.state.secrets).sort()).toEqual(["1", "2"]);
  });

  it("names a new group 'Group' when its name has nothing visible", () => {
    expect(GroupSession.create("\u200b").name).toBe("Group");
    expect(GroupSession.create("  Ghosts ").name).toBe("Ghosts");
  });

  it("sends the whole chain in the welcome when it fills exactly one piece", async () => {
    const net = new Net();
    const alice = net.add(GroupSession.create("Ghosts"));
    for (let i = 0; i < GROUP_LIMITS.chainPiece - 2; i++) await alice.rotate();
    const seed = createIdentity().seedB64;
    const frames = await alice.admit(identityFromSeedB64(seed).pubKeyZ32);
    expect(alice.state.chain).toHaveLength(GROUP_LIMITS.chainPiece);
    expect(frames).toHaveLength(1);
    expect(GroupSession.join({ name: "Ghosts", admin: alice.myKey }, [], frames[0], seed)).toHaveProperty("state");
  });
});

describe("admin actions and their refusals", () => {
  it("refuses bad member keys, the admin itself, and existing members", async () => {
    const { alice, bob } = await trio();
    await expect(alice.admit("not-a-key")).rejects.toThrow("Invalid member key");
    await expect(alice.admit(alice.myKey)).rejects.toThrow("Invalid member key");
    await expect(alice.admit(bob.myKey)).rejects.toThrow("Already a member");
    await expect(alice.remove(createIdentity().pubKeyZ32)).rejects.toThrow("Not a member");
    await expect(alice.remove(alice.myKey)).rejects.toThrow("Not a member");
    await expect(alice.transferAdmin(createIdentity().pubKeyZ32)).rejects.toThrow("Not a member");
    await expect(alice.transferAdmin(alice.myKey)).rejects.toThrow("Not a member");
    await expect(bob.rotate()).rejects.toThrow("Only the admin can change the members of this group");
    expect(() => bob.inviteFrame()).toThrow("Only the admin");
  });

  it("refuses a ninth member", async () => {
    const net = new Net();
    const alice = net.add(GroupSession.create("Ghosts"));
    for (let i = 1; i < MAX_GROUP_MEMBERS; i++) await alice.admit(createIdentity().pubKeyZ32);
    expect(alice.roster).toHaveLength(MAX_GROUP_MEMBERS);
    await expect(alice.admit(createIdentity().pubKeyZ32)).rejects.toThrow("This change is not allowed");
    expect(alice.roster).toHaveLength(MAX_GROUP_MEMBERS);
  });

  it("refuses any change once the membership history is full", async () => {
    const state = GroupSession.create("Ghosts");
    state.chain = new Array(MAX_GROUP_CHAIN).fill(state.chain[0]);
    const alice = new Net().add(state);
    await expect(alice.rotate()).rejects.toThrow(/membership history limit/);
  });

  it("refuses admin actions after leaving, and an admin alone may leave without telling anyone", async () => {
    const net = new Net();
    const alice = net.add(GroupSession.create("Ghosts"));
    await alice.leave();
    expect(alice.status).toBe("left");
    expect(net.sent).toEqual([]);
    expect(() => alice.inviteFrame()).toThrow("You are no longer in this group");
    await expect(alice.rotate()).rejects.toThrow("You are no longer in this group");
    // Leaving twice is a no-op.
    const saves = net.saves.get(alice.myKey);
    await alice.leave();
    expect(net.saves.get(alice.myKey)).toBe(saves);
  });

  it("marks itself removed when told out of band, once, and drops its secrets and log", async () => {
    const { net, bob } = await trio();
    await bob.sendText("before");
    await bob.markRemoved();
    expect(bob.status).toBe("removed");
    expect(bob.state.statusReason).toBe("You were removed from this group");
    expect(bob.state.secrets).toEqual({});
    expect(bob.state.sent).toEqual([]);
    const saves = net.saves.get(bob.myKey);
    await bob.markRemoved();
    await bob.leave();
    expect(net.saves.get(bob.myKey)).toBe(saves);
    expect(await bob.sendText("after")).toEqual({ error: "You were removed from this group" });
  });
});

describe("sending text", () => {
  it("refuses empty text and text over 16 KiB, and accepts exactly 16 KiB", async () => {
    const { alice } = await trio();
    expect(await alice.sendText("   \n")).toEqual({ error: "Nothing to send" });
    expect(await alice.sendText("a".repeat(GROUP_LIMITS.textBytes + 1))).toEqual({ error: "Message exceeds 16 KiB" });
    expect(await alice.sendText("é".repeat(GROUP_LIMITS.textBytes / 2) + "a")).toEqual({ error: "Message exceeds 16 KiB" });
    expect(await alice.sendText("a".repeat(GROUP_LIMITS.textBytes))).toHaveProperty("id");
  });

  it("refuses to send without the current epoch's secret", async () => {
    const { bob } = await trio();
    const state = clone(bob.state);
    delete state.secrets[bob.epoch];
    expect(await new Net().add(state).sendText("hi")).toEqual({ error: expect.stringMatching(/key has not arrived/) });
  });

  it("uses the generic reason when a stopped state carries none", async () => {
    const { bob } = await trio();
    const state = { ...clone(bob.state), status: "left" as const, statusReason: undefined };
    expect(await new Net().add(state).sendText("hi")).toEqual({ error: "You are no longer in this group" });
  });

  it("restarts its sequence when its saved sequence belongs to another epoch", async () => {
    const { bob } = await trio();
    const state = { ...clone(bob.state), seq: 9, seqEpoch: 0 };
    const restored = new Net().add(state);
    expect(await restored.sendText("hi")).toEqual({ id: `${bob.myKey}:${bob.epoch}:0` });
  });

  it("bounds its catch-up log by total bytes as well as by count", async () => {
    const { net, alice, bob } = await trio();
    net.setEdge(alice, bob, false);
    for (let i = 0; i < 10; i++) await alice.sendText(`${i}`.padEnd(GROUP_LIMITS.textBytes, "x"));
    const bytes = alice.state.sent.reduce((sum, f) => sum + f.c.length, 0);
    expect(bytes).toBeLessThanOrEqual(GROUP_LIMITS.outlogBytes);
    expect(alice.state.sent.length).toBeLessThan(10);
    expect(alice.state.sent.at(-1)!.n).toBe(9);
  });
});

describe("receiving messages", () => {
  it("ignores frames when stopped, frames that are not objects, frames for another group and unknown frame types", async () => {
    const { net, alice, bob } = await trio();
    const frame = forgeMessage(alice.state, { n: 50, text: "ok" });
    for (const raw of [null, "frame", 1, { ...frame, g: toBase64Url(new Uint8Array(16)) }, { ...frame, t: "group-bogus" }]) await bob.handle(alice.myKey, raw);
    expect(net.texts(bob)).toEqual([]);
    await bob.handle(alice.myKey, frame);
    expect(net.texts(bob)).toEqual(["ok"]);
    await bob.markRemoved();
    await bob.handle(alice.myKey, forgeMessage(alice.state, { n: 51 }));
    expect(net.texts(bob)).toEqual(["ok"]);
  });

  it.each([
    ["a nonce of the wrong length", { nn: "A".repeat(31) }],
    ["a ciphertext with a bad character", { c: "+" }],
    ["an oversized ciphertext", { c: "A".repeat(Math.ceil((GROUP_LIMITS.textBytes + 16) * 4 / 3) + 5) }],
    ["a short signature", { sig: "A".repeat(85) }],
    ["a negative sequence", { n: -1 }],
    ["a zero timestamp", { ts: 0 }],
    ["a sender that is not a key", { s: "alice" }],
    ["a string epoch", { e: "2" }],
  ])("drops a message frame with %s", async (_, patch) => {
    const { net, alice, bob } = await trio();
    await bob.handle(alice.myKey, { ...forgeMessage(alice.state, { n: 0 }), ...patch });
    expect(net.texts(bob)).toEqual([]);
    expect(bob.state.seen).toEqual({});
  });

  it("drops a validly signed frame whose ciphertext does not open, and still reads the real one after", async () => {
    const { net, alice, bob } = await trio();
    const real = forgeMessage(alice.state, { n: 0, text: "real" });
    await bob.handle(alice.myKey, forgeMessage(alice.state, { n: 0, c: real.c.slice(0, -4) + "AAAA" }));
    expect(net.texts(bob)).toEqual([]);
    await bob.handle(alice.myKey, real);
    expect(net.texts(bob)).toEqual(["real"]);
  });

  it("drops a message signed by a member for an epoch they were not in", async () => {
    const { net, bob, carol } = await trio();
    // Carol joined at epoch 2; a frame from her claiming epoch 1, even under that epoch's key, is not hers to send.
    await bob.handle(carol.myKey, forgeMessage({ ...carol.state, secrets: { 1: bob.state.secrets[1] } }, { e: 1, n: 0, text: "impostor" }));
    expect(net.texts(bob)).toEqual([]);
  });

  it("refuses a replay older than the replay window, even though it was never seen", async () => {
    const { net, alice, bob } = await trio();
    await bob.handle(alice.myKey, forgeMessage(alice.state, { n: GROUP_LIMITS.window + 10, text: "far" }));
    await bob.handle(alice.myKey, forgeMessage(alice.state, { n: 10, text: "too old" }));
    await bob.handle(alice.myKey, forgeMessage(alice.state, { n: 11, text: "in window" }));
    expect(net.texts(bob)).toEqual(["far", "in window"]);
    expect(bob.missing(alice.myKey)).toBe(GROUP_LIMITS.window - 2);
    expect(bob.missing(createIdentity().pubKeyZ32)).toBe(0);
  });

  it("parks a frame of the next epoch once, and reads it when the commit and its secret arrive", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { net, alice, bob } = await trio();
    net.setEdge(alice, bob, false);
    await alice.rotate();
    const ahead = forgeMessage(alice.state, { n: 0, text: "next epoch" });
    await bob.handle(alice.myKey, ahead);
    await bob.handle(alice.myKey, clone(ahead));
    expect(net.texts(bob)).toEqual([]);
    const commit = net.sent.filter(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === "group-commit").at(-1)!.frame;
    await bob.handle(alice.myKey, commit);
    expect(bob.epoch).toBe(3);
    expect(net.texts(bob)).toEqual(["next epoch"]);
  });

  it("parks a frame whose epoch it knows but whose secret it lacks, and reads it once a peer hands the secret over", async () => {
    const { net, alice, bob } = await trio();
    net.setEdge(alice, bob, false);
    await alice.rotate();
    const commit = net.sent.filter(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === "group-commit").at(-1)!.frame as GroupCommitFrame;
    // The commit reaches Bob without its secret (a member who did not hold it relayed it).
    await bob.handle(alice.myKey, { ...commit, secret: undefined });
    expect(bob.epoch).toBe(3);
    expect(bob.readableEpochs).not.toContain(3);
    await bob.handle(alice.myKey, forgeMessage(alice.state, { n: 0, text: "waiting for the key" }));
    expect(net.texts(bob)).toEqual([]);
    await bob.handle(alice.myKey, { t: "group-secrets", g: alice.id, secrets: [{ e: 3, s: commit.secret }] });
    expect(bob.readableEpochs).toContain(3);
    expect(net.texts(bob)).toEqual(["waiting for the key"]);
  });

  it("forgets replay windows of epochs it can no longer read", async () => {
    const { net, alice, bob } = await trio();
    await bob.handle(alice.myKey, forgeMessage(alice.state, { n: 0 }));
    expect(Object.keys(bob.state.seen[alice.myKey])).toEqual(["2"]);
    for (let i = 0; i < GROUP_LIMITS.secrets + 2; i++) await alice.rotate();
    await net.settle();
    expect(bob.epoch).toBe(alice.epoch);
    await bob.handle(alice.myKey, forgeMessage(alice.state, { n: 0 }));
    expect(Object.keys(bob.state.seen[alice.myKey])).toEqual([String(alice.epoch)]);
  });
});

describe("receiving commits", () => {
  it("ignores commit frames that carry no commit or no integer epoch, and commits that do not verify for a known epoch", async () => {
    const { alice, bob } = await trio();
    const before = clone(bob.state.chain);
    for (const commit of [undefined, null, "x", { e: "1" }, { e: 1.5 }, { ...clone(alice.state.chain[1]), ts: 99 }]) {
      await bob.handle(alice.myKey, { t: "group-commit", g: alice.id, commit });
    }
    expect(bob.state.chain).toEqual(before);
    expect(bob.status).toBe("active");
  });

  it("accepts a replay of a commit it already has without forking", async () => {
    const { alice, bob } = await trio();
    await bob.handle(alice.myKey, { t: "group-commit", g: alice.id, commit: clone(alice.state.chain[1]) });
    await bob.handle(alice.myKey, { t: "group-commit", g: alice.id, commit: clone(alice.state.chain[0]) });
    expect(bob.status).toBe("active");
    expect(bob.epoch).toBe(2);
  });

  it("does not let a member halt the group with a genesis of its own for the same group id", async () => {
    const { alice, bob, carol } = await trio();
    const forged = signCommit({
      v: 1, g: alice.id, e: 0, p: "", k: "create", m: [[bob.myKey, "admin"]], by: bob.myKey, ts: 5, c: "A".repeat(43),
    }, identityFromSeedB64(bob.state.seedB64).seed);
    await alice.handle(bob.myKey, { t: "group-commit", g: alice.id, commit: forged });
    await carol.handle(bob.myKey, { t: "group-commit", g: alice.id, commit: forged });
    expect(alice.status).toBe("active");
    expect(carol.status).toBe("active");
  });

  it("still forks on a second genesis signed by the group's own creator", async () => {
    const { alice, bob } = await trio();
    const genesis = alice.state.chain[0];
    const other = signCommit({ ...genesis, ts: genesis.ts + 1 }, identityFromSeedB64(alice.state.seedB64).seed);
    await bob.handle(alice.myKey, { t: "group-commit", g: alice.id, commit: other });
    expect(bob.status).toBe("forked");
  });

  it("forks when the admin's valid signature is on a next commit that does not follow the chain", async () => {
    const { alice, bob } = await trio();
    const stray = forgeCommit(alice.top, alice.state.seedB64, "rotate", alice.roster, { p: "a".repeat(64) });
    await bob.handle(alice.myKey, { t: "group-commit", g: alice.id, commit: stray });
    expect(bob.status).toBe("forked");
    expect(bob.state.statusReason).toMatch(/different membership history for epoch 3/);
  });

  it("treats a stray next commit signed by a non-admin, or an unauthorized one by the admin, as noise", async () => {
    const { alice, bob, carol } = await trio();
    const byCarol = forgeCommit(alice.top, carol.state.seedB64, "rotate", alice.roster, { p: "a".repeat(64) });
    await bob.handle(carol.myKey, { t: "group-commit", g: alice.id, commit: byCarol });
    const unauthorized = forgeCommit(alice.top, carol.state.seedB64, "rotate", alice.roster);
    await bob.handle(carol.myKey, { t: "group-commit", g: alice.id, commit: unauthorized });
    const wrongRoster = forgeCommit(alice.top, alice.state.seedB64, "rotate", alice.roster.filter(([k]) => k !== carol.myKey));
    await bob.handle(alice.myKey, { t: "group-commit", g: alice.id, commit: wrongRoster });
    expect(bob.status).toBe("active");
    expect(bob.epoch).toBe(2);
  });

  it("holds commits that arrive ahead of a gap and applies them in order once the gap is filled", async () => {
    const { net, alice, bob } = await trio();
    net.setEdge(alice, bob, false);
    await alice.rotate(); await alice.rotate(); await alice.rotate();
    const commits = net.sent.filter(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === "group-commit").slice(-3).map(f => f.frame);
    await bob.handle(alice.myKey, commits[2]);
    await bob.handle(alice.myKey, commits[1]);
    expect(bob.epoch).toBe(2);
    await bob.handle(alice.myKey, commits[0]);
    expect(bob.epoch).toBe(5);
    expect(bob.readableEpochs).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps at most a bounded number of commits ahead, and asks the sender only once for all of them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { net, alice, bob } = await trio();
    net.setEdge(alice, bob, false);
    const asked = () => net.sent.filter(f => f.from === bob.myKey && f.frame.t === "group-sync").length;
    const before = asked();
    for (let e = 4; e < 4 + GROUP_LIMITS.pendingCommits + 8; e++) await bob.handle(alice.myKey, { t: "group-commit", g: alice.id, commit: { e } });
    expect((bob as unknown as { pendingCommits: Map<number, unknown> }).pendingCommits.size).toBe(GROUP_LIMITS.pendingCommits);
    expect(asked() - before).toBe(1);
    // After the throttle, the next unreadable frame asks again.
    vi.setSystemTime(Date.now() + 10_001);
    await bob.handle(alice.myKey, { t: "group-commit", g: alice.id, commit: { e: 40 } });
    expect(asked() - before).toBe(2);
  });

  it("takes a sealed secret only when it opens for this member and confirms against the commit", async () => {
    const { net, alice, bob } = await trio();
    net.setEdge(alice, bob, false);
    await alice.rotate();
    const commit = net.sent.filter(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === "group-commit").at(-1)!.frame as GroupCommitFrame;
    // A secret sealed to Bob in the right context, but not the one the commit confirms.
    const wrong = sealSecret(bob.myKey, newEpochSecret(), secretAad(alice.id, 3, bob.myKey));
    await bob.handle(alice.myKey, { ...commit, secret: wrong });
    expect(bob.epoch).toBe(3);
    expect(bob.readableEpochs).not.toContain(3);
    // Handing over garbage, a secret for a future epoch or too many entries changes nothing either.
    const saves = net.saves.get(bob.myKey);
    for (const secrets of ["x", new Array(GROUP_LIMITS.secrets + 1).fill({ e: 3, s: commit.secret }), [null, { e: "3", s: commit.secret }, { e: -1, s: commit.secret }, { e: 4, s: commit.secret }, { e: 3, s: "x" }, { e: 3, s: wrong }]]) {
      await bob.handle(alice.myKey, { t: "group-secrets", g: alice.id, secrets });
    }
    expect(bob.readableEpochs).not.toContain(3);
    expect(net.saves.get(bob.myKey)).toBe(saves);
    await bob.handle(alice.myKey, { t: "group-secrets", g: alice.id, secrets: [{ e: 3, s: commit.secret }] });
    expect(bob.readableEpochs).toContain(3);
    // A second copy of a secret it holds is not taken again.
    const saved = net.saves.get(bob.myKey);
    await bob.handle(alice.myKey, { t: "group-secrets", g: alice.id, secrets: [{ e: 3, s: commit.secret }] });
    expect(net.saves.get(bob.myKey)).toBe(saved);
  });

  it("refuses a secret for an epoch older than the ones it keeps", async () => {
    const { net, alice, bob } = await trio();
    const state = clone(bob.state);
    delete state.secrets[1];
    const b2 = new Net().add(state);
    const epochOne = fromBase64Url(alice.state.secrets[1]);
    for (let i = 0; i < GROUP_LIMITS.secrets + 1; i++) await alice.rotate();
    await net.settle();
    for (const f of net.sent.filter(x => x.to === bob.myKey && x.frame.t === "group-commit")) await b2.handle(alice.myKey, f.frame);
    expect(b2.epoch).toBe(alice.epoch);
    const old = sealSecret(b2.myKey, epochOne, secretAad(alice.id, 1, b2.myKey));
    await b2.handle(alice.myKey, { t: "group-secrets", g: alice.id, secrets: [{ e: 1, s: old }] });
    expect(b2.readableEpochs).not.toContain(1);
  });
});

describe("sync and leave", () => {
  it("ignores a sync from a non-member or with a malformed epoch or hash", async () => {
    const { net, alice, bob } = await trio();
    const stranger = createIdentity().pubKeyZ32;
    const count = net.sent.length;
    await alice.handle(stranger, bob.syncFrame());
    for (const patch of [{ e: -1 }, { e: "1" }, { h: 5 }]) await alice.handle(bob.myKey, { ...bob.syncFrame(), ...patch });
    expect(net.sent.length).toBe(count);
  });

  it("asks a member who claims a later epoch to catch it up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { net, alice, bob } = await trio();
    net.setEdge(alice, bob, false);
    await bob.handle(alice.myKey, { ...alice.syncFrame(), e: alice.epoch + 3 });
    expect(net.sent.at(-1)).toMatchObject({ from: bob.myKey, to: alice.myKey, frame: { t: "group-sync" } });
  });

  it("catches up a member with commits, secrets it lacks and its own messages, tolerating a malformed report", async () => {
    const { net, alice, bob } = await trio();
    await alice.sendText("one");
    net.setEdge(alice, bob, false);
    const report = { ...bob.syncFrame(), e: 1, h: commitHash(bob.state.chain[1]), secrets: "all", have: "nothing" };
    const count = net.sent.length;
    await alice.handle(bob.myKey, report);
    const out = net.sent.slice(count).filter(f => f.to === bob.myKey).map(f => f.frame);
    expect(out.filter(f => f.t === "group-commit").map(f => (f as GroupCommitFrame).commit.e)).toEqual([2]);
    expect(out.some(f => f.t === "group-commit" && "secret" in f)).toBe(true);
    expect(out.find(f => f.t === "group-secrets")).toMatchObject({ secrets: [{ e: 1 }] });
    expect(out.filter(f => f.t === "group-msg")).toHaveLength(1);
  });

  it("does not send a newcomer the commit secrets or messages of epochs before it joined", async () => {
    const { net, alice, carol } = await trio();
    net.setEdge(alice, carol, false);
    await alice.sendText("before carol? no, after");
    const count = net.sent.length;
    await alice.handle(carol.myKey, { ...carol.syncFrame(), e: 0, h: commitHash(alice.state.chain[0]), secrets: [], have: {} });
    const out = net.sent.slice(count).map(f => f.frame);
    expect(out.find(f => f.t === "group-secrets")).toBeUndefined();
    const commits = out.filter((f): f is GroupCommitFrame => f.t === "group-commit");
    expect(commits.map(f => [f.commit.e, "secret" in f])).toEqual([[1, false], [2, true]]);
  });

  it("ignores a leave unless it is the admin hearing it from a member", async () => {
    const { net, alice, bob, carol } = await trio();
    await bob.handle(carol.myKey, { t: "group-leave", g: alice.id });
    await alice.handle(createIdentity().pubKeyZ32, { t: "group-leave", g: alice.id });
    await alice.handle(alice.myKey, { t: "group-leave", g: alice.id });
    await net.settle();
    expect(alice.epoch).toBe(2);
    expect(bob.roster).toHaveLength(3);
  });

  it("keeps a nickname once and clears it", async () => {
    const { net, alice, bob } = await trio();
    await alice.setNick(bob.myKey, "Bob");
    const saves = net.saves.get(alice.myKey);
    await alice.setNick(bob.myKey, " Bob\u200b ");
    expect(net.saves.get(alice.myKey)).toBe(saves);
    await alice.setNick(bob.myKey, undefined);
    expect(alice.state.nicks).toEqual({});
    expect(alice.role(bob.myKey)).toBe("member");
    expect(alice.role(createIdentity().pubKeyZ32)).toBeUndefined();
  });
});

describe("replay of an old epoch", () => {
  it("does not deliver again a message from an epoch whose replay window is gone, though its secret is still held", async () => {
    const { net, alice, bob, carol } = await trio();
    await bob.sendText("once");
    await net.settle();
    const old = net.sent.find(s => s.from === bob.myKey && s.to === carol.myKey && s.frame.t === "group-msg")!.frame as GroupMessageFrame;
    const oldSecret = carol.state.secrets[old.e];
    for (let i = 0; i < GROUP_LIMITS.secrets + 2; i++) await alice.rotate();
    await net.settle();
    // Marking a newer message drops the replay window of epochs this far back.
    await bob.sendText("now");
    await net.settle();
    expect(net.texts(carol)).toEqual(["once", "now"]);
    expect(carol.state.seen[bob.myKey][old.e]).toBeUndefined();
    // A member that missed the secrets in between still holds the old one: pruning by count leaves it.
    const state = clone(carol.state);
    state.secrets = { [old.e]: oldSecret, [carol.epoch]: state.secrets[carol.epoch] };
    const restored = net.add(state);
    await restored.handle(bob.myKey, clone(old));
    expect(net.texts(restored)).toEqual([]);
  });
});
