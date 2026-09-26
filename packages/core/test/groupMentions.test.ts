import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64, publicKeyFromZ32, verify } from "../src/identity";
import { fromBase64Url, utf8Encode } from "../src/bytes";
import { decryptText, epochKeys } from "../src/groupCrypto";
import { MENTION_EVERYONE, MENTION_LIMITS, mentionsBytes, mentionsMember, validMentions, type GroupMention } from "../src/groupMentions";
import { GroupSession, type GroupEdgeFrame, type GroupIncomingMessage, type GroupMessageFrame } from "../src/groupSession";
import { COMMUNITY_LIMITS, CommunitySession, type CommunityFrame, type CommunityIncomingMessage, type CommunityMessageFrame } from "../src/groupCommunity";
// covers: groups.protocol.mentions

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const key = () => createIdentity().pubKeyZ32;

describe("mention lists", () => {
  const bob = key(), carol = key();
  it("keeps places that start with @ and name a member key, in order and apart", () => {
    const text = "@Bob and @Carol, dinner?";
    expect(validMentions([{ k: carol, o: 9, l: 6 }, { k: bob, o: 0, l: 4 }], text, false)).toEqual([{ k: bob, o: 0, l: 4 }, { k: carol, o: 9, l: 6 }]);
    // Not an "@" there, past the end, too short, too long, not a key, overlapping: each dropped on its own.
    expect(validMentions([{ k: bob, o: 1, l: 3 }], text, false)).toEqual([]);
    expect(validMentions([{ k: bob, o: 20, l: 10 }], text, false)).toEqual([]);
    expect(validMentions([{ k: bob, o: 0, l: 1 }], text, false)).toEqual([]);
    expect(validMentions([{ k: bob, o: 0, l: MENTION_LIMITS.chars + 1 }], "@" + "b".repeat(80), false)).toEqual([]);
    expect(validMentions([{ k: "Bob", o: 0, l: 4 }, { k: bob, o: -1, l: 4 }, { k: bob, o: 0.5, l: 4 }, null, "x"], text, false)).toEqual([]);
    expect(validMentions([{ k: bob, o: 0, l: 12 }, { k: carol, o: 9, l: 6 }], text, false)).toEqual([{ k: bob, o: 0, l: 12 }]);
    // Unknown fields are left out of what is kept.
    expect(validMentions([{ k: bob, o: 0, l: 4, name: "Bob" }], text, false)).toEqual([{ k: bob, o: 0, l: 4 }]);
  });
  it("counts in code points, so emoji before a mention do not shift it", () => {
    const text = "👻👻 @Bob";
    expect(validMentions([{ k: bob, o: 3, l: 4 }], text, false)).toEqual([{ k: bob, o: 3, l: 4 }]);
    expect(validMentions([{ k: bob, o: 5, l: 4 }], text, false)).toEqual([]);
  });
  it("names everyone only where it is allowed", () => {
    expect(validMentions([{ k: MENTION_EVERYONE, o: 0, l: 9 }], "@everyone hi", true)).toEqual([{ k: "*", o: 0, l: 9 }]);
    expect(validMentions([{ k: MENTION_EVERYONE, o: 0, l: 9 }], "@everyone hi", false)).toEqual([]);
    expect(mentionsMember([{ k: "*", o: 0, l: 9 }], bob)).toBe(true);
    expect(mentionsMember([{ k: carol, o: 0, l: 6 }], bob)).toBe(false);
    expect(mentionsMember(undefined, bob)).toBe(false);
  });
  it("drops a place holding a line break, a control or a direction character: no name has one", () => {
    const bob = key();
    for (const text of ["@Bob\nfake invoice", "@Bob\u202Eeoiovni", "@Bob\u0007", "@Bob\u2066x\u2069"]) {
      expect(validMentions([{ k: bob, o: 0, l: Array.from(text).length }], text, false)).toEqual([]);
    }
    expect(validMentions([{ k: bob, o: 0, l: 8 }], "@Bob Lee", false)).toEqual([{ k: bob, o: 0, l: 8 }]);
  });

  it("refuses a list over the bound whole, and anything that is not a list", () => {
    const text = "@a ".repeat(MENTION_LIMITS.count + 1);
    const list = Array.from({ length: MENTION_LIMITS.count + 1 }, (_, i) => ({ k: bob, o: i * 3, l: 2 }));
    expect(validMentions(list, text, false)).toEqual([]);
    expect(validMentions(list.slice(0, MENTION_LIMITS.count), text, false)).toHaveLength(MENTION_LIMITS.count);
    for (const raw of [undefined, null, "[]", { k: bob, o: 0, l: 2 }, 3]) expect(validMentions(raw, text, false)).toEqual([]);
  });
  it("sixteen mentions stay around a kilobyte and a half", () => {
    const list = Array.from({ length: MENTION_LIMITS.count }, (_, i) => ({ k: bob, o: i * 1000, l: MENTION_LIMITS.chars }));
    expect(mentionsBytes(list)).toBeLessThan(1600);
    expect(mentionsBytes([])).toBe(0);
  });
});

/** Mesh members wired directly, every edge open. `frames`: what each sent, for tampering with. */
function mesh() {
  const sessions = new Map<string, GroupSession>();
  const inbox = new Map<string, GroupIncomingMessage[]>();
  const frames: { from: string; to: string; frame: GroupEdgeFrame }[] = [];
  let pending: Promise<unknown>[] = [];
  const add = (state: ReturnType<typeof GroupSession.create>) => {
    const session: GroupSession = new GroupSession(state, {
      save: async () => {},
      send: (to, frame) => { frames.push({ from: session.myKey, to, frame: clone(frame) }); const t = sessions.get(to); if (t) pending.push(t.handle(session.myKey, clone(frame))); },
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
  return { add, admit, settle, inbox, frames };
}

describe("mentions in a private group", () => {
  it("round-trip sealed beside the text: sender, and each receiver, get the same list", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice), carol = await net.admit(alice);
    const mentions: GroupMention[] = [{ k: bob.myKey, o: 0, l: 4 }];
    expect(await carol.sendText("@Bob look", Date.now(), mentions)).toHaveProperty("id");
    await net.settle();
    for (const s of [alice, bob, carol]) expect(net.inbox.get(s.myKey)!.find(m => m.text === "@Bob look")!.mentions).toEqual(mentions);
    // The frame carries no key in the clear: the list is sealed under the epoch.
    const frame = net.frames.find(f => f.frame.t === "group-msg" && f.from === carol.myKey)!.frame as GroupMessageFrame;
    expect(frame.m).toBeDefined();
    expect(JSON.stringify(frame)).not.toContain(bob.myKey);
  });

  it("everyone: the admin's is kept, a member's is dropped on both sides", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice);
    const all = [{ k: MENTION_EVERYONE, o: 0, l: 9 }];
    await alice.sendText("@everyone lunch", Date.now(), all);
    await bob.sendText("@everyone me too", Date.now(), all);
    await net.settle();
    expect(net.inbox.get(bob.myKey)!.find(m => m.text === "@everyone lunch")!.mentions).toEqual(all);
    expect(net.inbox.get(alice.myKey)!.find(m => m.text === "@everyone me too")!.mentions).toBeUndefined();
    // Bob's own copy does not claim it either, and his frame carries no box at all.
    expect(net.inbox.get(bob.myKey)!.find(m => m.text === "@everyone me too")!.mentions).toBeUndefined();
    expect((net.frames.find(f => f.frame.t === "group-msg" && f.from === bob.myKey)!.frame as GroupMessageFrame).m).toBeUndefined();
  });

  it("older apps: the signature is the one they check, and a frame without the box, or with a broken one, still delivers its text", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice);
    // A copy of Bob that hears only what it is handed.
    const heard: GroupIncomingMessage[] = [];
    const reader = new GroupSession(clone(bob.state), { save: async () => {}, send: () => {}, message: m => { heard.push(m); }, changed: () => {} });
    await alice.sendText("@Bob hi", Date.now(), [{ k: bob.myKey, o: 0, l: 4 }]);
    await alice.sendText("plain", Date.now());
    await alice.sendText("@Bob broken", Date.now(), [{ k: bob.myKey, o: 0, l: 4 }]);
    await net.settle();
    const [hi, plain, broken] = alice.state.sent.slice(-3).map(clone);
    // What an app from before mentions verifies: the fields it knows, nothing else.
    const signed = utf8Encode(JSON.stringify(["ghostly-group/1 msg", hi.g, hi.e, hi.s, hi.n, hi.ts, hi.nn, hi.c]));
    expect(verify(fromBase64Url(hi.sig), signed, publicKeyFromZ32(hi.s))).toBe(true);
    // No box (an older sender, or a relay that dropped it), a box moved from another message, a mangled box: text, no mentions.
    await reader.handle(alice.myKey, { ...hi, m: undefined });
    await reader.handle(alice.myKey, { ...plain, m: broken.m });
    await reader.handle(alice.myKey, { ...broken, m: { n: broken.m!.n, c: broken.m!.c.slice(0, -4) + "AAAA" } });
    expect(heard.map(m => [m.text, m.mentions])).toEqual([["@Bob hi", undefined], ["plain", undefined], ["@Bob broken", undefined]]);
    // Bob, who got them whole, has the mentions.
    expect(net.inbox.get(bob.myKey)!.filter(m => m.mentions).map(m => m.text)).toEqual(["@Bob hi", "@Bob broken"]);
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

describe("mentions in a community", () => {
  it("round-trip inside the sealed payload, never everyone", async () => {
    const net = community();
    const alice = net.push(CommunitySession.create("Ghosts"));
    const bob = await net.admit(alice), carol = await net.admit(alice);
    await net.settle();
    expect(await carol.sendText("@Bob and @everyone", "Carol", Date.now(), [{ k: bob.myKey, o: 0, l: 4 }, { k: MENTION_EVERYONE, o: 9, l: 9 }])).toHaveProperty("id");
    await net.settle();
    for (const s of [alice, bob, carol]) expect(net.inbox.get(s.myKey)!.find(m => m.text === "@Bob and @everyone")!.mentions).toEqual([{ k: bob.myKey, o: 0, l: 4 }]);
    const frame = net.broadcasts.filter(f => f.t === "group-msg").pop() as CommunityMessageFrame;
    expect(JSON.stringify(frame)).not.toContain(bob.myKey);
    // An older app parses the payload as it always has: one text, a name, and a field it does not read.
    const secret = alice.state.secrets[Object.keys(alice.state.secrets).find(h => h.startsWith(frame.h))!];
    const plain = decryptText(epochKeys(fromBase64Url(secret), frame.g, frame.e).message, JSON.stringify([frame.g, frame.e, frame.h, frame.s, frame.n, frame.ts]), frame.nn, frame.c);
    expect(JSON.parse(plain!)).toMatchObject({ text: "@Bob and @everyone", nick: "Carol", m: [{ k: bob.myKey, o: 0, l: 4 }] });
  });

  it("mentions count against the text's 16 KiB, so the box stays within what older apps accept", async () => {
    const net = community();
    const alice = net.push(CommunitySession.create("Ghosts"));
    const bob = await net.admit(alice);
    await net.settle();
    const mention = [{ k: bob.myKey, o: 0, l: 4 }];
    const full = "@Bob" + "x".repeat(COMMUNITY_LIMITS.textBytes - 4);
    expect(await alice.sendText(full, "Alice", Date.now(), mention)).toEqual({ error: "Message exceeds 16 KiB" });
    const fits = full.slice(0, COMMUNITY_LIMITS.textBytes - mentionsBytes(mention));
    expect(await alice.sendText(fits, "Alice", Date.now(), mention)).toHaveProperty("id");
    await net.settle();
    const frame = net.broadcasts.filter(f => f.t === "group-msg").pop() as CommunityMessageFrame;
    // The bound an app from before mentions checks the box against.
    expect(frame.c.length).toBeLessThanOrEqual(Math.ceil((COMMUNITY_LIMITS.textBytes + 256 + 16) * 4 / 3) + 4);
    expect(net.inbox.get(bob.myKey)!.pop()!.mentions).toEqual(mention);
  });
});
