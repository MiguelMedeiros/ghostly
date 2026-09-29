import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { createChatInvite, createLink, encodeInviteCode, inviteLink, inviteQrSegments } from "@ghostly/core";
import { JoinDialog } from "../../components/JoinDialog";
import { ensureSession, listSessions, setStorageProfile } from "../../lib/storage";
import { onJoinNotice, type JoinNoticeKey } from "../../lib/joinNotice";
import { renderApp } from "../render";
// covers: invite.own, invite.rejoin

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

/** A chat this profile made, as New makes it: the inviter's keys and its code kept with the session. */
function ownChat() {
  const { mine, inviteCode } = createChatInvite();
  const id = ensureSession({ seedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, profile: "paired-chat/1", participationSeedB64: mine.participationSeedB64 }, { inviteCode });
  return { id, inviteCode };
}

async function submit(value: string, language?: "pt") {
  const onJoin = vi.fn(), onOpenChat = vi.fn(), onClose = vi.fn();
  const notices: JoinNoticeKey[] = [];
  onJoinNotice((key) => notices.push(key));
  const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onOpenChat={onOpenChat} onClose={onClose} />, { language });
  engine.readClipboardText = vi.fn(async () => value);
  await user.click(screen.getByRole("button", { name: language === "pt" ? "Colar da área de transferência" : "Paste from clipboard" }));
  return { user, engine, onJoin, onOpenChat, onClose, notices };
}

describe("Join refuses this profile's own invite and offers the chat that owns it", () => {
  it.each([
    ["the link", (code: string) => inviteLink(code)],
    ["the bare code", (code: string) => code],
    ["the code in capitals, as a QR holds it", (code: string) => inviteQrSegments(code).join("")],
  ])("%s", async (_, form) => {
    const { id, inviteCode } = ownChat();
    const { user, onJoin, onOpenChat, notices } = await submit(form(inviteCode));
    expect(await screen.findByRole("alert")).toHaveTextContent("This is your own invite. Share it with a contact; they join with it.");
    expect(screen.queryByRole("textbox", { name: "Invite code" })).toBeNull();
    expect(onJoin).not.toHaveBeenCalled();
    expect(listSessions()).toHaveLength(1);
    await user.click(screen.getByTestId("join-open-chat"));
    expect(onOpenChat).toHaveBeenCalledWith(id);
    expect(notices).toEqual([]);
  });

  it("a chat made before ghostly1 owns its older code too", async () => {
    const older = createLink();
    const inviteCode = encodeInviteCode({ ...older.invite, profile: "paired-chat/1" });
    const id = ensureSession({ seedB64: older.mine.seedB64, peerPubKeyB64: older.mine.peerPubKeyZ32, encKeyB64: older.mine.encKeyB64, profile: "paired-chat/1" }, { inviteCode });
    const { user, onJoin, onOpenChat } = await submit(inviteCode);
    expect(await screen.findByRole("alert")).toHaveTextContent("This is your own invite.");
    await user.click(screen.getByTestId("join-open-chat"));
    expect(onOpenChat).toHaveBeenCalledWith(id);
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("in another language too", async () => {
    const { inviteCode } = ownChat();
    await submit(inviteCode, "pt");
    expect(await screen.findByRole("alert")).toHaveTextContent("Este convite é seu. Compartilhe com um contato; é ele quem entra com ele.");
    expect(screen.getByTestId("join-open-chat")).toHaveTextContent("Abrir essa conversa");
  });

  it("a second paste clears it: someone else's invite then joins", async () => {
    const { inviteCode } = ownChat();
    const { user, engine, onJoin } = await submit(inviteCode);
    expect(await screen.findByRole("alert")).toHaveTextContent("This is your own invite.");
    const theirs = createChatInvite();
    engine.readClipboardText = vi.fn(async () => theirs.inviteCode);
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    expect(screen.queryByTestId("join-own-invite")).toBeNull();
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: theirs.invite.seedB64 });
  });
});

describe("an invite this profile already joined by opens that chat", () => {
  it("says so, and makes no second chat", async () => {
    const { invite, inviteCode } = createChatInvite();
    const id = ensureSession({ seedB64: invite.seedB64, peerPubKeyB64: invite.peerPubKeyZ32, encKeyB64: invite.encKeyB64, profile: "paired-chat/1", peerParticipationKeyB64: invite.peerParticipationKeyZ32 });
    const { onJoin, onOpenChat, notices } = await submit(inviteLink(inviteCode));
    expect(onOpenChat).toHaveBeenCalledWith(id);
    expect(onJoin).not.toHaveBeenCalled();
    expect(notices).toEqual(["join.alreadyIn"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(listSessions()).toHaveLength(1);
  });
});

describe("another profile on the same app", () => {
  it("may join this profile's invite: its chats are its own", async () => {
    const { inviteCode } = ownChat();
    setStorageProfile("work12345a");
    try {
      const { onJoin, onOpenChat } = await submit(inviteCode);
      expect(onJoin).toHaveBeenCalledTimes(1);
      expect(onOpenChat).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
    } finally { setStorageProfile(""); }
  });
});
