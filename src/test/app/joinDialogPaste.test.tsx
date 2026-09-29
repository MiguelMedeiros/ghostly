import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { createLink, encodeInviteCode } from "@ghostly/core";
import { JoinDialog } from "../../components/JoinDialog";
import { renderApp } from "../render";
// covers: invite.clipboard

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

/** The page's Clipboard API; set after rendering, since user-event's setup() installs a stub of its own. */
function pageClipboard(readText: () => Promise<string>) {
  const read = vi.fn(readText);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: read } });
  return read;
}

/**
 * Join → Paste from clipboard (src/components/JoinDialog.tsx). The desktop host reads natively, so
 * WKWebView's "Paste" callout never asks for a second click; when reading fails the invite field
 * opens focused with the keys to press.
 */
describe("Paste from clipboard in Join", () => {
  afterEach(() => { Reflect.deleteProperty(navigator, "clipboard"); });

  it("joins in one click through the desktop host, without the page's Clipboard API", async () => {
    const { invite } = createLink();
    const onJoin = vi.fn();
    const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    const web = pageClipboard(async () => "not this one");
    engine.readClipboardText = vi.fn(async () => `  ${encodeInviteCode(invite)}\n`);
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1));
    expect(onJoin.mock.calls[0][0]).toMatchObject({ seedB64: invite.seedB64, peerPubKeyB64: invite.peerPubKeyZ32, encKeyB64: invite.encKeyB64 });
    expect(engine.readClipboardText).toHaveBeenCalledTimes(1);
    expect(web).not.toHaveBeenCalled();
  });

  it("a refused read opens the field, focused, with the keys to press", async () => {
    const onJoin = vi.fn();
    const { user, engine } = renderApp(<JoinDialog onJoin={onJoin} onClose={() => {}} />);
    pageClipboard(async () => "not this one");
    engine.readClipboardText = async () => { throw new Error("Not allowed from this window"); };
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not read the clipboard\. Press (⌘V|Ctrl\+V) to paste the invite below\.$/);
    expect(screen.getByRole("textbox", { name: "Invite code" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Paste from clipboard" })).toBeEnabled();
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("on the web, a denied Clipboard API does the same, and an empty one says so", async () => {
    const { user } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    pageClipboard(async () => { throw new DOMException("denied", "NotAllowedError"); });
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Could not read the clipboard\. Press/);
    pageClipboard(async () => "  ");
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/^Clipboard is empty\. Copy an invite, then press (⌘V|Ctrl\+V) below\.$/));
  });
});
