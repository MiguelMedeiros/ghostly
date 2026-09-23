import { expect, it } from "vitest";
import { createLink, encodeInviteCode } from "@ghostly/core";
import { parseInvite, buildInviteUrl, chatPath } from "../../../src/lib/url";
import { findMoney } from "../../../src/lib/money";
import { formatFileSize } from "../../../src/lib/format";

const INVOICE = "lnbc21u1p42mkf2dqqpp56q3d9mfahf0974jqwy0yyfrg7zxksgxk7ufcc084yydhfx43daqqsp59g4z52329g4z52329g4z52329g4z52329g4z52329g4z52329g4q9qrsgqcqzyskhkhqar4dqgqfmarvdttr8x2nrp4txtamfupfftrnn4hmrp7s8ayen7hp2ye58jq8zu65rch9eplpxkhf3pf2nvuynhqxvkw5f7a2vgq486x8x";

it("reads an invite however it is pasted, and nothing that only looks like one", () => {
  const { invite } = createLink();
  const code = encodeInviteCode(invite);
  const expected = { seedB64: invite.seedB64, peerPubKeyB64: invite.peerPubKeyZ32, encKeyB64: invite.encKeyB64 };
  for (const pasted of [code, `  ${code}\n`, `https://app.ghostly.tools/#/chat/${code}`, `/chat/${code}`, `join me: https://x.example/#/chat/${code}`])
    expect(parseInvite(pasted), pasted.slice(0, 40)).toMatchObject(expected);
  for (const junk of ["", "   ", "not an invite", "javascript:alert(1)", "https://evil.example/#/chat/nope", "/chat/", code.slice(0, 20)])
    expect(parseInvite(junk), junk).toBeNull();
  const url = buildInviteUrl("https://app.ghostly.tools", invite.seedB64, invite.peerPubKeyZ32, invite.encKeyB64);
  expect(parseInvite(url)).toMatchObject(expected);
  // The address the app routes to carries a session id, never the keys.
  expect(chatPath("abc/def")).toBe("/chat/abc%2Fdef");
});

it("finds a Lightning invoice or ecash in a message, and leaves the rest of the text", () => {
  expect(findMoney("short")).toBeNull();
  const lightning = findMoney(`pay me please ${INVOICE}`);
  expect(lightning).toMatchObject({ type: "lightning" });
  const token = "cashuB" + "o".repeat(40);
  expect(findMoney(`here you go ${token} thanks`)).toEqual({ type: "cashu", value: token, rest: "here you go  thanks" });
  expect(findMoney("creqA" + "a".repeat(20) + " and some more text to be long")).toMatchObject({ type: "cashu" });
  expect(findMoney("a perfectly ordinary message that is long enough to be checked")).toBeNull();
  expect(findMoney("cashuB short but the rest of this text makes it long enough")).toBeNull();
});

it("says file sizes in the unit people expect", () => {
  expect(formatFileSize(0)).toBe("0 B");
  expect(formatFileSize(1023)).toBe("1023 B");
  expect(formatFileSize(1024)).toBe("1.0 KB");
  expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
});
