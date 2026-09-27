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
import { COMMUNITY_LIMITS, CommunitySession, type CommunityFrame, type CommunityIncomingMessage, type CommunityMessageFrame } from "../src/groupCommunity";
import { groupReplyAuthor, pairedReplyAuthor, readReply, REPLY_LIMITS, replySnippet, wireReply } from "../src/replies";
// covers: chat.replies.wire, groups.protocol.replies

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ID = "A".repeat(22);

describe("the line of a reply", () => {
  it("is one line of plain text: breaks and runs of spaces become one space", () => {
    expect(replySnippet("  see\n\nyou   at\tnoon  ")).toBe("see you at noon");
    expect(replySnippet("")).toBe("");
  });

  it("holds no control, invisible or direction character (the renderer's rules for names)", () => {
    expect(replySnippet("pay ‮ecnalab‬ now\u0007")).toBe("pay ecnalab now");
    expect(replySnippet("a⁦b⁩c​d")).toBe("abcd");
    // Joiners stay: they are part of emoji and of some scripts.
    expect(replySnippet("👩‍💻 ok")).toBe("👩‍💻 ok");
  });

  it("is cut at 120 code points, the last an ellipsis", () => {
    const long = "👻".repeat(200);
    const cut = replySnippet(long);
    expect(Array.from(cut)).toHaveLength(REPLY_LIMITS.snippet);
    expect(cut.endsWith("…")).toBe(true);
    expect(replySnippet("x".repeat(REPLY_LIMITS.snippet))).toBe("x".repeat(REPLY_LIMITS.snippet));
  });

  it("names an inline picture instead of quoting its bytes", () => {
    expect(replySnippet("data:image/png;base64," + "A".repeat(5000))).toBe("🖼️ Picture");
  });
});

describe("a reply as a receiver takes it", () => {
  it("keeps the id, cleans the line again and checks the author", () => {
    expect(readReply({ i: ID, s: "hello\nthere‮", f: "sender" }, pairedReplyAuthor)).toEqual({ i: ID, s: "hello there", f: "sender" });
    expect(readReply({ i: ID, s: "x".repeat(500), f: "recipient" }, pairedReplyAuthor)!.s).toHaveLength(REPLY_LIMITS.snippet);
    const member = createIdentity().pubKeyZ32;
    expect(readReply({ i: `${member}:0:3`, s: "hi", f: member }, groupReplyAuthor)).toEqual({ i: `${member}:0:3`, s: "hi", f: member });
    // Unknown fields are not kept.
    expect(readReply({ i: ID, s: "hi", f: "sender", x: 1 }, pairedReplyAuthor)).toEqual({ i: ID, s: "hi", f: "sender" });
  });

  it("is no reply when anything does not hold (the message itself is never refused for it)", () => {
    const member = createIdentity().pubKeyZ32;
    for (const raw of [undefined, null, "r", 3, [ID, "s", "sender"],
      { i: "", s: "hi", f: "sender" }, { i: "x".repeat(REPLY_LIMITS.id + 1), s: "hi", f: "sender" }, { i: "bad id!", s: "hi", f: "sender" },
      { i: ID, s: 7, f: "sender" }, { i: ID, s: "x".repeat(REPLY_LIMITS.raw + 1), f: "sender" },
      { i: ID, s: "hi", f: "someone" }, { i: ID, s: "hi" }, { i: ID, s: "hi", f: member }]) {
      expect(readReply(raw, pairedReplyAuthor)).toBeUndefined();
    }
    expect(readReply({ i: ID, s: "hi", f: "sender" }, groupReplyAuthor)).toBeUndefined();
  });

  it("goes on the wire in a fixed order, its line cleaned", () => {
    expect(JSON.stringify(wireReply({ f: "sender", s: " a\nb ", i: ID } as never))).toBe(JSON.stringify({ i: ID, s: "a b", f: "sender" }));
  });
});

describe("the paired-message frame", () => {
  const reply = { i: "B".repeat(22), s: "the plan", f: "recipient" };
  it("carries the reply as `r`, next to the fields older apps read", () => {
    const frame = JSON.parse(pairedMessageFrame(ID, 5, "yes", undefined, reply));
    expect(frame).toEqual({ t: "paired-message", id: ID, ts: 5, m: "yes", r: reply });
    // What an app before replies reads of it is exactly the frame it always got.
    const { t, id, ts, m } = frame;
    expect(JSON.parse(pairedMessageFrame(ID, 5, "yes"))).toEqual({ t, id, ts, m });
  });
  it("keeps the reply when a preview is left out for size", () => {
    const long = "https://news.example/ " + "\u0001".repeat(9_000);
    const frame = JSON.parse(pairedMessageFrame(ID, 5, long, { u: "https://news.example/", t: "N", i: "data:image/jpeg;base64," + "A".repeat(20_000) }, reply));
    expect(frame).not.toHaveProperty("pv");
    expect(frame.r).toEqual(reply);
  });
});

// Fake time runs the relays' pace; a slow runner needs more than the default 5 s of real time for it.
describe("a reply over the DHT", { timeout: 30_000 }, () => {
  function setup() {
    const link = createLink(), params = [link.mine, link.invite];
    const packets = new Map<string, SignedPacket>();
    const saved: DhtDeliveryState[] = [emptyDhtDeliveryState(), emptyDhtDeliveryState()];
    const credentials: PairingCredentials[] = [0, 1].map(() => ({ seedB64: createIdentity().seedB64 }));
    const messages = [new Map<string, { text: string; reply?: { i: string } }>(), new Map<string, { text: string; reply?: { i: string } }>()];
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
      message: async m => { messages[i].set(m.id, { text: m.text, ...(m.reply && { reply: m.reply }) }); }, receipt: async () => {}, changed: () => {}, pollMs: 100 });
    return { make, messages, saved };
  }
  afterEach(() => vi.useRealTimers());

  it("carries only the original's id, which the reader gets beside the text", async () => {
    vi.useFakeTimers();
    const h = setup(), a = h.make(0), b = h.make(1);
    await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4500);
    expect(await a.send("yes, that one", Date.now(), "abcdefghijklmnopqrstuv", "C".repeat(22))).toBeNull();
    expect(h.saved[0].pending?.reply).toBe("C".repeat(22));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.messages[1].get("abcdefghijklmnopqrstuv")).toEqual({ text: "yes, that one", reply: { i: "C".repeat(22) } });
    // A text that answers nothing carries no reply.
    expect(await b.send("ok", Date.now(), "bcdefghijklmnopqrstuvw")).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.messages[0].get("bcdefghijklmnopqrstuvw")).toEqual({ text: "ok" });
    await a.stop(); await b.stop();
  });

  it("a text near the bound goes without the id when both do not fit: the text is what matters", async () => {
    vi.useFakeTimers();
    const h = setup(), a = h.make(0), b = h.make(1);
    await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4500);
    expect(a.validate("x".repeat(256), Date.now(), "abcdefghijklmnopqrstuv", "D".repeat(22))).toBeNull();
    expect(a.validate("hi", Date.now(), "abcdefghijklmnopqrstuv", "not an id!")).toBe("Invalid message.");
    expect(await a.send("x".repeat(256), Date.now(), "abcdefghijklmnopqrstuv", "D".repeat(22))).toBeNull();
    expect(h.saved[0].pending?.reply).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.messages[1].get("abcdefghijklmnopqrstuv")).toEqual({ text: "x".repeat(256) });
    await a.stop(); await b.stop();
  });

  it("a shorter text keeps it", async () => {
    vi.useFakeTimers();
    const h = setup(), a = h.make(0), b = h.make(1);
    await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4500);
    expect(await a.send("y".repeat(200), Date.now(), "abcdefghijklmnopqrstuv", "D".repeat(22))).toBeNull();
    expect(h.saved[0].pending?.reply).toBe("D".repeat(22));
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

describe("a reply in a private group", () => {
  it("is sealed apart from the text, beside the mentions, and every member gets it", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice), carol = await net.admit(alice);
    const sent = await alice.sendText("lunch?", Date.now());
    await net.settle();
    const original = (sent as { id: string }).id;
    const reply = { i: original, s: "lunch?", f: alice.myKey };
    expect(await bob.sendText("@Alice yes", Date.now(), [{ k: alice.myKey, o: 0, l: 6 }], reply)).toHaveProperty("id");
    await net.settle();
    for (const s of [alice, bob, carol]) {
      const got = net.inbox.get(s.myKey)!.find(m => m.text === "@Alice yes")!;
      expect(got.reply).toEqual(reply);
      expect(got.mentions).toEqual([{ k: alice.myKey, o: 0, l: 6 }]);
    }
    // Nothing of it in the clear: not the line, not the key it names.
    const frame = bob.state.sent[bob.state.sent.length - 1];
    expect(frame.r).toBeDefined();
    expect(JSON.stringify(frame)).not.toContain("lunch");
  });

  it("older apps: a frame without the box, or with a broken or moved one, still delivers its text", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice);
    const heard: GroupIncomingMessage[] = [];
    const reader = new GroupSession(clone(bob.state), { save: async () => {}, send: () => {}, message: m => { heard.push(m); }, changed: () => {} });
    const reply = { i: `${alice.myKey}:0:0`, s: "x", f: alice.myKey };
    await alice.sendText("one", Date.now(), [], reply);
    await alice.sendText("two", Date.now());
    await alice.sendText("three", Date.now(), [], reply);
    await net.settle();
    const [one, two, three] = alice.state.sent.slice(-3).map(clone) as GroupMessageFrame[];
    await reader.handle(alice.myKey, { ...one, r: undefined });
    await reader.handle(alice.myKey, { ...two, r: three.r });
    await reader.handle(alice.myKey, { ...three, r: { n: three.r!.n, c: three.r!.c.slice(0, -4) + "AAAA" } });
    expect(heard.map(m => [m.text, m.reply])).toEqual([["one", undefined], ["two", undefined], ["three", undefined]]);
  });

  it("a reply whose author is not a member key is left out, never the text", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice);
    await alice.sendText("hi", Date.now(), [], { i: ID, s: "x", f: "sender" });
    await net.settle();
    const got = net.inbox.get(bob.myKey)!.find(m => m.text === "hi")!;
    expect(got.reply).toBeUndefined();
    expect(alice.state.sent[alice.state.sent.length - 1]!.r).toBeUndefined();
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

describe("a reply in a community", () => {
  it("rides inside the sealed payload, which an older app parses as it always has", async () => {
    const net = community();
    const alice = net.push(CommunitySession.create("Ghosts"));
    const bob = await net.admit(alice);
    await net.settle();
    const reply = { i: `${alice.myKey}:0:abc:1`, s: "the ‮plan", f: alice.myKey };
    expect(await bob.sendText("agreed", "Bob", Date.now(), [], reply)).toHaveProperty("id");
    await net.settle();
    expect(net.inbox.get(alice.myKey)!.find(m => m.text === "agreed")!.reply).toEqual({ ...reply, s: "the plan" });
    const frame = net.broadcasts.filter(f => f.t === "group-msg").pop() as CommunityMessageFrame;
    const secret = alice.state.secrets[Object.keys(alice.state.secrets).find(h => h.startsWith(frame.h))!];
    const plain = decryptText(epochKeys(fromBase64Url(secret), frame.g, frame.e).message, JSON.stringify([frame.g, frame.e, frame.h, frame.s, frame.n, frame.ts]), frame.nn, frame.c);
    expect(JSON.parse(plain!)).toMatchObject({ text: "agreed", nick: "Bob", r: { ...reply, s: "the plan" } });
  });

  it("counts against the text's 16 KiB", async () => {
    const net = community();
    const alice = net.push(CommunitySession.create("Ghosts"));
    await net.admit(alice);
    await net.settle();
    const reply = { i: `${alice.myKey}:0:abc:1`, s: "x".repeat(100), f: alice.myKey };
    expect(await alice.sendText("y".repeat(COMMUNITY_LIMITS.textBytes - 50), "Alice", Date.now(), [], reply)).toEqual({ error: "Message exceeds 16 KiB" });
    expect(await alice.sendText("y".repeat(COMMUNITY_LIMITS.textBytes - 50), "Alice", Date.now())).toHaveProperty("id");
  });
});
