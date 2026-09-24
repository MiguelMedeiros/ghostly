import { describe, expect, it } from "vitest";
import { createLink, decodeInviteCode, encodeInviteCode } from "../src/invite";
// covers: invite.formats

describe("versioned pair bootstrap", () => {
  it("roundtrips an explicit profile without changing legacy invites", () => {
    const { invite } = createLink();
    const legacy = encodeInviteCode(invite);
    expect(decodeInviteCode(legacy)).toEqual(invite);
    const paired = { ...invite, profile: "paired-chat/1" as const };
    expect(decodeInviteCode(encodeInviteCode(paired))).toEqual(paired);
    expect(decodeInviteCode(`https://example.test/#/chat/${encodeInviteCode(paired)}`)).toEqual(paired);
  });
  it("fails on malformed bootstrap or unknown profile without downgrading", () => {
    const { invite } = createLink();
    expect(decodeInviteCode(`pair2/${encodeInviteCode(invite)}`)).toBeNull();
    expect(decodeInviteCode("pair1/not-a-secret/key/value")).toBeNull();
  });
});
