import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { encryptText, epochKeys } from "../src/groupCrypto";
import { fromBase64Url } from "../src/bytes";
import { LEGACY_GROUP_MEMBERS, MAX_GROUP_MEMBERS, verifyChain } from "../src/groupCommits";
import { GROUP_LIMITS, GroupSession, chainPieces, groupMessageId, type GroupMessageFrame, type GroupSecretsFrame, type GroupSyncFrame } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
// covers: groups.catch-up, groups.remove-member, groups.protocol.mentions

/*
 * Revision 0.9 of the mesh profile (WISP 9xx § Catch-up): any member hands on what another missed, not only its
 * author, when asked (`ask` in the sync); the author's `xs` vouches for the mention and reply boxes of a frame handed
 * on; someone out of the roster is neither handed on nor taken from a third member; rosters of up to 32.
 */

/** Alice (admin), Bob and Carol, all connected. */
async function three() {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
  const bob = await admit(mesh, alice, "Bob"), carol = await admit(mesh, alice, "Carol");
  return { mesh, alice, bob, carol };
}
const away = (mesh: Mesh, who: GroupSession, from: GroupSession[]) => { for (const s of from) mesh.setEdge(who.myKey, s.myKey, false); };

describe("any member catches up the others", { timeout: 60_000 }, () => {
  it("hands on an author's messages when the author is gone too, mentions and reply included", async () => {
    const { mesh, alice, bob, carol } = await three();
    await alice.sendText("hello all"); await mesh.settle();
    away(mesh, bob, [alice, carol]);
    const hello = mesh.inbox.get(carol.myKey)!.find(m => m.text === "hello all")!;
    await carol.sendText("@Alice status: green", 1_000, [{ k: alice.myKey, o: 0, l: 6 }], { i: hello.id, s: "hello all", f: alice.myKey });
    await carol.sendText("second status", 2_000);
    await mesh.settle();
    // Carol's app closes before Bob's opens again.
    away(mesh, carol, [alice]);
    expect(mesh.texts(bob)).toEqual(["hello all"]);
    await mesh.open(bob, alice, { a: [carol.myKey] });
    expect(mesh.texts(bob)).toEqual(["hello all", "@Alice status: green", "second status"]);
    const got = mesh.inbox.get(bob.myKey)!.find(m => m.text === "@Alice status: green")!;
    expect(got.id).toBe(groupMessageId(carol.myKey, carol.epoch, 0));
    expect(got.sender).toBe(carol.myKey);
    expect(got.mentions).toEqual([{ k: alice.myKey, o: 0, l: 6 }]);
    expect(got.reply).toEqual({ i: hello.id, s: "hello all", f: alice.myKey });
    // They came from Alice, signed by Carol.
    const handedOn = mesh.sentFrames.filter(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === "group-msg" && (f.frame as GroupMessageFrame).s === carol.myKey);
    expect(handedOn).toHaveLength(2);
    // Carol back: nothing is delivered twice.
    await mesh.open(bob, carol);
    expect(mesh.texts(bob)).toHaveLength(3);
  });

  it("hands on nothing to a sync that asks for nobody (apps from before revision 0.9)", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    await carol.sendText("while bob is away"); await mesh.settle();
    away(mesh, carol, [alice]);
    await mesh.open(bob, alice);
    expect(mesh.texts(bob)).toEqual([]);
    // Asked later (the engine's periodic turn), it comes.
    await alice.handle(bob.myKey, clone(bob.syncFrame([carol.myKey]))); await mesh.settle();
    expect(mesh.texts(bob)).toEqual(["while bob is away"]);
  });

  it("drops the boxes of a frame handed on without the author's whole signature, and of one a member tampered with", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    await carol.sendText("@Alice look", 1_000, [{ k: alice.myKey, o: 0, l: 6 }]); await mesh.settle();
    const frame = clone(carol.state.sent[0]);
    expect(frame.xs).toHaveLength(86);
    // Alice (a member, so she holds the epoch key) swaps the mention to name Bob.
    const key = epochKeys(fromBase64Url(alice.state.secrets[alice.epoch]), alice.id, frame.e).message;
    const forged = { ...frame, m: encryptText(key, JSON.stringify(["ghostly-group/1 mentions", frame.g, frame.e, frame.s, frame.n, frame.ts]), JSON.stringify([{ k: bob.myKey, o: 0, l: 6 }])) };
    mesh.setEdge(alice.myKey, bob.myKey, true);
    await bob.handle(alice.myKey, clone(forged));
    const got = mesh.inbox.get(bob.myKey)!.find(m => m.text === "@Alice look")!;
    expect(got.mentions).toBeUndefined();
    // An older author (no `xs`): its boxes are believed only from its own edge.
    await carol.sendText("@Alice again", 2_000, [{ k: alice.myKey, o: 0, l: 6 }]); await mesh.settle();
    const old = clone(carol.state.sent[1]); delete old.xs;
    await bob.handle(alice.myKey, clone(old));
    expect(mesh.inbox.get(bob.myKey)!.find(m => m.text === "@Alice again")!.mentions).toBeUndefined();
    // Straight from Carol, the same frame keeps them.
    const dave = await admit(mesh, alice, "Dave");
    await carol.sendText("@Alice third", 3_000, [{ k: alice.myKey, o: 0, l: 6 }]); await mesh.settle();
    const third = clone(carol.state.sent[2]); delete third.xs;
    await dave.handle(carol.myKey, third);
    expect(mesh.inbox.get(dave.myKey)!.find(m => m.text === "@Alice third")!.mentions).toEqual([{ k: alice.myKey, o: 0, l: 6 }]);
  });

  it("fills gaps below the highest sequence, from the author and from anyone asked", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    for (const text of ["c0", "c1", "c2"]) await carol.sendText(text);
    await mesh.settle();
    const [f0, , f2] = carol.state.sent.map(clone);
    await bob.handle(carol.myKey, f0); await bob.handle(carol.myKey, f2);
    expect(bob.missing(carol.myKey)).toBe(1);
    expect((bob.syncFrame() as GroupSyncFrame).miss).toEqual({ [carol.myKey]: { [String(carol.epoch)]: [1] } });
    away(mesh, carol, [alice]);
    await mesh.open(bob, alice, { a: [carol.myKey] });
    expect(mesh.texts(bob)).toEqual(["c0", "c2", "c1"]);
    expect(bob.missing(carol.myKey)).toBe(0);
  });

  it("hands on to a member only what was sent in epochs it was in", async () => {
    const { mesh, alice, bob, carol } = await three();
    await carol.sendText("before dave"); await mesh.settle();
    away(mesh, carol, [alice, bob]);
    const dave = await admit(mesh, alice, "Dave");
    await mesh.open(dave, alice, { a: [carol.myKey] });
    expect(mesh.texts(dave)).toEqual([]);
    expect(mesh.sentFrames.some(f => f.to === dave.myKey && f.frame.t === "group-msg")).toBe(false);
    expect(mesh.texts(bob)).toEqual(["before dave"]);
  });

  it("a removed member is not handed on, and a frame of theirs handed on by a third member is refused", async () => {
    const { mesh, alice, bob, carol } = await three();
    away(mesh, bob, [alice, carol]);
    await carol.sendText("last words"); await mesh.settle();
    const words = clone(carol.state.sent[0]);
    expect(alice.state.relay?.map(f => f.s)).toContain(carol.myKey);
    await alice.remove(carol.myKey); await mesh.settle();
    // Alice dropped what Carol sent from what she hands on.
    expect(alice.state.relay?.some(f => f.s === carol.myKey)).toBe(false);
    mesh.setEdge(alice.myKey, bob.myKey, true);
    await mesh.open(bob, alice, { a: [carol.myKey] });
    expect(bob.roster.some(([k]) => k === carol.myKey)).toBe(false);
    expect(mesh.texts(bob)).toEqual([]);
    // A member handing it on anyway (a stale or a hostile one) is not believed: Carol is out of Bob's roster.
    await bob.handle(alice.myKey, words);
    expect(mesh.texts(bob)).toEqual([]);
    // Nor is one from a member outside the roster handing on someone else's.
    await alice.sendText("from alice"); await mesh.settle();
    const fromAlice = clone(alice.state.sent[alice.state.sent.length - 1]);
    await bob.handle(carol.myKey, fromAlice);
    expect(mesh.texts(bob).filter(t => t === "from alice")).toHaveLength(1);
  });

  it("keeps what it hands on bounded, by count and by bytes, and without fields its author added", async () => {
    const { mesh, alice, bob } = await three();
    for (let i = 0; i < GROUP_LIMITS.relay + 10; i++) await bob.sendText(`b${i}`);
    await mesh.settle();
    expect(alice.state.relay).toHaveLength(GROUP_LIMITS.relay);
    expect(alice.state.relay![0].n).toBe(10);
    const big = "x".repeat(8_000);
    for (let i = 0; i < 40; i++) await bob.sendText(big);
    await mesh.settle();
    const bytes = alice.state.relay!.reduce((s, f) => s + f.c.length, 0);
    expect(bytes).toBeLessThanOrEqual(GROUP_LIMITS.relayBytes);
    // A frame padded with something else is kept without it.
    mesh.setEdge(alice.myKey, bob.myKey, false);
    await bob.sendText("padded"); await mesh.settle();
    const padded = { ...clone(bob.state.sent[bob.state.sent.length - 1]), junk: "y".repeat(50_000) };
    mesh.setEdge(alice.myKey, bob.myKey, true);
    await alice.handle(bob.myKey, padded);
    const kept = alice.state.relay![alice.state.relay!.length - 1];
    expect(kept).not.toHaveProperty("junk");
  });
});

describe("rosters past eight", () => {
  it("admits up to 32, every welcome piece well within a frame, and everyone reads everyone", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Many"), "Alice");
    const members = [alice];
    for (let i = 1; i < MAX_GROUP_MEMBERS; i++) members.push(await admit(mesh, alice, `M${i}`));
    expect(alice.roster).toHaveLength(MAX_GROUP_MEMBERS);
    await expect(alice.admit(createIdentity().pubKeyZ32)).rejects.toThrow("This change is not allowed");
    // The chain as a newcomer would get it, in pieces that each fit a frame.
    await alice.rotate();
    const pieces = chainPieces(alice.state.chain);
    expect(pieces.flat()).toHaveLength(alice.state.chain.length);
    for (const piece of pieces) expect(JSON.stringify({ t: "group-chain", g: alice.id, commits: piece }).length).toBeLessThan(GROUP_LIMITS.chainPieceBytes + 1024);
    expect("chain" in verifyChain(clone(alice.state.chain))).toBe(true);
    await members[31].sendText("the last one in"); await mesh.settle();
    for (const m of members.slice(0, 31)) expect(mesh.texts(m)).toContain("the last one in");
    expect(LEGACY_GROUP_MEMBERS).toBe(8);
  }, 120_000);

  it("hands secrets on sixteen to a frame, what apps from before revision 0.9 take", async () => {
    const mesh = new Mesh();
    const alice = mesh.add(GroupSession.create("Ghosts"), "Alice");
    const bob = await admit(mesh, alice, "Bob");
    const bobKey = bob.myKey;
    // Bob loses his secrets (a restore from an old backup, say); twenty epochs later he asks for all of them.
    for (let i = 0; i < 20; i++) await alice.rotate();
    await mesh.settle();
    const sync = { ...bob.syncFrame(), secrets: [] };
    mesh.sentFrames.length = 0;
    await alice.handle(bobKey, clone(sync)); await mesh.settle();
    const frames = mesh.sentFrames.filter(f => f.from === alice.myKey && f.frame.t === "group-secrets").map(f => f.frame as GroupSecretsFrame);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(frame.secrets.length).toBeLessThanOrEqual(GROUP_LIMITS.secretsPerFrame);
  });
});

describe("what a member hands on cannot take a message's place", { timeout: 60_000 }, () => {
  it("a copy without its author's whole signature is not the message: the author's own copy still brings mentions and reply", async () => {
    const { mesh, alice, bob, carol } = await three();
    await alice.sendText("hello all"); await mesh.settle();
    const hello = mesh.inbox.get(carol.myKey)!.find(m => m.text === "hello all")!;
    mesh.setEdge(bob.myKey, carol.myKey, false);
    await carol.sendText("@Bob look", 1_000, [{ k: bob.myKey, o: 0, l: 4 }], { i: hello.id, s: "hello all", f: alice.myKey }); await mesh.settle();
    // Alice hands it on with only what the plain signature covers: no mention, no reply, no whole signature.
    const stripped = clone(carol.state.sent[0]); delete stripped.m; delete stripped.r; delete stripped.xs;
    await bob.handle(alice.myKey, stripped);
    const copies = () => mesh.inbox.get(bob.myKey)!.filter(m => m.text === "@Bob look");
    expect(copies()).toHaveLength(1);
    expect(copies()[0].mentions).toBeUndefined();
    // Again, and with the boxes but no whole signature: nothing more.
    await bob.handle(alice.myKey, clone(stripped));
    const unsigned = clone(carol.state.sent[0]); delete unsigned.xs;
    await bob.handle(alice.myKey, unsigned);
    expect(copies()).toHaveLength(1);
    // Not seen yet: Bob's sync still asks for it, and he hands none of it on.
    expect(bob.syncFrame().have[carol.myKey]?.[String(carol.epoch)]).toBeUndefined();
    expect(bob.state.relay?.some(f => f.s === carol.myKey) ?? false).toBe(false);
    // Carol's own copy, when their edge opens, completes it.
    await mesh.open(bob, carol);
    expect(copies()).toHaveLength(2);
    expect(copies()[1]).toMatchObject({ id: copies()[0].id, completes: true, mentions: [{ k: bob.myKey, o: 0, l: 4 }], reply: { i: hello.id, s: "hello all", f: alice.myKey } });
    // Seen now: once more changes nothing.
    await bob.handle(carol.myKey, clone(carol.state.sent[0]));
    await bob.handle(alice.myKey, clone(carol.state.sent[0]));
    expect(copies()).toHaveLength(2);
  });

  it("a whole copy handed on by another member is the message", async () => {
    const { mesh, alice, bob, carol } = await three();
    mesh.setEdge(bob.myKey, carol.myKey, false);
    await carol.sendText("@Bob whole", 1_000, [{ k: bob.myKey, o: 0, l: 4 }]); await mesh.settle();
    await bob.handle(alice.myKey, clone(carol.state.sent[0]));
    const got = mesh.inbox.get(bob.myKey)!.filter(m => m.text === "@Bob whole");
    expect(got).toHaveLength(1);
    expect(got[0].mentions).toEqual([{ k: bob.myKey, o: 0, l: 4 }]);
    expect(got[0].completes).toBeUndefined();
    await mesh.open(bob, carol);
    expect(mesh.inbox.get(bob.myKey)!.filter(m => m.text === "@Bob whole")).toHaveLength(1);
  });
});

describe("sync answers", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("answers one member's syncs a few times a minute, not every one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { mesh, alice, bob } = await three();
    for (const text of ["a", "b", "c"]) await alice.sendText(text);
    await mesh.settle();
    // What the edges said while they opened is a minute ago.
    vi.setSystemTime(Date.now() + 61_000);
    // A sync that claims to have nothing: every answer carries Alice's log again.
    const empty = () => ({ ...clone(bob.syncFrame()), have: {} });
    const answers = () => mesh.sentFrames.filter(f => f.from === alice.myKey && f.to === bob.myKey && f.frame.t === "group-msg").length;
    const before = answers();
    for (let i = 0; i < 50; i++) await alice.handle(bob.myKey, empty());
    await mesh.settle();
    expect((answers() - before) / 3).toBe(GROUP_LIMITS.syncAnswers);
    // A minute later, answered again.
    vi.setSystemTime(Date.now() + 61_000);
    await alice.handle(bob.myKey, empty()); await mesh.settle();
    expect((answers() - before) / 3).toBe(GROUP_LIMITS.syncAnswers + 1);
  });
});
