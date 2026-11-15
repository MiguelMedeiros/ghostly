import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { epochKeys, groupCallKey } from "../src/groupCrypto";
import { CommunitySession, type CommunityFrame, type CommunityState } from "../src/groupCommunity";

// covers: groups.protocol.call-key

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => Uint8Array.from(s.match(/../g)!, x => parseInt(x, 16));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("group call key (WISP 602)", () => {
  // HKDF-SHA256(ikm = epoch secret, salt = utf8(g + "/" + e), info = utf8("ghostly-group-call/1 g_" + g), 32), computed with node:crypto alone.
  const secret = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  const g = "oKGio6SlpqeoqaqrrK2urw";

  it("matches the test vector", () => {
    expect(hex(groupCallKey(secret, g, 0))).toBe("98b9e5ecd23848edf7083ddc69bf60aaa4104ae12c5ebf8ccbb351824d3261a9");
    expect(hex(groupCallKey(secret, g, 7))).toBe("8dc294706ba9eda419d5eb20aa885b3a56f2abcd9a69fca65aa05d71f3488630");
    expect(hex(groupCallKey(secret, g, 8))).toBe("c63a39d1f378b41f795a0f4b1606885968673ee26928fba4ce6508270464aacb");
  });

  it("is never the epoch's message or confirmation key", () => {
    const keys = epochKeys(secret, g, 7), call = hex(groupCallKey(secret, g, 7));
    expect(call).not.toBe(hex(keys.message));
    expect(call).not.toBe(hex(keys.confirm));
  });

  it("refuses an epoch secret that is not 32 bytes", () => {
    for (const n of [0, 16, 31, 33]) expect(() => groupCallKey(new Uint8Array(n), g, 0)).toThrow("Invalid epoch secret");
  });
});

describe("a community session's call key", () => {
  interface Member { session: CommunitySession; saved: CommunityState }
  const members: Member[] = [];
  const pending: Promise<unknown>[] = [];
  const hooks = (me: () => Member) => ({
    save: async (state: CommunityState) => { me().saved = state; },
    broadcast: (frame: CommunityFrame) => members.filter(m => m !== me()).map(m => pending.push(m.session.handle(me().session.myKey, clone(frame)))).length,
    direct: (to: string, frame: CommunityFrame) => { const m = members.find(x => x.session.myKey === to); if (m) pending.push(m.session.handle(me().session.myKey, clone(frame))); },
    addressed: (to: string, frame: CommunityFrame) => { const m = members.find(x => x.session.myKey === to); if (m) pending.push(m.session.handle(me().session.myKey, clone(frame))); },
    message: () => {},
    changed: () => {},
    clock: () => Date.now(),
  });
  const settle = async () => { for (let i = 0; i < 200 && pending.length; i++) await Promise.all(pending.splice(0)); };
  const admit = async (by: Member): Promise<Member> => {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.session.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await settle();
    const joined = CommunitySession.join({ g: by.session.id, host: by.session.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    const member = { saved: joined.state } as Member;
    member.session = new CommunitySession(joined.state, hooks(() => member));
    members.push(member);
    return member;
  };

  it("is the same for every member of an epoch, and a new one when a member joins", async () => {
    const state = CommunitySession.create("Ghosts");
    const ana = { saved: state } as Member;
    ana.session = new CommunitySession(state, hooks(() => ana));
    members.push(ana);
    const alone = ana.session.callKey();
    expect(alone?.epoch).toBe(ana.session.epoch);
    expect(alone?.key).toHaveLength(32);

    const bob = await admit(ana);
    const before = ana.session.callKey()!;
    expect(before.epoch).toBe(bob.session.epoch);
    expect(hex(bob.session.callKey()!.key)).toBe(hex(before.key));
    expect(hex(before.key)).not.toBe(hex(alone!.key));

    await admit(ana);
    await settle();
    const after = bob.session.callKey()!;
    expect(after.epoch).toBe(before.epoch + 1);
    expect(hex(after.key)).toBe(hex(ana.session.callKey()!.key));
    expect(hex(after.key)).not.toBe(hex(before.key));
  });
});
