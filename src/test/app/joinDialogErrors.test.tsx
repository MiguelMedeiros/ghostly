import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { bech32m } from "@scure/base";
import { createChatInvite, createLink, encodeInviteCode, inviteLink, inviteQrSegments, INVITE_MAX_LENGTH } from "@ghostly/core";
import { JoinDialog } from "../../components/JoinDialog";
import { renderApp } from "../render";
// covers: invite.invalid, invite.code

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const { invite, inviteCode } = createChatInvite();
const words = bech32m.decode(inviteCode, INVITE_MAX_LENGTH).words.slice(1);
const withWords = (all: number[]) => bech32m.encode("ghostly", all, false);

/** Opens the field (a failed paste does), types `value` into it and submits. */
async function submit(value: string) {
  const onJoin = vi.fn();
  const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
  engine.readClipboardText = vi.fn(async () => value);
  await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
  return { onJoin, alert: () => screen.queryByRole("alert") };
}

describe("Join reads a ghostly1 invite however it arrives", () => {
  it.each([
    ["the link", inviteLink(inviteCode)],
    ["the link on app.ghostly.tools", inviteLink(inviteCode, "https://app.ghostly.tools")],
    ["the bare code", inviteCode],
    ["the code in capitals, as a QR holds it", inviteQrSegments(inviteCode).join("")],
  ])("%s", async (_, value) => {
    const { onJoin, alert } = await submit(value);
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onJoin.mock.calls[0][0]).toEqual({ profile: "paired-chat/1", seedB64: invite.seedB64, peerPubKeyB64: invite.peerPubKeyZ32,
      encKeyB64: invite.encKeyB64, peerParticipationKeyB64: invite.peerParticipationKeyZ32, deliveryMode: undefined });
    expect(alert()).toBeNull();
  });

  it("still reads an older pair1/ code", async () => {
    const older = encodeInviteCode({ ...createLink().invite, profile: "paired-chat/1" });
    const { onJoin } = await submit(older);
    expect(onJoin.mock.calls[0][0]).toMatchObject({ profile: "paired-chat/1" });
  });
});

describe("Join says why it refuses a code, and joins nothing", () => {
  const typo = inviteCode.slice(0, 50) + (inviteCode[50] === "q" ? "p" : "q") + inviteCode.slice(51);
  it.each([
    ["a typo", typo, "This code has a typo. Check it, or ask for the code again."],
    ["a newer version", withWords([2, ...words]), "This invite was made by a newer Ghostly. Update to join."],
    ["version 0", withWords([0, ...words]), "This is not a Ghostly invite."],
    ["another kind of code", "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "This is not a Ghostly invite."],
    ["a damaged invite", withWords([1, ...bech32m.toWords(bech32m.fromWords(words).slice(0, 96))]), "This invite is damaged. Ask for a new one."],
  ])("%s", async (_, value, message) => {
    const { onJoin, alert } = await submit(inviteLink(value));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(alert()).toHaveTextContent(message);
    expect(onJoin).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Invite code" })).toBeInTheDocument();
  });

  it("in another language too", async () => {
    const onJoin = vi.fn();
    const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />, { language: "pt" });
    engine.readClipboardText = vi.fn(async () => withWords([2, ...words]));
    await user.click(screen.getByRole("button", { name: "Colar da área de transferência" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Este convite foi criado por um Ghostly mais novo. Atualize para entrar.");
  });
});
