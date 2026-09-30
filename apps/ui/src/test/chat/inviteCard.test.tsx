import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createChatInvite, createLink, encodeInviteCode } from "@ghostly/core";
import { InviteCard } from "../../components/InviteCard";
import { renderApp } from "../render";

// covers: chat.paired.pair, invite.code, chat.one-chat

const { invite } = createLink();
const older = encodeInviteCode({ ...invite, profile: "paired-chat/1" });
const legacy = encodeInviteCode(invite);

describe("InviteCard", () => {
  it("one chat, one invite: nothing to choose, the QR and the copied code are the same (WISP 400)", async () => {
    const { user } = renderApp(<InviteCard code={older} />);
    expect(screen.getByRole("heading", { name: "Invite your contact" })).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delivery details" })).not.toBeInTheDocument();
    expect(screen.getByTestId("invite-qr")).toBeInTheDocument();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy invite" }));
    expect(writeText).toHaveBeenCalledWith(older);
  });

  it("shares a ghostly1 invite as its link on ghostly.tools, shown and copied", async () => {
    const { inviteCode } = createChatInvite();
    const { user } = renderApp(<InviteCard code={inviteCode} />);
    expect(screen.getByTestId("invite-link")).toHaveTextContent(`ghostly.tools/#${inviteCode}`);
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy invite" }));
    expect(writeText).toHaveBeenCalledWith(`https://ghostly.tools/#${inviteCode}`);
  });

  it("shows an older invite as it is", () => {
    renderApp(<InviteCard code={legacy} />);
    expect(screen.getByTestId("invite-qr")).toBeInTheDocument();
    expect(screen.queryByTestId("invite-link")).not.toBeInTheDocument();
  });
});
