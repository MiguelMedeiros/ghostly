import { describe, expect, it } from "vitest";
import { bech32, bech32m } from "@scure/base";
import { toZ32 } from "../src/bytes";
import { identityFromSeedB64 } from "../src/identity";
import { createChatInvite, inviteLink, readInviteCode } from "../src/invite";
import { readDeviceInvite } from "../src/deviceInvite";
import { CONTACT_LINK_VERSION, createContactLink, encodeContactLink, readContactLink } from "../src/contactLink";

/** WISP 8xx's test vector: the bytes 00 01 … 1f in place of a key. */
const VECTOR_KEY = toZ32(Uint8Array.from({ length: 32 }, (_, i) => i));
const VECTOR = "ghostly1rqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s0her5u";

const made = (words: number[], codec = bech32m) => codec.encode("ghostly", words, false);
const refusal = (input: string) => {
  const reading = readContactLink(input);
  return reading.ok ? "ok" : reading.reason;
};

describe("contact links (WISP 8xx)", () => {
  it("encodes the test vector exactly, 67 characters starting ghostly1r", () => {
    expect(encodeContactLink(VECTOR_KEY)).toBe(VECTOR);
    expect(VECTOR).toHaveLength(67);
  });

  it("reads the vector bare, in capitals, mixed case, in a link on either host, and after a sentence", () => {
    for (const input of [VECTOR, VECTOR.toUpperCase(), "Ghostly1" + VECTOR.slice(8), inviteLink(VECTOR), `https://app.ghostly.tools/#${VECTOR}`, `  ${VECTOR}\n`, `(${inviteLink(VECTOR)}).`]) {
      expect(readContactLink(input)).toEqual({ ok: true, linkKeyZ32: VECTOR_KEY });
    }
  });

  it("a new link reads back to the key whose seed the owner keeps", () => {
    const link = createContactLink();
    expect(link.code.startsWith("ghostly1r")).toBe(true);
    expect(identityFromSeedB64(link.seedB64).pubKeyZ32).toBe(link.linkKeyZ32);
    expect(readContactLink(link.code)).toEqual({ ok: true, linkKeyZ32: link.linkKeyZ32 });
  });

  it("names a chat's invite and a device's code for what they are", () => {
    expect(refusal(createChatInvite().inviteCode)).toBe("chat");
    expect(refusal(made([2, ...bech32m.toWords(new Uint8Array(133))]))).toBe("device");
  });

  it("refuses a typo, another kind of string, a damaged payload and a newer version", () => {
    const flipped = VECTOR.slice(0, 30) + (VECTOR[30] === "q" ? "p" : "q") + VECTOR.slice(31);
    expect(refusal(flipped)).toBe("typo");
    expect(refusal(made([3, ...bech32m.toWords(new Uint8Array(32))], bech32))).toBe("not-ghostly");
    expect(refusal(made([0, ...bech32m.toWords(new Uint8Array(32))]))).toBe("not-ghostly");
    expect(refusal("npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzqujme")).toBe("not-ghostly");
    expect(refusal("ghostly1" + "q".repeat(1020))).toBe("not-ghostly");
    expect(refusal(made([3, ...bech32m.toWords(new Uint8Array(31))]))).toBe("damaged");
    expect(refusal(made([3, ...bech32m.toWords(new Uint8Array(33))]))).toBe("damaged");
    // 52 words carry 260 bits: four padding bits, which must be zero.
    const words = bech32m.toWords(new Uint8Array(32));
    words[words.length - 1] |= 1;
    expect(refusal(made([3, ...words]))).toBe("damaged");
    expect(refusal(made([CONTACT_LINK_VERSION + 1, ...bech32m.toWords(new Uint8Array(32))]))).toBe("update");
  });

  it("is not a chat or a device to the readers from before: they answer that a newer Ghostly made it", () => {
    expect(readInviteCode(VECTOR)).toMatchObject({ ok: false, reason: "update" });
    expect(readDeviceInvite(VECTOR)).toMatchObject({ ok: false, reason: "update" });
  });
});
