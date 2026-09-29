import { describe, expect, it } from "vitest";
import { OwnInviteError, createChatInvite, createLink, encodeInviteCode, inviteLink, inviteOwnership, inviteQrSegments, ownInviteRefusal, readInviteCode } from "../src";

// covers: invite.own, invite.rejoin

/**
 * Whose invite a code is, among the chats a profile has (WISP 801 Q9). The inviter's chat keeps the
 * contact's link key, which the invite's seed derives, so every format an app ever made is recognised
 * from the keys alone: the code itself is forgotten once the contact pairs.
 */

const read = (input: string) => {
  const reading = readInviteCode(input);
  if (!reading.ok) throw new Error(reading.reason);
  return reading.params;
};
const chatOf = (id: string, mine: { seedB64: string; peerPubKeyZ32: string }) => ({ id, seedB64: mine.seedB64, peerPubKeyZ32: mine.peerPubKeyZ32 });

describe("a profile's own invite is recognised however it arrives", () => {
  const { mine, inviteCode } = createChatInvite();
  const chats = [chatOf("other", createLink().mine), chatOf("theirs", mine)];
  it.each([
    ["the bare code", inviteCode],
    ["the link", inviteLink(inviteCode)],
    ["the link on app.ghostly.tools", inviteLink(inviteCode, "https://app.ghostly.tools")],
    ["the code in capitals, as a QR holds it", inviteQrSegments(inviteCode).join("")],
  ])("%s", (_, input) => {
    expect(inviteOwnership(read(input), chats)).toEqual({ kind: "own", link: chats[1] });
  });

  it.each([
    ["a pair1/ code", (invite: Parameters<typeof encodeInviteCode>[0]) => encodeInviteCode({ ...invite, profile: "paired-chat/1" })],
    ["a pair2d/ code", (invite: Parameters<typeof encodeInviteCode>[0]) => encodeInviteCode({ ...invite, profile: "paired-chat/1", deliveryMode: "dht" })],
    ["a prefix-less v0.4 string", (invite: Parameters<typeof encodeInviteCode>[0]) => encodeInviteCode(invite)],
  ])("%s, from a chat made before ghostly1", (_, encode) => {
    const older = createLink();
    const olderChats = [...chats, chatOf("older", older.mine)];
    expect(inviteOwnership(read(encode(older.invite)), olderChats)).toEqual({ kind: "own", link: olderChats[2] });
  });
});

describe("another invite is not", () => {
  const { mine } = createChatInvite();
  const chats = [chatOf("a", mine), chatOf("b", createLink().mine)];

  it("someone else's invite, never seen, is new", () => {
    expect(inviteOwnership(read(createChatInvite().inviteCode), chats)).toEqual({ kind: "new" });
  });

  it("another profile's invite is new to this one: only this profile's chats are asked", () => {
    const otherProfile = createChatInvite();
    expect(inviteOwnership(read(otherProfile.inviteCode), chats)).toEqual({ kind: "new" });
    expect(inviteOwnership(read(otherProfile.inviteCode), [...chats, chatOf("c", otherProfile.mine)])).toEqual({ kind: "own", link: chatOf("c", otherProfile.mine) });
  });

  it("an invite already joined by is that chat, not one's own", () => {
    const { invite, inviteCode } = createChatInvite();
    const joined = chatOf("joined", { seedB64: invite.seedB64, peerPubKeyZ32: invite.peerPubKeyZ32 });
    expect(inviteOwnership(read(inviteCode), [...chats, joined])).toEqual({ kind: "joined", link: joined });
    expect(inviteOwnership(read(inviteLink(inviteCode).toUpperCase()), [joined])).toEqual({ kind: "joined", link: joined });
  });

  it("no chats at all: new", () => {
    expect(inviteOwnership(read(createChatInvite().inviteCode), [])).toEqual({ kind: "new" });
  });
});

describe("the engine's refusal survives an RPC, which hands over the message alone", () => {
  it("carries the reason and the chat that owns the invite", () => {
    const error = new OwnInviteError("abc123");
    expect(ownInviteRefusal(error)).toEqual({ linkId: "abc123" });
    expect(ownInviteRefusal(new Error(error.message))).toEqual({ linkId: "abc123" });
    expect(error.message).toContain("This is your own invite. Share it with a contact; they join with it.");
  });
  it("a spare invite owns no chat yet", () => {
    expect(ownInviteRefusal(new Error(new OwnInviteError(null).message))).toEqual({ linkId: null });
  });
  it("any other error is not it", () => {
    expect(ownInviteRefusal(new Error("Invitation profile does not match the stored link"))).toBeNull();
    expect(ownInviteRefusal("own-invite")).toBeNull();
    expect(ownInviteRefusal(undefined)).toBeNull();
  });
});
