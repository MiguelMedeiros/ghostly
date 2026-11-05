import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { createChatInvite, inviteLink } from "@ghostly/core";
import { JoinDialog } from "../../components/JoinDialog";
import { renderApp } from "../render";
// covers: invite.invalid

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const link = inviteLink(createChatInvite().inviteCode);

/**
 * A refused paste (JoinDialog.tsx) says what is wrong and asks to check the code: the field that opens holds what was
 * pasted, caret at its end, marked invalid and described by the error, so the check can be made in place.
 */
describe("Join keeps a refused paste in the field", () => {
  it.each([
    ["not an invite", "hello there", "This is not a Ghostly invite."],
    ["a damaged invite", "https://example.com/#/join/abc", "This invite is damaged. Ask for a new one."],
    ["half an invite link", link.slice(0, Math.floor(link.length / 2)), "This code has a typo. Check it, or ask for the code again."],
  ])("%s", async (_, value, message) => {
    const onJoin = vi.fn();
    const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    engine.readClipboardText = vi.fn(async () => `  ${value}\n`);
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Invite code" });
    expect(field).toHaveValue(value);
    expect(field).toHaveFocus();
    expect([field.selectionStart, field.selectionEnd]).toEqual([value.length, value.length]);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(message);
    expect(onJoin).not.toHaveBeenCalled();
    // Fixed in place: the error goes, and the field is no longer marked.
    await user.type(field, "x");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field).not.toHaveAttribute("aria-invalid");
  });

  it("a second refused paste, the field already open, replaces its text and takes the focus back", async () => {
    const { user, engine } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    engine.readClipboardText = vi.fn(async () => "hello there");
    const paste = screen.getByRole("button", { name: "Paste from clipboard" });
    await user.click(paste);
    await screen.findByRole("alert");
    engine.readClipboardText = vi.fn(async () => "https://example.com/#/join/abc");
    await user.click(paste);
    expect(await screen.findByRole("alert")).toHaveTextContent("This invite is damaged. Ask for a new one.");
    const field = screen.getByRole("textbox", { name: "Invite code" });
    expect(field).toHaveValue("https://example.com/#/join/abc");
    expect(field).toHaveFocus();
  });

  it("an unreadable clipboard leaves the field empty, described by the error but not marked invalid", async () => {
    const { user, engine } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    engine.readClipboardText = async () => { throw new Error("Not allowed from this window"); };
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await screen.findByRole("alert");
    const field = screen.getByRole("textbox", { name: "Invite code" });
    expect(field).toHaveValue("");
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(field).toHaveAccessibleDescription(/^Could not read the clipboard\./);
  });
});
