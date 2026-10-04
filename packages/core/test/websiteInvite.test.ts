import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bech32, bech32m } from "@scure/base";
import { createChatInvite, readInviteCode } from "../src/invite";
import { checkInvite } from "../../../apps/website/lib/invite";
// covers: invite.code

/**
 * The join page on ghostly.tools reads `ghostly1` codes with its own copy of the rules
 * (apps/website/lib/invite.ts: the site cannot import the core). Both must give the same answer.
 */
const same = (input: string) => {
  const core = readInviteCode(input);
  const site = checkInvite(input);
  expect(site.ok ? "ok" : site.reason, input.slice(0, 40)).toBe(core.ok ? "ok" : core.reason);
};

describe("the site's invite reader agrees with the app's", () => {
  const { inviteCode } = createChatInvite();
  const words = bech32m.decode(inviteCode, 1023).words;

  it("on real codes, in any case, and on every refusal", () => {
    same(inviteCode);
    same(inviteCode.toUpperCase());
    expect(checkInvite(inviteCode.toUpperCase())).toEqual({ ok: true, code: inviteCode });
    for (let i = 8; i < inviteCode.length; i += 7) same(inviteCode.slice(0, i) + (inviteCode[i] === "q" ? "p" : "q") + inviteCode.slice(i + 1));
    // Version 2 adds a device to a profile (WISP 06): both say so, and neither makes a chat of it.
    for (const version of [0, 2, 3, 17, 31]) same(bech32m.encode("ghostly", [version, ...words.slice(1)], false));
    same(bech32.encode("ghostly", words, false));
    const bytes = bech32m.fromWords(words.slice(1));
    same(bech32m.encode("ghostly", [1, ...bech32m.toWords(bytes.slice(0, 96))], false));
    const padded = [...words]; padded[padded.length - 1] |= 1;
    same(bech32m.encode("ghostly", padded, false));
    for (const other of ["ghostly1", "ghostly1qqqqqq", `ghostly1${"q".repeat(1016)}`, "ghostly1bbbbbbbbbb", inviteCode.slice(0, -1)]) same(other);
  });

  it("a version above every one either reader knows is a newer Ghostly's, in both; version 2 adds a device, in both", () => {
    for (const version of [3, 4, 16, 31]) {
      const code = bech32m.encode("ghostly", [version, ...words.slice(1)], false);
      expect(readInviteCode(code)).toMatchObject({ ok: false, reason: "update" });
      expect(checkInvite(code)).toEqual({ ok: false, reason: "update" });
    }
    const device = bech32m.encode("ghostly", [2, ...words.slice(1)], false);
    expect(readInviteCode(device)).toEqual({ ok: false, reason: "device" });
    // The site hands a device code to the web app (WISP 06), so it keeps the code, in lower case.
    expect(checkInvite(device)).toEqual({ ok: false, reason: "device", code: device });
    expect(checkInvite(device.toUpperCase())).toEqual({ ok: false, reason: "device", code: device });
  });

  it("on arbitrary strings after ghostly1", () => {
    fc.assert(fc.property(fc.stringMatching(/^[qpzry9x8gf2tvdw0s3jn54khce6mua7l1bio]{0,240}$/), tail => same(`ghostly1${tail}`)), { numRuns: 400 });
  });
});
