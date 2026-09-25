import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bech32, bech32m } from "@scure/base";
import { toBase64Url, toZ32 } from "../src/bytes";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import {
  createChatInvite, decodeInviteCode, encodeGhostlyInvite, encodeInviteCode, inviteLink, inviteQrSegments, inviteQrText, readInviteCode,
  INVITE_MAX_LENGTH, type LinkParams,
} from "../src/invite";

// covers: invite.code, invite.formats, invite.invalid

const run = (start: number) => Uint8Array.from({ length: 32 }, (_, i) => start + i);
/** WISP 801's test vector: synthetic bytes, not keys. */
const VECTOR_PARAMS: LinkParams = {
  profile: "paired-chat/1",
  seedB64: toBase64Url(run(0x00)),
  peerPubKeyZ32: toZ32(run(0x20)),
  encKeyB64: toBase64Url(run(0x40)),
  peerParticipationKeyZ32: toZ32(run(0x60)),
};
const VECTOR = "ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l8794pd4k";

/** A code from arbitrary words under our prefix, with a valid checksum. */
const made = (words: number[], hrp = "ghostly", codec = bech32m) => codec.encode(hrp, words, false);
const refusal = (input: string) => {
  const reading = readInviteCode(input);
  return reading.ok ? "ok" : reading.reason;
};

describe("ghostly1 invite codes (WISP 801)", () => {
  it("encodes the test vector exactly, 220 characters starting ghostly1p", () => {
    const code = encodeGhostlyInvite(VECTOR_PARAMS);
    expect(code).toBe(VECTOR);
    expect(code).toHaveLength(220);
    expect(code.startsWith("ghostly1p")).toBe(true);
  });

  it("decodes the test vector in lower, upper and mixed case, bare and in a link on either host", () => {
    const mixed = "Ghostly1" + VECTOR.slice(8);
    for (const input of [VECTOR, VECTOR.toUpperCase(), mixed, ` ${VECTOR}\n`,
      `https://ghostly.tools/#${VECTOR}`, `https://app.ghostly.tools/#${VECTOR}`, `HTTPS://GHOSTLY.TOOLS/#${VECTOR.toUpperCase()}`,
      `https://app.ghostly.tools/#/chat/${VECTOR}`]) {
      const reading = readInviteCode(input);
      expect(reading, input.slice(0, 40)).toEqual({ ok: true, format: "ghostly1", params: VECTOR_PARAMS });
    }
  });

  it("makes new chats as ghostly1 codes whose invite pins the inviter's participation key", () => {
    const { mine, invite, inviteCode } = createChatInvite();
    expect(inviteCode).toMatch(/^ghostly1p[02-9ac-hj-np-z]{211}$/);
    expect(decodeInviteCode(inviteCode)).toEqual(invite);
    expect(encodeInviteCode(invite)).toBe(inviteCode);
    expect(invite.peerParticipationKeyZ32).toBe(identityFromSeedB64(mine.participationSeedB64!).pubKeyZ32);
    expect(inviteCode).not.toContain(mine.participationSeedB64!);
    expect(mine.profile).toBe("paired-chat/1");
  });

  it("shares the link on ghostly.tools and puts the code in capitals for the QR's alphanumeric mode", () => {
    expect(inviteLink(VECTOR)).toBe(`https://ghostly.tools/#${VECTOR}`);
    expect(inviteLink(VECTOR, "https://app.ghostly.tools/")).toBe(`https://app.ghostly.tools/#${VECTOR}`);
    const qr = inviteQrText(VECTOR);
    expect(qr).toBe(VECTOR.toUpperCase());
    expect(qr).toMatch(/^[0-9A-Z]+$/);
    expect(inviteQrText(`pair1/${"a".repeat(43)}`)).toBe(`pair1/${"a".repeat(43)}`);
    const segments = inviteQrSegments(VECTOR);
    expect(segments).toEqual(["HTTPS://GHOSTLY.TOOLS/", "#", VECTOR.toUpperCase()]);
    // What a scanner hands back, the segments joined, reads as the invite.
    expect(decodeInviteCode(segments.join(""))).toEqual(VECTOR_PARAMS);
    expect(inviteQrSegments("pair1/x")).toEqual(["pair1/x"]);
  });

  it("reads every version-1 code it makes, and never throws on arbitrary input", () => {
    const key = fc.uint8Array({ minLength: 32, maxLength: 32 });
    fc.assert(fc.property(key, key, key, key, (seed, rendezvous, secret, participation) => {
      const params: LinkParams = { profile: "paired-chat/1", seedB64: toBase64Url(seed), peerPubKeyZ32: toZ32(rendezvous),
        encKeyB64: toBase64Url(secret), peerParticipationKeyZ32: toZ32(participation) };
      const code = encodeInviteCode(params);
      expect(code).toHaveLength(220);
      expect(decodeInviteCode(code)).toEqual(params);
      expect(decodeInviteCode(inviteQrText(code))).toEqual(params);
    }), { numRuns: 100 });
    fc.assert(fc.property(fc.string({ maxLength: 300 }), input => { readInviteCode(input); readInviteCode(`ghostly1${input}`); }), { numRuns: 300 });
  });
});

describe("refusals, each with its reason", () => {
  const payloadWords = bech32m.decode(VECTOR, INVITE_MAX_LENGTH).words.slice(1);

  it("a typo: one changed character, or a character outside the alphabet", () => {
    const i = 100, swapped = VECTOR[i] === "q" ? "p" : "q";
    expect(refusal(VECTOR.slice(0, i) + swapped + VECTOR.slice(i + 1))).toBe("typo");
    expect(refusal(VECTOR.slice(0, i) + "b" + VECTOR.slice(i + 1))).toBe("typo");
    expect(refusal(VECTOR.slice(0, -1))).toBe("typo");
    expect(refusal("ghostly1")).toBe("typo");
  });

  it("a newer Ghostly: versions 2 to 31 say update", () => {
    for (const version of [2, 3, 17, 31]) expect(refusal(made([version, ...payloadWords]))).toBe("update");
    expect(readInviteCode(made([2, ...payloadWords]))).toMatchObject({ ok: false, reason: "update", detail: "Version 2" });
  });

  it("not a Ghostly invite: version 0, bech32 instead of bech32m, another prefix, too long, anything else", () => {
    expect(refusal(made([0, ...payloadWords]))).toBe("not-ghostly");
    expect(refusal(made([1, ...payloadWords], "ghostly", bech32))).toBe("not-ghostly");
    expect(refusal(made([1, ...payloadWords], "npub"))).toBe("not-ghostly");
    expect(refusal(`lnbc1${"q".repeat(50)}`)).toBe("not-ghostly");
    expect(refusal(`ghostly1${"q".repeat(INVITE_MAX_LENGTH - 7)}`)).toBe("not-ghostly");
    expect(refusal("hello")).toBe("not-ghostly");
    expect(refusal("")).toBe("not-ghostly");
    expect(refusal("https://ghostly.tools/")).toBe("not-ghostly");
  });

  it("damaged: another payload length (96 bytes included), or non-zero padding", () => {
    const bytes = bech32m.fromWords(payloadWords);
    expect(refusal(made([1, ...bech32m.toWords(bytes.slice(0, 96))]))).toBe("damaged");
    expect(refusal(made([1, ...bech32m.toWords(Uint8Array.of(...bytes, 0))]))).toBe("damaged");
    const padded = [...payloadWords]; padded[padded.length - 1] |= 1;
    expect(refusal(made([1, ...padded]))).toBe("damaged");
    expect(refusal(made([1]))).toBe("damaged");
  });

  it("a known slash form with a malformed field is damaged, and names the field", () => {
    expect(readInviteCode(`pair1/${"A".repeat(43)}/${"0".repeat(52)}/${"B".repeat(43)}`)).toEqual({ ok: false, reason: "damaged", detail: "The contact's key is malformed" });
    expect(refusal(`pair2d/${"A".repeat(43)}/x`)).toBe("damaged");
  });

  it("a refused ghostly1 code is never read as a slash form", () => {
    const peer = createIdentity().pubKeyZ32;
    expect(refusal(`ghostly1/${"A".repeat(43)}/${peer}/${"B".repeat(43)}`)).toBe("typo");
  });
});

describe("older forms still read as input", () => {
  const seedB64 = "A".repeat(43), encKeyB64 = "B".repeat(43), peerPubKeyZ32 = createIdentity().pubKeyZ32;
  it.each([
    ["pair1", `pair1/${seedB64}/${peerPubKeyZ32}/${encKeyB64}`, { profile: "paired-chat/1" }],
    ["pair2d", `pair2d/${seedB64}/${peerPubKeyZ32}/${encKeyB64}`, { profile: "paired-chat/1", deliveryMode: "dht" }],
    ["legacy", `${seedB64}/${peerPubKeyZ32}/${encKeyB64}`, {}],
  ])("%s", (format, code, extra) => {
    expect(readInviteCode(code)).toEqual({ ok: true, format, params: { seedB64, peerPubKeyZ32, encKeyB64, ...extra } });
    expect(readInviteCode(`https://app.ghostly.tools/#/chat/${code}`)).toMatchObject({ ok: true, format });
  });
});

describe("Ghostly 0.4 refuses the new code (WISP 801, checked against v0.4.0)", () => {
  /** `decodeInviteCode` of packages/core/src/invite.ts at v0.4.0, verbatim. */
  function decodeV040(input: string) {
    const clean = input.trim().replace(/^.*#/, "").replace(/^\/?chat\//, "");
    const parts = clean.split("/");
    if (parts.length !== 3) return null;
    const [seedB64, peerPubKeyZ32, encKeyB64] = parts;
    if (!/^[A-Za-z0-9_-]{43}$/.test(seedB64)) return null;
    if (!/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(peerPubKeyZ32)) return null;
    if (!/^[A-Za-z0-9_-]{43}$/.test(encKeyB64)) return null;
    return { seedB64, peerPubKeyZ32, encKeyB64 };
  }
  /** `parseInvite` of src/lib/url.ts at v0.4.0, verbatim but for the types. */
  function parseInviteV040(input: string) {
    const parseKeys = (code: string) => {
      const parts = code.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
      if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_\-+=]+$/.test(part))) return null;
      return parts;
    };
    const parseChatRoute = (pathname: string) => { const match = pathname.match(/^\/chat\/(.+)$/); return match ? parseKeys(match[1]) : null; };
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      const hash = new URL(trimmed).hash.replace(/^#/, "");
      if (hash.startsWith("/chat/")) return parseChatRoute(hash);
    } catch { /* not a URL */ }
    const idx = trimmed.indexOf("/chat/");
    if (idx !== -1) return parseChatRoute(trimmed.slice(idx));
    return parseKeys(trimmed);
  }

  it("the bare code, the QR text and both links are invalid there", () => {
    const { inviteCode } = createChatInvite();
    for (const input of [inviteCode, inviteQrText(inviteCode), inviteLink(inviteCode), inviteLink(inviteCode, "https://app.ghostly.tools"), VECTOR]) {
      expect(decodeV040(input), input.slice(0, 30)).toBeNull();
      expect(parseInviteV040(input), input.slice(0, 30)).toBeNull();
    }
  });
});
