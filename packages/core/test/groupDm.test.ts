import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { createChatInvite } from "../src/invite";
import { CommunitySession, type CommunityFrame, type CommunityIncomingPair, type CommunityState } from "../src/groupCommunity";
import {
  DM_LIMITS, DmGate, GROUP_PAIR_FRAME, GroupPairInbox, GroupPairRelay, PAIR_FRESH_MS, PAIRS_PER_MINUTE,
  dmAnswer, dmRequest, readDmBody, readDmPayload, readGroupPair, sealGroupPair, type GroupPairFrame,
} from "../src/groupDm";
// covers: groups.protocol.private-message

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const GROUP = "AAAAAAAAAAAAAAAAAAAAAA", OTHER_GROUP = "BBBBBBBBBBBBBBBBBBBBBB";

describe("a private-message request", () => {
  it("carries a ghostly1 code and the inviter's participation key that code pins", () => {
    const { inviteCode, invite } = createChatInvite();
    const body = dmRequest(inviteCode, "Alice");
    expect(body).toEqual({ t: "req", c: inviteCode, k: invite.peerParticipationKeyZ32, n: "Alice" });
    expect(readDmBody(clone(body))).toEqual(body);
    expect(readDmBody({ t: "req", c: inviteCode, k: invite.peerParticipationKeyZ32 })).toEqual({ t: "req", c: inviteCode, k: invite.peerParticipationKeyZ32 });
  });

  it("is refused when its key is not the one its code pins, or its code is not a bare ghostly1 code", () => {
    const { inviteCode } = createChatInvite();
    const other = createChatInvite();
    const k = dmRequest(inviteCode).k;
    expect(readDmBody({ t: "req", c: inviteCode, k: other.invite.peerParticipationKeyZ32 })).toBeNull();
    expect(readDmBody({ t: "req", c: `https://ghostly.tools/#${inviteCode}`, k })).toBeNull();
    expect(readDmBody({ t: "req", c: inviteCode.toUpperCase(), k })).toBeNull();
    expect(readDmBody({ t: "req", c: `${inviteCode.slice(0, -1)}${inviteCode.endsWith("q") ? "p" : "q"}`, k })).toBeNull();
    const { encKeyB64, peerPubKeyZ32, seedB64 } = other.invite;
    expect(readDmBody({ t: "req", c: `pair1/${seedB64}/${peerPubKeyZ32}/${encKeyB64}`, k })).toBeNull();
    expect(readDmBody({ t: "req", c: inviteCode, k, n: "x".repeat(DM_LIMITS.nameChars + 1) })).toBeNull();
    expect(readDmBody({ t: "req", c: inviteCode, k, n: "  " })).toBeNull();
    expect(readDmBody({ t: "req", c: inviteCode, k, n: 7 })).toBeNull();
    expect(readDmBody({ t: "hello", k })).toBeNull();
    expect(readDmBody(null)).toBeNull();
  });

  it("is refused when its name has invisible or direction-changing characters, or nothing visible", () => {
    const { inviteCode, invite } = createChatInvite();
    const k = invite.peerParticipationKeyZ32;
    for (const n of ["​", "Alice‮ecilA", "⁦Alice", "Al​ice", "⠀", "́"]) {
      expect(readDmBody({ t: "req", c: inviteCode, k, n }), JSON.stringify(n)).toBeNull();
      expect(() => dmRequest(inviteCode, n), JSON.stringify(n)).toThrow();
    }
    for (const n of ["Alice", "Zoë 🦊", "👩‍💻", "علي", "דנה", "さくら"]) expect(readDmBody({ t: "req", c: inviteCode, k, n })).toEqual({ t: "req", c: inviteCode, k, n });
  });

  it("is answered by the request's key: shown (got) or declined (no)", () => {
    const k = dmRequest(createChatInvite().inviteCode).k;
    expect(readDmBody(dmAnswer("got", k))).toEqual({ t: "got", k });
    expect(readDmBody(dmAnswer("no", k))).toEqual({ t: "no", k });
    expect(readDmBody({ t: "no", k: "not a key" })).toBeNull();
    expect(readDmBody({ t: "got" })).toBeNull();
  });

  it("is read from a community pair payload under `dm` only", () => {
    const body = dmRequest(createChatInvite().inviteCode);
    expect(readDmPayload({ dm: body })).toEqual(body);
    expect(readDmPayload({ pm: ["cashu"] })).toBeNull();
    expect(readDmPayload({ dm: { t: "req" } })).toBeNull();
  });
});

describe("the group-pair frame of a private group", () => {
  const alice = createIdentity(), bob = createIdentity(), carol = createIdentity();
  const members = new Set([alice.pubKeyZ32, bob.pubKeyZ32, carol.pubKeyZ32]);
  const member = (key: string) => members.has(key);
  const { inviteCode } = createChatInvite();
  const payload = { dm: dmRequest(inviteCode, "Alice") };

  it("opens only for its recipient, as from its sender, and shows no one else the code", () => {
    const frame = sealGroupPair(alice, GROUP, bob.pubKeyZ32, payload);
    expect(frame.t).toBe(GROUP_PAIR_FRAME);
    expect(JSON.stringify(frame)).not.toContain(inviteCode);
    expect(new GroupPairInbox(bob).open(clone(frame), { group: GROUP, edge: alice.pubKeyZ32, member })).toEqual({ from: alice.pubKeyZ32, payload });
    // The hub carrying it, or any member: nothing.
    expect(new GroupPairInbox(carol).open(clone(frame), { group: GROUP, edge: alice.pubKeyZ32, member })).toBeNull();
  });

  it("does not open once a hub changed whom it is from, for, when or which group", () => {
    const frame = sealGroupPair(alice, GROUP, bob.pubKeyZ32, payload);
    const open = (f: GroupPairFrame, edge = carol.pubKeyZ32) => new GroupPairInbox(bob).open({ ...clone(f), h: 1 }, { group: f.g, edge, member });
    expect(open(frame)).not.toBeNull();
    expect(open({ ...frame, from: carol.pubKeyZ32 })).toBeNull();
    expect(open({ ...frame, ts: frame.ts + 1 })).toBeNull();
    expect(open({ ...frame, g: OTHER_GROUP })).toBeNull();
    // A box Carol seals claiming to be Alice does not open as Alice's.
    const forged = sealGroupPair({ ...carol, pubKeyZ32: alice.pubKeyZ32 }, GROUP, bob.pubKeyZ32, payload);
    expect(open(forged)).toBeNull();
  });

  it("is taken once, fresh, from the member on the edge or handed on for a member of the roster", () => {
    const now = Date.now();
    const inbox = new GroupPairInbox(bob, () => now);
    const frame = sealGroupPair(alice, GROUP, bob.pubKeyZ32, payload, now);
    // Straight from the edge: only from the member at its other end.
    expect(inbox.open(clone(frame), { group: GROUP, edge: carol.pubKeyZ32, member })).toBeNull();
    expect(inbox.open(clone(frame), { group: GROUP, edge: alice.pubKeyZ32, member })).not.toBeNull();
    // The same frame again, from a hub: once only.
    expect(inbox.open({ ...clone(frame), h: 1 }, { group: GROUP, edge: carol.pubKeyZ32, member })).toBeNull();
    // Handed on for someone the roster does not have.
    const stranger = createIdentity();
    expect(inbox.open({ ...sealGroupPair(stranger, GROUP, bob.pubKeyZ32, payload, now), h: 1 }, { group: GROUP, edge: carol.pubKeyZ32, member })).toBeNull();
    // Another group's session.
    expect(inbox.open(sealGroupPair(alice, GROUP, bob.pubKeyZ32, payload, now), { group: OTHER_GROUP, edge: alice.pubKeyZ32, member })).toBeNull();
    // Too old, or from too far ahead.
    expect(inbox.open(sealGroupPair(alice, GROUP, bob.pubKeyZ32, payload, now - PAIR_FRESH_MS - 1), { group: GROUP, edge: alice.pubKeyZ32, member })).toBeNull();
    expect(inbox.open(sealGroupPair(alice, GROUP, bob.pubKeyZ32, payload, now + 3 * 60_000), { group: GROUP, edge: alice.pubKeyZ32, member })).toBeNull();
  });

  it("refuses a malformed frame and a payload past its bound", () => {
    const frame = sealGroupPair(alice, GROUP, bob.pubKeyZ32, payload);
    expect(readGroupPair(clone(frame))).not.toBeNull();
    expect(readGroupPair({ ...frame, to: frame.from })).toBeNull();
    expect(readGroupPair({ ...frame, h: 2 })).toBeNull();
    expect(readGroupPair({ ...frame, ts: "1" })).toBeNull();
    expect(readGroupPair({ ...frame, n: "!" })).toBeNull();
    // A pair box's key and nonce, as a community's: 32 and 24 bytes.
    expect(readGroupPair({ ...frame, n: `${frame.n}A` })).toBeNull();
    expect(readGroupPair({ ...frame, n: "A".repeat(4_096) })).toBeNull();
    expect(readGroupPair({ ...frame, e: frame.e.slice(1) })).toBeNull();
    expect(readGroupPair({ ...frame, e: "A".repeat(4_096) })).toBeNull();
    expect(() => sealGroupPair(alice, GROUP, bob.pubKeyZ32, { pad: "x".repeat(DM_LIMITS.payloadBytes) })).toThrow();
  });

  it("is passed on by a hub once, to whom it is for, only from its own sender, at most PAIRS_PER_MINUTE a minute", () => {
    let now = Date.now();
    const relay = new GroupPairRelay(() => now);
    const frame = sealGroupPair(alice, GROUP, bob.pubKeyZ32, payload, now);
    const ctx = { group: GROUP, edge: alice.pubKeyZ32, member };
    // Not from the member at the other end of the edge it came on.
    expect(relay.pass(clone(frame), { ...ctx, edge: carol.pubKeyZ32 })).toBeNull();
    expect(relay.pass({ ...clone(frame), h: 1 }, ctx)).toBeNull();
    expect(relay.pass(clone(frame), ctx)).toEqual({ ...frame, h: 1 });
    expect(relay.pass(clone(frame), ctx)).toBeNull();
    // For someone out of the roster.
    expect(relay.pass(sealGroupPair(alice, GROUP, createIdentity().pubKeyZ32, payload, now), ctx)).toBeNull();
    let passed = 1;
    for (let i = 0; i < PAIRS_PER_MINUTE + 5; i++) if (relay.pass(sealGroupPair(alice, GROUP, carol.pubKeyZ32, payload, now), ctx)) passed++;
    expect(passed).toBe(PAIRS_PER_MINUTE);
    now += 60_000;
    expect(relay.pass(sealGroupPair(alice, GROUP, carol.pubKeyZ32, payload, now), ctx)).not.toBeNull();
  });

  it("is not passed on by a hub when its key or nonce is not a pair box's, which the hub cannot open to tell", () => {
    const relay = new GroupPairRelay();
    const ctx = { group: GROUP, edge: alice.pubKeyZ32, member };
    const frame = sealGroupPair(alice, GROUP, bob.pubKeyZ32, payload);
    expect(relay.pass({ ...clone(frame), n: "A".repeat(4_096) }, ctx)).toBeNull();
    expect(relay.pass({ ...clone(frame), e: "A".repeat(4_096) }, ctx)).toBeNull();
    expect(relay.pass(clone(frame), ctx)).toEqual({ ...frame, h: 1 });
  });
});

describe("the request limits", () => {
  const bob = createIdentity().pubKeyZ32, carol = createIdentity().pubKeyZ32;

  it("one request per member every ten minutes, three a day", () => {
    const start = 1_800_000_000_000;
    const gate = new DmGate();
    expect(gate.take(GROUP, bob, start)).toBeNull();
    expect(gate.take(GROUP, bob, start + DM_LIMITS.everyMs - 1)).toBe("soon");
    // Per member and per group.
    expect(gate.take(GROUP, carol, start)).toBeNull();
    expect(gate.take(OTHER_GROUP, bob, start)).toBeNull();
    expect(gate.take(GROUP, bob, start + DM_LIMITS.everyMs)).toBeNull();
    expect(gate.take(GROUP, bob, start + 2 * DM_LIMITS.everyMs)).toBeNull();
    expect(gate.check(GROUP, bob, start + 3 * DM_LIMITS.everyMs)).toBe("day");
    expect(gate.take(GROUP, bob, start + 3 * DM_LIMITS.everyMs)).toBe("day");
    expect(gate.take(GROUP, bob, start + DM_LIMITS.dayMs)).toBeNull();
  });

  it("a day after a decline before the same member asks again, kept across a restart", () => {
    const start = 1_800_000_000_000;
    const gate = new DmGate();
    expect(gate.take(GROUP, bob, start)).toBeNull();
    gate.declined(GROUP, bob, start + 1_000);
    const again = new DmGate(clone(gate.state(start + 1_000)));
    expect(again.take(GROUP, bob, start + DM_LIMITS.everyMs + 1_000)).toBe("declined");
    expect(again.take(GROUP, bob, start + 1_000 + DM_LIMITS.declinedMs)).toBeNull();
    // What is past every window is not kept.
    expect(again.state(start + 1_000 + DM_LIMITS.declinedMs)).toEqual({ [`${GROUP} ${bob}`]: { at: [start + 1_000 + DM_LIMITS.declinedMs] } });
  });

  it("reads a damaged saved state as empty", () => {
    expect(new DmGate({ x: { at: "no" } } as never).take(GROUP, bob, 1)).toBeNull();
  });
});

describe("a request through a community's hubs", { timeout: 60_000 }, () => {
  it("reaches only the member it is for, and nobody else's copy shows the code", async () => {
    const pending: Promise<unknown>[] = [];
    const wire: CommunityFrame[] = [];
    const sessions = new Map<string, CommunitySession>();
    const pairs = new Map<string, CommunityIncomingPair[]>();
    const add = (name: string, state: CommunityState) => {
      pairs.set(name, []);
      const session: CommunitySession = new CommunitySession(state, {
        save: async () => {},
        broadcast: frame => { wire.push(clone(frame)); for (const other of sessions.values()) if (other !== session) pending.push(other.handle(session.myKey, clone(frame))); },
        direct: (to, frame) => { for (const other of sessions.values()) if (other.myKey === to) pending.push(other.handle(session.myKey, clone(frame))); },
        addressed: (to, frame) => { for (const other of sessions.values()) if (other.myKey === to) pending.push(other.handle(session.myKey, clone(frame))); },
        message: () => {}, app: () => {}, changed: () => {},
        pair: m => { pairs.get(name)!.push(m); },
      });
      sessions.set(name, session);
      return session;
    };
    const settle = async () => { for (let i = 0; i < 200 && pending.length; i++) await Promise.all(pending.splice(0)); };
    const admit = async (by: CommunitySession, name: string) => {
      const seedB64 = createIdentity().seedB64;
      const frames = await by.admit(identityFromSeedB64(seedB64).pubKeyZ32);
      await settle();
      const joined = CommunitySession.join({ g: by.id, host: by.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
      if ("error" in joined) throw new Error(joined.error);
      return add(name, joined.state);
    };
    const alice = add("alice", CommunitySession.create("Ghosts"));
    const bob = await admit(alice, "bob");
    await admit(bob, "carol");
    await settle();

    const { inviteCode } = createChatInvite();
    expect(await alice.sendPair(bob.myKey, { dm: dmRequest(inviteCode, "Alice") })).toHaveProperty("id");
    await settle();
    expect(pairs.get("bob")!.map(p => readDmPayload(p.payload))).toEqual([dmRequest(inviteCode, "Alice")]);
    expect(pairs.get("carol")).toEqual([]);
    expect(JSON.stringify(wire)).not.toContain(inviteCode);
  });
});
