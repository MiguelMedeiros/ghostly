import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatInvite, inviteLink } from "@ghostly/core";
import { MessageBubble } from "../../components/MessageBubble";
import { QRCodeDisplay } from "../../components/QRCode";
import { LinkQrDialog } from "../../components/chat/LinkQrDialog";
import { renderApp } from "../render";

// covers: chat.cards.invite, invite.code

/**
 * Copy on a link: a screen reader hears the button by its label, and "Copied!" once after a copy. The label is not a
 * live region (its text would not name the button, and its flip back to "Copy" would be said too); the status beside it
 * only ever gets "Copied!", and is emptied when the button says its label again.
 */
async function copiesOnce(scope: HTMLElement, button: HTMLElement, label: string, user: ReturnType<typeof renderApp>["user"]) {
  expect(within(button).queryByRole("status")).toBeNull();
  expect(button).toHaveAccessibleName(label);
  const status = within(scope).getByRole("status");
  expect(status).toHaveTextContent(/^$/);
  await user.click(button);
  expect(await within(scope).findByText("Copied!", { selector: "[role=status]" })).toBe(status);
  expect(button).toHaveAccessibleName("Copied!");
  await waitFor(() => expect(button).toHaveAccessibleName(label), { timeout: 3000 });
  expect(status).toHaveTextContent(/^$/);
  // Copied again: said again.
  await user.click(button);
  expect(await within(scope).findByText("Copied!", { selector: "[role=status]" })).toBe(status);
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Copy says its label as its name and Copied once", () => {
  it("on an invite card in a chat", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { inviteCode } = createChatInvite();
    const { user } = renderApp(<MessageBubble message={{ id: "m1", text: inviteCode, sender: "peer", timestamp: 1_700_000_000_000 }} peerNick="Alice" peerPubKey="peer" />);
    const card = screen.getByTestId("entity-invite");
    await copiesOnce(card, within(card).getByTestId("entity-invite-copy"), "Copy", user);
  });

  it("in the link's QR dialog", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { inviteCode } = createChatInvite();
    const { user } = renderApp(<LinkQrDialog title="Chat invite" url={inviteLink(inviteCode)} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Chat invite" });
    await copiesOnce(dialog, within(dialog).getByTestId("link-qr-copy"), "Copy", user);
  });

  it("under a new chat's QR code", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { user, container } = renderApp(<QRCodeDisplay value="https://ghostly.tools/#example" copyLabel="Copy invite" />);
    await copiesOnce(container, screen.getByRole("button", { name: "Copy invite" }), "Copy invite", user);
  });
}, 15_000);
