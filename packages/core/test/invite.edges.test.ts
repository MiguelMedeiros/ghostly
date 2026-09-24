import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fromBase64Url, toBase64Url } from "../src/bytes";
import { createLink, decodeInviteCode, encodeInviteCode, type LinkParams } from "../src/invite";
import { createIdentity } from "../src/identity";

// covers: invite.formats, invite.invalid

const seedB64 = "A".repeat(43), encKeyB64 = "B".repeat(43);
const peerPubKeyZ32 = createIdentity().pubKeyZ32;
const legacy: LinkParams = { seedB64, peerPubKeyZ32, encKeyB64 };

describe("invite codes", () => {
  it("round-trips legacy, paired and paired-over-DHT invites, bare and inside an app URL", () => {
    const paired: LinkParams = { ...legacy, profile: "paired-chat/1" };
    const dht: LinkParams = { ...paired, deliveryMode: "dht" };
    expect(encodeInviteCode(legacy)).toBe(`${seedB64}/${peerPubKeyZ32}/${encKeyB64}`);
    expect(encodeInviteCode(paired)).toBe(`pair1/${seedB64}/${peerPubKeyZ32}/${encKeyB64}`);
    expect(encodeInviteCode(dht)).toBe(`pair2d/${seedB64}/${peerPubKeyZ32}/${encKeyB64}`);
    for (const params of [legacy, paired, dht]) {
      const code = encodeInviteCode(params);
      expect(decodeInviteCode(code)).toEqual(params);
      expect(decodeInviteCode(`https://app.ghostly.tools/#/chat/${code}`)).toEqual(params);
      expect(decodeInviteCode(`#chat/${code}`)).toEqual(params);
      expect(decodeInviteCode(`  ${code}\n`)).toEqual(params);
    }
  });

  it("ignores a delivery mode without a profile, as the desktop format has no room for it", () => {
    expect(encodeInviteCode({ ...legacy, deliveryMode: "dht" })).toBe(encodeInviteCode(legacy));
  });

  it("refuses the wrong number of segments", () => {
    expect(decodeInviteCode(`${seedB64}/${peerPubKeyZ32}`)).toBeNull();
    expect(decodeInviteCode(`${seedB64}/${peerPubKeyZ32}/${encKeyB64}/x`)).toBeNull();
    expect(decodeInviteCode(`pair1/${seedB64}/${peerPubKeyZ32}`)).toBeNull();
    expect(decodeInviteCode("")).toBeNull();
  });

  it.each([
    ["a short seed", `${seedB64.slice(1)}/${peerPubKeyZ32}/${encKeyB64}`],
    ["a seed with a base64 '+'", `+${seedB64.slice(1)}/${peerPubKeyZ32}/${encKeyB64}`],
    ["a long peer key", `${seedB64}/${peerPubKeyZ32}y/${encKeyB64}`],
    ["a peer key outside z-base-32", `${seedB64}/${"0".repeat(52)}/${encKeyB64}`],
    ["a short key", `${seedB64}/${peerPubKeyZ32}/${encKeyB64.slice(1)}`],
    ["an unknown profile prefix", `pair3/${seedB64}/${peerPubKeyZ32}/${encKeyB64}`],
  ])("refuses %s", (_, code) => {
    expect(decodeInviteCode(code)).toBeNull();
  });

  it("creates two ends that point at each other and share a 32-byte key", () => {
    const { mine, invite } = createLink();
    expect(mine.encKeyB64).toBe(invite.encKeyB64);
    expect(fromBase64Url(mine.encKeyB64)).toHaveLength(32);
    expect(mine.seedB64).not.toBe(invite.seedB64);
    expect(mine.peerPubKeyZ32).not.toBe(invite.peerPubKeyZ32);
  });

  it("round-trips any well-formed invite, and never throws on arbitrary input", () => {
    const b43 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(toBase64Url);
    fc.assert(fc.property(b43, b43, fc.constantFrom<Partial<LinkParams>>({}, { profile: "paired-chat/1" }, { profile: "paired-chat/1", deliveryMode: "dht" }),
      (seed, key, extra) => {
        const params = { seedB64: seed, peerPubKeyZ32, encKeyB64: key, ...extra };
        expect(decodeInviteCode(encodeInviteCode(params))).toEqual(params);
      }), { numRuns: 100 });
    fc.assert(fc.property(fc.string({ maxLength: 200 }), input => { decodeInviteCode(input); }), { numRuns: 200 });
  });
});
