import { describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import type { GhostRecord, SignedPacket } from "../src/pkarr";
import { CapsKeys, CapsRefusedError, capsDescriptors, type CapsContent } from "../src/capsRecord";
// covers: chat.caps-record

// The X25519 the capability record runs, counted: noble's object is frozen, so it is counted through the module.
const shared = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@noble/curves/ed25519.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@noble/curves/ed25519.js")>();
  return { ...original, x25519: { ...original.x25519, getSharedSecret: (...args: Parameters<typeof original.x25519.getSharedSecret>) => { shared.calls++; return original.x25519.getSharedSecret(...args); } } };
});

const content = (): CapsContent => ({ versions: [1], transports: ["webrtc/1"], capabilities: ["chat/1"], extensions: [], descriptors: capsDescriptors({}), name: "Ada" });
const packetOf = (keys: CapsKeys, records: GhostRecord[]): SignedPacket => ({ pubKeyZ32: keys.identity.pubKeyZ32, timestampMicros: 0n, records });

// agents#1087: every seal and every open after the pin ran an X25519 of the participation keys again (78 ms of a
// 657 ms start task at 4x CPU with 50 chats). Once per contact and link.
describe("the key a capability record is sealed with for the pinned contact", () => {
  it("is derived once per link, however often it seals and opens", () => {
    const link = createLink(), a = createIdentity(), b = createIdentity();
    const aKeys = new CapsKeys(link.mine, a.seedB64), bKeys = new CapsKeys(link.invite, b.seedB64);
    shared.calls = 0;
    for (let rev = 1; rev <= 4; rev++) {
      const sealed = aKeys.seal(content(), rev, b.pubKeyZ32);
      expect(bKeys.open(packetOf(aKeys, sealed.records), { pinned: a.pubKeyZ32 })).toMatchObject({ rev, author: a.pubKeyZ32 });
    }
    expect(shared.calls, "one for A's seals, one for B's opens").toBe(2);
    // Another contact pinned (a re-pin) has a key of its own, never the first one's.
    const other = aKeys.seal(content(), 5, createIdentity().pubKeyZ32);
    expect(() => bKeys.open(packetOf(aKeys, other.records), { pinned: a.pubKeyZ32 })).toThrow(CapsRefusedError);
    expect(shared.calls, "A's seal for the new contact; B opens with the key it has").toBe(3);
  });
});
