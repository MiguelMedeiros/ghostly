import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/identity";
import { createChatInvite, readInviteCode } from "../src/invite";
import { createDeviceInvite, readDeviceInvite } from "../src/deviceInvite";
import { decodeGroupEntryLink, encodeGroupEntryLink } from "../src/groupEntry";
import { decodeCommunityLink, encodeCommunityLink } from "../src/groupCommunity";
import { encodeContactLink, readContactLink } from "../src/contactLink";
import { unwrapPasted } from "../src/text";

// agents#1631 (#1632, #1650): a token copied with the words around it, into Join. Every reader of a pasted token
// reads it as the chat cards do (entities.ts): a group's link with a final "." was "not a Ghostly invite", a chat
// invite or a device code in quotes, « », < >, [ ] or before "?" was "a typo".

/** The ways the hunts copied a token: `X` is where it goes. */
const PASTES = [
  "X", "X.", "X,", "(X)", "X!", "(X).", "X?", "X;", "X:", "<X>", "\"X\"", "“X”", "« X »", "«X»", "X…", "[X]", "`X`",
  "code: X", "Join our group: X.", "Here: <X>.", "  X  \n", "Link → X !",
];
const NOW = Math.floor(Date.now() / 1000);
const web = (code: string) => `https://ghostly.tools/#${code}`;
/** One character lost in the middle. */
const lose = (code: string) => code.slice(0, 30) + code.slice(31);

describe("a token pasted with the words around it", () => {
  const { inviteCode } = createChatInvite();
  const device = createDeviceInvite(createIdentity().publicKey, NOW).code;
  const group = encodeGroupEntryLink({ g: "AbCdEfGhIjKlMnOpQrStUv", host: createIdentity().pubKeyZ32 });
  const community = encodeCommunityLink({ g: "AbCdEfGhIjKlMnOpQrStUv", host: createIdentity().pubKeyZ32 });
  const contact = encodeContactLink(createIdentity().pubKeyZ32);

  for (const form of ["bare", "link"] as const) {
    const as = (code: string) => (form === "bare" ? code : web(form === "link" && code.startsWith("group") ? `/join/${code}` : code));
    it(`reads a chat invite, a device code, a contact link and group links in each (${form})`, () => {
      const refused: string[] = [];
      for (const paste of PASTES) {
        const of = (code: string) => paste.replace("X", as(code));
        if (!readInviteCode(of(inviteCode)).ok) refused.push(`invite ${JSON.stringify(paste)}`);
        if (!readDeviceInvite(of(device), NOW).ok) refused.push(`device ${JSON.stringify(paste)}`);
        if (!readContactLink(of(contact)).ok) refused.push(`contact ${JSON.stringify(paste)}`);
        if (!decodeGroupEntryLink(of(group))) refused.push(`group ${JSON.stringify(paste)}`);
        if (!decodeCommunityLink(of(community))) refused.push(`community ${JSON.stringify(paste)}`);
      }
      expect(refused).toEqual([]);
    });
  }

  it("a code with a character lost is still refused, as a typo once it is the token in the words", () => {
    for (const paste of ["X", "X.", "code: X", "« X »", "<X>?"]) {
      const of = (code: string) => paste.replace("X", code);
      expect(readInviteCode(of(lose(inviteCode))), paste).toMatchObject({ ok: false, reason: "typo" });
      expect(readDeviceInvite(of(lose(device)), NOW), paste).toMatchObject({ ok: false, reason: "typo" });
      expect(decodeGroupEntryLink(of(lose(group))), paste).toBeNull();
      expect(decodeCommunityLink(of(lose(community))), paste).toBeNull();
    }
  });

  it("words with no token in them are not one", () => {
    for (const text of ["hello there.", "« bonjour »", "code: 1234", ""]) {
      expect(readInviteCode(text), text).toMatchObject({ ok: false, reason: "not-ghostly" });
      expect(readDeviceInvite(text, NOW), text).toMatchObject({ ok: false, reason: "not-ghostly" });
      expect(decodeGroupEntryLink(text), text).toBeNull();
    }
  });

  it("a chat invite is not taken for a group link, nor a group link for another kind", () => {
    expect(decodeGroupEntryLink(`Here: ${inviteCode}.`)).toBeNull();
    expect(decodeCommunityLink(`Join: ${group}.`)).toBeNull();
    expect(decodeGroupEntryLink(`Join: ${community}.`)).toBeNull();
  });

  it("unwrapPasted takes the last word without its wrappers and marks", () => {
    expect(unwrapPasted("Join our group: <https://a.b/#/join/group1/x/y>.")).toBe("https://a.b/#/join/group1/x/y");
    expect(unwrapPasted("« ghostly1abc »")).toBe("ghostly1abc");
    expect(unwrapPasted("code: `ghostly1abc`?")).toBe("ghostly1abc");
    expect(unwrapPasted("ghostly1abc")).toBe("ghostly1abc");
  });
});
