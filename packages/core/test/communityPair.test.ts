import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { fromBase64Url, utf8Decode, utf8Encode } from "../src/bytes";
import { decryptText, epochKeys, openPair, sealPair } from "../src/groupCrypto";
import {
  COMMUNITY_LIMITS, CommunitySession,
  type CommunityFrame, type CommunityIncomingApp, type CommunityIncomingMessage, type CommunityIncomingPair, type CommunityMessageFrame, type CommunityState,
} from "../src/groupCommunity";
// covers: groups.protocol.community-pair

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Member {
  name: string; session: CommunitySession; saved: CommunityState; online: boolean;
  messages: CommunityIncomingMessage[]; apps: CommunityIncomingApp[]; pairs: CommunityIncomingPair[];
}

/**
 * Members on one network: what someone broadcasts reaches every online member (as the hubs' flood does), and
 * `tap` sees every frame on the way, the way a hub does.
 */
class Net {
  readonly members = new Map<string, Member>();
  private pending: Promise<unknown>[] = [];
  readonly wire: CommunityFrame[] = [];

  private hooks(name: string) {
    const deliver = (to: Member | undefined, frame: CommunityFrame) => {
      const me = this.members.get(name)!;
      if (!to || !to.online || !me.online || to === me) return;
      this.pending.push(to.session.handle(me.session.myKey, clone(frame)));
    };
    const me = () => this.members.get(name)!;
    return {
      save: async (state: CommunityState) => { me().saved = state; },
      broadcast: (frame: CommunityFrame) => { this.wire.push(clone(frame)); for (const m of this.members.values()) deliver(m, frame); },
      direct: (to: string, frame: CommunityFrame) => deliver(this.byKey(to), frame),
      addressed: (to: string, frame: CommunityFrame) => deliver(this.byKey(to), frame),
      message: (m: CommunityIncomingMessage) => { me().messages.push(m); },
      app: (m: CommunityIncomingApp) => { me().apps.push(m); },
      pair: (m: CommunityIncomingPair) => { me().pairs.push(m); },
      changed: () => {},
    };
  }
  byKey(key: string): Member | undefined { for (const m of this.members.values()) if (m.session.myKey === key) return m; return undefined; }
  private add(name: string, state: CommunityState): Member {
    const member: Member = { name, session: null as unknown as CommunitySession, saved: state, online: true, messages: [], apps: [], pairs: [] };
    this.members.set(name, member);
    member.session = new CommunitySession(state, this.hooks(name));
    return member;
  }
  create(name: string): Member { return this.add(name, CommunitySession.create("Ghosts")); }
  async admit(by: Member, name: string): Promise<Member> {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.session.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await this.settle();
    const joined = CommunitySession.join({ g: by.session.id, host: by.session.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return this.add(name, joined.state);
  }
  async meet(a: Member, b: Member): Promise<void> {
    this.pending.push(b.session.handle(a.session.myKey, clone(a.session.syncFrame())), a.session.handle(b.session.myKey, clone(b.session.syncFrame())));
    await this.settle();
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 200; i++) { const batch = this.pending.splice(0); if (!batch.length) break; await Promise.all(batch); }
  }
  async restart(m: Member): Promise<void> { await m.session.flush(); m.session = new CommunitySession(clone(m.saved), this.hooks(m.name)); }
}

async function trio() {
  const net = new Net();
  const alice = net.create("alice");
  const bob = await net.admit(alice, "bob");
  const carol = await net.admit(bob, "carol");
  await net.settle();
  return { net, alice, bob, carol };
}

/** What a hub (a member) reads of a frame: the epoch layer opened with the epoch's message key. */
function openedByMember(member: Member, frame: CommunityMessageFrame): Record<string, unknown> {
  const secret = Object.entries(member.session.state.secrets).find(([h]) => h.startsWith(frame.h))![1];
  const text = decryptText(epochKeys(fromBase64Url(secret), frame.g, frame.e).message, JSON.stringify([frame.g, frame.e, frame.h, frame.s, frame.n, frame.ts]), frame.nn, frame.c);
  return JSON.parse(text!) as Record<string, unknown>;
}

const TOKEN = "cashuBo2FteBtodHRwczovL21pbnQuZXhhbXBsZS5jb20vYXVjc2F0YXSBomFp";

describe("pair seals", () => {
  const a = createIdentity(), b = createIdentity(), c = createIdentity();
  const plain = utf8Encode(JSON.stringify({ token: TOKEN }));

  it("open only for the recipient, only as from the sender, only with the same associated data", () => {
    const box = sealPair(a.seed, a.pubKeyZ32, b.pubKeyZ32, plain, "frame-1");
    expect(utf8Decode(openPair(b.seed, b.pubKeyZ32, a.pubKeyZ32, box, "frame-1")!)).toContain(TOKEN);
    // Someone else, even knowing both keys: nothing.
    expect(openPair(c.seed, c.pubKeyZ32, a.pubKeyZ32, box, "frame-1")).toBeNull();
    // Claimed as from someone else: the static exchange differs.
    expect(openPair(b.seed, b.pubKeyZ32, c.pubKeyZ32, box, "frame-1")).toBeNull();
    // Lifted into another frame.
    expect(openPair(b.seed, b.pubKeyZ32, a.pubKeyZ32, box, "frame-2")).toBeNull();
    // Tampered.
    const bytes = fromBase64Url(box.c); bytes[0] ^= 1;
    expect(openPair(b.seed, b.pubKeyZ32, a.pubKeyZ32, { ...box, c: Buffer.from(bytes).toString("base64url") }, "frame-1")).toBeNull();
    // A member cannot make one that opens as from another: sealed by C claiming A, B's open fails.
    const forged = sealPair(c.seed, a.pubKeyZ32, b.pubKeyZ32, plain, "frame-1");
    expect(openPair(b.seed, b.pubKeyZ32, a.pubKeyZ32, forged, "frame-1")).toBeNull();
  });

  it("uses a fresh ephemeral key every time", () => {
    const one = sealPair(a.seed, a.pubKeyZ32, b.pubKeyZ32, plain, "x"), two = sealPair(a.seed, a.pubKeyZ32, b.pubKeyZ32, plain, "x");
    expect(one.e).not.toBe(two.e);
    expect(one.c).not.toBe(two.c);
  });
});

describe("pair payloads and app frames in a community", { timeout: 60_000 }, () => {
  it("a payload for one member reaches only them; the member relaying it reads neither amount nor token", async () => {
    const { net, alice, bob, carol } = await trio();
    const sent = await alice.session.sendPair(bob.session.myKey, { t: "pay", v: "1000", token: TOKEN }, "alice");
    expect(sent).toHaveProperty("id");
    await net.settle();
    expect(bob.pairs.map(p => p.payload)).toEqual([{ t: "pay", v: "1000", token: TOKEN }]);
    expect(bob.pairs[0].sender).toBe(alice.session.myKey);
    expect(carol.pairs).toEqual([]);
    expect(bob.messages).toEqual([]);
    // Carol carries it (it is in her store for whoever was away) and can open the epoch layer, as a hub can: not the pair.
    const frame = net.wire.find(f => f.t === "group-msg" && f.s === alice.session.myKey) as CommunityMessageFrame;
    expect(carol.session.state.store.some(f => f.sig === frame.sig)).toBe(true);
    const seen = JSON.stringify(openedByMember(carol, frame));
    expect(seen).toContain(bob.session.myKey);
    expect(seen).not.toContain(TOKEN);
    expect(seen).not.toContain("1000");
    expect(JSON.stringify(net.wire)).not.toContain(TOKEN);
  });

  it("is delivered once, whatever the number of hubs that pass it on, and after a restart too", async () => {
    const { net, alice, bob, carol } = await trio();
    await alice.session.sendPair(bob.session.myKey, { t: "pay-req", id: "request-1" });
    await net.settle();
    const frame = net.wire.find(f => f.t === "group-msg" && f.s === alice.session.myKey)!;
    // The same frame again, from two hubs.
    await bob.session.handle(carol.session.myKey, clone(frame));
    await bob.session.handle(alice.session.myKey, clone(frame));
    expect(bob.pairs).toHaveLength(1);
    await net.restart(bob);
    await bob.session.handle(carol.session.myKey, clone(frame));
    expect(bob.pairs).toHaveLength(1);
  });

  it("a member cannot forge one as from another, nor change who it is for", async () => {
    const { net, alice, bob, carol } = await trio();
    await alice.session.sendPair(bob.session.myKey, { t: "pay", token: TOKEN });
    await net.settle();
    const original = net.wire.find(f => f.t === "group-msg" && f.s === alice.session.myKey) as CommunityMessageFrame;
    // Carol re-signs Alice's box in a frame of her own: it opens for nobody.
    const opened = openedByMember(carol, original) as { p: { to: string; e: string; n: string; c: string } };
    await carol.session.sendPair(bob.session.myKey, { harmless: true });
    await net.settle();
    expect(bob.pairs.map(p => p.payload)).toEqual([{ t: "pay", token: TOKEN }, { harmless: true }]);
    const box = opened.p;
    expect(openPair(identityFromSeedB64(bob.saved.seedB64).seed, bob.session.myKey, carol.session.myKey, box, "anything")).toBeNull();
    // Alice's frame with a byte changed: its signature no longer holds, and nothing is delivered or relayed.
    const altered = { ...clone(original), n: original.n + 1 };
    expect(await bob.session.handle(carol.session.myKey, altered)).toBe(false);
    expect(bob.pairs).toHaveLength(2);
  });

  it("reaches a member who was away through someone who is not its author", async () => {
    const { net, alice, bob, carol } = await trio();
    bob.online = false;
    await alice.session.sendPair(bob.session.myKey, { t: "pay-req", id: "while-away" });
    await net.settle();
    expect(bob.pairs).toEqual([]);
    alice.online = false;
    bob.online = true;
    await net.meet(bob, carol);
    expect(bob.pairs.map(p => p.payload)).toEqual([{ t: "pay-req", id: "while-away" }]);
  });

  it("app frames go to everyone in the epoch, once, and never into the text history", async () => {
    const { net, alice, bob, carol } = await trio();
    await alice.session.sendApp({ t: "group-pay", id: "note-1", st: "open" }, "alice");
    await net.settle();
    for (const m of [bob, carol]) {
      expect(m.apps.map(a => a.frame)).toEqual([{ t: "group-pay", id: "note-1", st: "open" }]);
      expect(m.apps[0].sender).toBe(alice.session.myKey);
      expect(m.messages).toEqual([]);
    }
    expect(alice.apps).toEqual([]);
    // Text still is text.
    await bob.session.sendText("hello", "bob");
    await net.settle();
    expect(alice.messages.map(m => m.text)).toEqual(["hello"]);
    expect(alice.apps).toEqual([]);
  });

  it("refuses what is too large, and payloads for someone outside the group", async () => {
    const { alice } = await trio();
    const big = "x".repeat(COMMUNITY_LIMITS.appBytes);
    expect(await alice.session.sendApp({ big })).toHaveProperty("error");
    expect(await alice.session.sendPair(createIdentity().pubKeyZ32, { t: "pay" })).toHaveProperty("error", "Not a member of this group");
    expect(await alice.session.sendPair(alice.session.myKey, { t: "pay" })).toHaveProperty("error", "Not a member of this group");
    // The largest payload fits in a frame the group carries.
    const most = "y".repeat(COMMUNITY_LIMITS.appBytes - 40);
    const bob = [...(alice.session.others)][0];
    expect(await alice.session.sendPair(bob, { token: most })).toHaveProperty("id");
  });

  it("a member removed afterwards is not sent anything new, and old epochs stay closed to later members", async () => {
    const { net, alice, bob, carol } = await trio();
    await alice.session.sendPair(carol.session.myKey, { before: true });
    await net.settle();
    await alice.session.remove(carol.session.myKey);
    await net.settle();
    expect(await alice.session.sendPair(carol.session.myKey, { after: true })).toHaveProperty("error", "Not a member of this group");
    const dave = await net.admit(bob, "dave");
    await net.meet(dave, bob);
    // Dave joined later: the pair frame of an earlier epoch is not his to receive, and nothing opens for him.
    expect(dave.pairs).toEqual([]);
    expect(carol.pairs.map(p => p.payload)).toEqual([{ before: true }]);
  });
});
