import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createChatInvite, createLink, encodeInviteCode } from "@ghostly/core";
import { InviteCard } from "../../components/InviteCard";
import { getInviteCode } from "../../lib/storage";
import { renderApp } from "../render";

// covers: chat.paired.pair, invite.code

const { invite } = createLink();
const live = encodeInviteCode({ ...invite, profile: "paired-chat/1" });
const text = encodeInviteCode({ ...invite, profile: "paired-chat/1", deliveryMode: "dht" });
const legacy = encodeInviteCode(invite);

function card(props: Partial<Parameters<typeof InviteCard>[0]> = {}) {
  const onChange = vi.fn();
  return { ...renderApp(<InviteCard code={live} sessionId="s1" linkId="link-1" mode="stream" onChange={onChange} {...props} />), onChange };
}

describe("InviteCard", () => {
  it("offers the two ways a paired chat can start, with the current one chosen", () => {
    const { onChange } = card();
    expect(screen.getByRole("heading", { name: "Invite your contact" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Live chat" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Text only" })).not.toBeChecked();
    expect(screen.getByTestId("invite-qr")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("switches to text only: the chat changes delivery, then the invite says so", async () => {
    const { user, engine, onChange } = card();
    let done!: () => void;
    engine.on("setDeliveryMode", () => new Promise<void>(resolve => { done = resolve; }));
    await user.click(screen.getByRole("radio", { name: "Text only" }));
    expect(engine.callsTo("setDeliveryMode")).toEqual([{ linkId: "link-1", mode: "dht" }]);
    // The QR waits: until the engine agrees, the old invite would be the wrong one.
    expect(await screen.findByText("Updating invite…")).toBeInTheDocument();
    expect(screen.queryByTestId("invite-qr")).not.toBeInTheDocument();
    done();
    expect(await screen.findByTestId("invite-qr")).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(text);
    expect(getInviteCode("s1")).toBe(text);
  });

  it("keeps the invite when the engine refuses the change", async () => {
    const { user, engine, onChange } = card();
    engine.on("setDeliveryMode", () => { throw new Error("The contact already joined"); });
    await user.click(screen.getByRole("radio", { name: "Text only" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The contact already joined");
    expect(onChange).not.toHaveBeenCalled();
    expect(getInviteCode("s1")).toBeNull();
  });

  it("brings a stale invite in line with the chat's delivery at once", async () => {
    // The chat is text-only, but the stored code still says live.
    const { user, onChange } = card({ mode: "dht" });
    expect(onChange).toHaveBeenCalledWith(text);
    expect(getInviteCode("s1")).toBe(text);
    expect(screen.getByRole("radio", { name: "Text only" })).toBeChecked();
    // What is shown and copied is the corrected code, even before the parent passes it back.
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy invite" }));
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("shares a ghostly1 invite as its link on ghostly.tools, shown and copied", async () => {
    const { inviteCode } = createChatInvite();
    const { user, onChange } = card({ code: inviteCode });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("invite-link")).toHaveTextContent(`ghostly.tools/#${inviteCode}`);
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy invite" }));
    expect(writeText).toHaveBeenCalledWith(`https://ghostly.tools/#${inviteCode}`);
  });

  it("cannot change delivery before the chat exists", () => {
    card({ linkId: undefined });
    expect(screen.getByRole("radio", { name: "Live chat" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Text only" })).toBeDisabled();
  });

  it("shows an older invite as it is, with no delivery choice", () => {
    const { onChange } = card({ code: legacy, mode: "dht" });
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByTestId("invite-qr")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("explains text only on request", async () => {
    const { user } = card();
    const details = screen.getByRole("button", { name: "Delivery details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    await user.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "Delivery details" })).toHaveTextContent("Up to 256 UTF-8 bytes");
    await user.click(details);
    expect(screen.queryByRole("region", { name: "Delivery details" })).not.toBeInTheDocument();
  });
});
