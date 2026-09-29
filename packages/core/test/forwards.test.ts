import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { fromBase64Url } from "../src/bytes";
import { decryptText, epochKeys } from "../src/groupCrypto";
import { createLink } from "../src/invite";
import { createRelayPayload, parseRelayPayload, type SignedPacket } from "../src/pkarr";
import { DhtDelivery, emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import type { PairingCredentials } from "../src/pairedSession";
import { pairedMessageFrame } from "../src/ghostlink";
import { GroupSession, type GroupEdgeFrame, type GroupIncomingMessage, type GroupMessageFrame } from "../src/groupSession";
import { CommunitySession, type CommunityFrame, type CommunityIncomingMessage, type CommunityMessageFrame } from "../src/groupCommunity";
import { FORWARD_LIMITS, forwardedAgain, forwardedMany, readForwarded } from "../src/forwards";
// covers: chat.forward.wire, groups.protocol.forwards

/*
 * A forwarded message's hop count on each wire (WISP 400 § Forwards): what it says, and that an app without forwards
 * reads the same message it always did.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ID = "A".repeat(22);

describe("a hop count", () => {
  it("is a whole number from 1 to its limit; anything else is not forwarded", () => {
    expect([1, 7, FORWARD_LIMITS.max].map(readForwarded)).toEqual([1, 7, FORWARD_LIMITS.max]);
    for (const bad of [0, -1, 2.5, "3", null, undefined, {}, FORWARD_LIMITS.max + 1]) expect(readForwarded(bad)).toBeUndefined();
  });
  it("grows by one each time it is forwarded, up to its limit, and is many from five", () => {
    expect([undefined, 1, 4, FORWARD_LIMITS.max].map(forwardedAgain)).toEqual([1, 2, 5, FORWARD_LIMITS.max]);
    expect([undefined, 1, 4, 5, 200].map(forwardedMany)).toEqual([false, false, false, true, true]);
  });
});

describe("the paired-message frame", () => {
  it("carries `fw` beside the fields older apps read, and nothing when the message was written here", () => {
    const frame = JSON.parse(pairedMessageFrame(ID, 5, "look", undefined, undefined, 3));
    expect(frame).toEqual({ t: "paired-message", id: ID, ts: 5, m: "look", fw: 3 });
    expect(JSON.parse(pairedMessageFrame(ID, 5, "look"))).toEqual({ t: "paired-message", id: ID, ts: 5, m: "look" });
    expect(JSON.parse(pairedMessageFrame(ID, 5, "look", undefined, undefined, 0))).not.toHaveProperty("fw");
  });
});

// Fake time runs the relays' pace; a slow runner needs more than the default 5 s of real time for it.
describe("a forwarded text over the DHT", { timeout: 30_000 }, () => {
  function setup() {
    const link = createLink(), params = [link.mine, link.invite];
    const packets = new Map<string, SignedPacket>();
    const saved: DhtDeliveryState[] = [emptyDhtDeliveryState(), emptyDhtDeliveryState()];
    const credentials: PairingCredentials[] = [0, 1].map(() => ({ seedB64: createIdentity().seedB64 }));
    const messages = [new Map<string, { text: string; forwarded?: number }>(), new Map<string, { text: string; forwarded?: number }>()];
    const publish = vi.fn(async (identity, records) => {
      const wire = createRelayPayload(identity, records);
      expect(wire.length).toBeLessThanOrEqual(1072);
      packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, wire));
    });
    const resolve = vi.fn(async key => packets.get(key) ?? null);
    const make = (i: number) => new DhtDelivery({ params: params[i], mode: "dht", state: saved[i], credentials: credentials[i],
      transport: { publish, resolve, describe: () => ({ protocol: "signed-packet fixture", relays: [] }) },
      save: async state => { saved[i] = structuredClone(state); },
      pin: async key => { credentials[i].peerKey = key; },
      message: async m => { messages[i].set(m.id, { text: m.text, ...(m.forwarded && { forwarded: m.forwarded }) }); }, receipt: async () => {}, changed: () => {}, pollMs: 100 });
    return { make, messages, saved };
  }
  afterEach(() => vi.useRealTimers());

  it("carries its hop count as the fifteenth element, which the reader gets beside the text", async () => {
    vi.useFakeTimers();
    const h = setup(), a = h.make(0), b = h.make(1);
    await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4500);
    expect(await a.send("pass it on", Date.now(), "abcdefghijklmnopqrstuv", undefined, undefined, 2)).toBeNull();
    expect(h.saved[0].pending?.forwarded).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.messages[1].get("abcdefghijklmnopqrstuv")).toEqual({ text: "pass it on", forwarded: 2 });
    // One written here carries none.
    expect(await b.send("ok", Date.now(), "bcdefghijklmnopqrstuvw")).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.messages[0].get("bcdefghijklmnopqrstuvw")).toEqual({ text: "ok" });
    await a.stop(); await b.stop();
  });

  it("a text at the bound goes without it when both do not fit: the text is what matters", async () => {
    vi.useFakeTimers();
    const h = setup(), a = h.make(0), b = h.make(1);
    await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4500);
    // 256 bytes whose line breaks JSON writes as two characters each: the text fits alone, not with a hop count.
    const full = "a" + "\n".repeat(10) + "x".repeat(245);
    expect(await a.send(full, Date.now(), "abcdefghijklmnopqrstuv", undefined, undefined, 9)).toBeNull();
    expect(h.saved[0].pending?.forwarded).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.messages[1].get("abcdefghijklmnopqrstuv")).toEqual({ text: full });
    // A shorter text still has room for it.
    expect(await b.send("x".repeat(200), Date.now(), "bcdefghijklmnopqrstuvw", undefined, undefined, 9)).toBeNull();
    expect(h.saved[1].pending?.forwarded).toBe(9);
    await a.stop(); await b.stop();
  });
});

/** Mesh members wired directly, every edge open. */
function mesh() {
  const sessions = new Map<string, GroupSession>();
  const inbox = new Map<string, GroupIncomingMessage[]>();
  let pending: Promise<unknown>[] = [];
  const add = (state: ReturnType<typeof GroupSession.create>) => {
    const session: GroupSession = new GroupSession(state, {
      save: async () => {},
      send: (to, frame: GroupEdgeFrame) => { const t = sessions.get(to); if (t) pending.push(t.handle(session.myKey, clone(frame))); },
      message: m => { inbox.get(session.myKey)!.push(m); },
      changed: () => {},
    });
    sessions.set(session.myKey, session); inbox.set(session.myKey, []);
    return session;
  };
  const settle = async () => { while (pending.length) { const batch = pending; pending = []; await Promise.all(batch); } };
  const admit = async (admin: GroupSession) => {
    const seed = createIdentity().seedB64;
    const welcome = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
    const invite = admin.inviteFrame();
    const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
    if ("error" in joined) throw new Error(joined.error);
    const session = add(joined.state);
    await settle();
    for (const other of session.others) { const peer = sessions.get(other); if (peer) { pending.push(peer.handle(session.myKey, clone(session.syncFrame())), session.handle(peer.myKey, clone(peer.syncFrame()))); await settle(); } }
    return session;
  };
  return { add, admit, settle, inbox };
}

describe("a forwarded text in a private group", () => {
  it("carries `f` on the frame, covered by the author's whole signature, and every member gets it", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice), carol = await net.admit(alice);
    expect(await alice.sendText("pass it on", Date.now(), [], undefined, 2)).toHaveProperty("id");
    await net.settle();
    for (const s of [bob, carol]) expect(net.inbox.get(s.myKey)!.find(m => m.text === "pass it on")).toMatchObject({ forwarded: 2 });
    expect(alice.state.sent[alice.state.sent.length - 1]).toMatchObject({ f: 2 });
    expect(await alice.sendText("mine", Date.now())).toHaveProperty("id");
    await net.settle();
    expect(net.inbox.get(bob.myKey)!.find(m => m.text === "mine")).not.toHaveProperty("forwarded");
  });

  it("handed on by another member, it keeps `f` only with the author's signature over it", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice), carol = await net.admit(alice);
    // Carol as she is now, before either message: she hears them only from Bob.
    const heard: GroupIncomingMessage[] = [];
    const reader = new GroupSession(clone(carol.state), { save: async () => {}, send: () => {}, message: m => { heard.push(m); }, changed: () => {} });
    await alice.sendText("pass it on", Date.now(), [], undefined, 2);
    await alice.sendText("plain", Date.now());
    await net.settle();
    const [forwarded, plain] = alice.state.sent.slice(-2).map(clone) as GroupMessageFrame[];
    // Bob hands both on: one as signed, and one where he made up a count.
    await reader.handle(bob.myKey, forwarded);
    await reader.handle(bob.myKey, { ...plain, f: 7 });
    expect(heard.map(m => [m.text, m.forwarded])).toEqual([["pass it on", 2], ["plain", undefined]]);
  });
});

/** Community members on one network where every broadcast reaches everyone. */
function community() {
  const members: CommunitySession[] = [];
  const inbox = new Map<string, CommunityIncomingMessage[]>();
  const broadcasts: CommunityFrame[] = [];
  let pending: Promise<unknown>[] = [];
  const hooks = (get: () => CommunitySession) => {
    const deliver = (to: CommunitySession | undefined, frame: CommunityFrame) => { if (to && to !== get()) pending.push(to.handle(get().myKey, clone(frame))); };
    return {
      save: async () => {},
      broadcast: (frame: CommunityFrame) => { broadcasts.push(clone(frame)); for (const m of members) deliver(m, frame); },
      direct: (to: string, frame: CommunityFrame) => deliver(members.find(m => m.myKey === to), frame),
      addressed: (to: string, frame: CommunityFrame) => deliver(members.find(m => m.myKey === to), frame),
      message: (m: CommunityIncomingMessage) => { inbox.get(get().myKey)!.push(m); },
      changed: () => {},
    };
  };
  const settle = async () => { for (let i = 0; i < 200 && pending.length; i++) { const batch = pending; pending = []; await Promise.all(batch); } };
  const push = (state: ReturnType<typeof CommunitySession.create>) => {
    let session: CommunitySession;
    // eslint-disable-next-line prefer-const
    session = new CommunitySession(state, hooks(() => session));
    members.push(session); inbox.set(session.myKey, []);
    return session;
  };
  const admit = async (by: CommunitySession) => {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await settle();
    const joined = CommunitySession.join({ g: by.id, host: by.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return push(joined.state);
  };
  return { push, admit, settle, inbox, broadcasts };
}

describe("a forwarded text in a community", () => {
  it("rides inside the sealed payload as `fw`", async () => {
    const net = community();
    const alice = net.push(CommunitySession.create("Ghosts"));
    const bob = await net.admit(alice);
    await net.settle();
    expect(await bob.sendText("pass it on", "Bob", Date.now(), [], undefined, 6)).toHaveProperty("id");
    await net.settle();
    expect(net.inbox.get(alice.myKey)!.find(m => m.text === "pass it on")).toMatchObject({ forwarded: 6 });
    const frame = net.broadcasts.filter(f => f.t === "group-msg").pop() as CommunityMessageFrame;
    const secret = alice.state.secrets[Object.keys(alice.state.secrets).find(h => h.startsWith(frame.h))!];
    const plain = decryptText(epochKeys(fromBase64Url(secret), frame.g, frame.e).message, JSON.stringify([frame.g, frame.e, frame.h, frame.s, frame.n, frame.ts]), frame.nn, frame.c);
    expect(JSON.parse(plain!)).toEqual({ text: "pass it on", nick: "Bob", fw: 6 });
  });
});
