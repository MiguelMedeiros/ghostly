import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite } from "@ghostly/core";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Root } from "../../Root";
import { useOutsideDismiss } from "../../hooks/useDismiss";
import { Home } from "../../pages/Home";
import { NO_ROOM_FOR_CHAT, ensureSession, listSessions } from "../../lib/storage";
import { readInvite } from "../../lib/url";
import { renderApp } from "../render";

// covers: invite.link, invite.code, chat.paired.storage

/*
 * A full localStorage (a profile in use for long): a new chat cannot be stored. Joining by a good invite or starting a
 * chat says that, with what to do, and opens nothing; the good invite is never called "not a Ghostly invite".
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

/** From now on every write is refused, as a full localStorage refuses it. */
function fill() {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); });
}

afterEach(() => { vi.restoreAllMocks(); window.location.hash = ""; });

const keysOf = (code: string) => {
  const reading = readInvite(code);
  if (!reading.ok) throw new Error("a fresh invite reads");
  return reading.keys;
};

it("a new chat the storage has no room for is not made: ensureSession says so, and stores nothing", () => {
  fill();
  expect(() => ensureSession(keysOf(createChatInvite().inviteCode))).toThrow(NO_ROOM_FOR_CHAT);
  expect(listSessions()).toEqual([]);
});

describe("on a full localStorage", () => {
  it("Join with a good invite says there is no room, with what to do, and keeps the dialog open", async () => {
    const { user, engine } = renderApp(<Home />);
    await user.click(screen.getByRole("button", { name: "Join" }));
    fill();
    engine.readClipboardText = vi.fn(async () => createChatInvite().inviteCode);
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No room for a new chat");
    expect(alert).toHaveTextContent("Free some space on this device, for example by deleting old chats, then try again.");
    expect(alert).not.toHaveTextContent("This is not a Ghostly invite.");
    expect(screen.getByRole("textbox", { name: "Invite code" })).toBeInTheDocument();
    expect(listSessions()).toEqual([]);
  });

  it("an invite link says there is no room, not that the invite is bad, and opens no chat", async () => {
    render(<Root />);
    fill();
    const code = createChatInvite().inviteCode;
    window.location.hash = `#${code}`;
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    const notice = await screen.findByTestId("chat-not-stored");
    expect(notice).toHaveTextContent("No room for a new chat");
    expect(notice).toHaveTextContent("deleting old chats");
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
    expect(window.location.hash).toBe("#/");
    expect(listSessions()).toEqual([]);
  }, 60_000);

  it("New chat says there is no room and opens no chat address", async () => {
    render(<Root />);
    const newChat = await screen.findByTestId("sidebar-new-chat");
    fill();
    act(() => newChat.click());
    const notice = await screen.findByTestId("chat-not-stored", undefined, { timeout: 5_000 });
    expect(notice).toHaveTextContent("No room for a new chat");
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
    await waitFor(() => expect(window.location.hash).not.toContain("/chat/"));
    expect(listSessions()).toEqual([]);
  }, 60_000);

  it("the notice closes with Escape, a tap on its words or its ×, and gives the focus back to New", async () => {
    render(<Root />);
    const newChat = await screen.findByTestId("sidebar-new-chat");
    fill();
    const press = async () => {
      act(() => { newChat.focus(); newChat.click(); });
      return screen.findByTestId("chat-not-stored", undefined, { timeout: 5_000 });
    };

    await press();
    // The notice listens for Escape from an effect, which a loaded runner may run after the notice shows: an Escape
    // before that does nothing, so press until it is heard.
    await waitFor(() => {
      act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(screen.queryByTestId("chat-not-stored")).toBeNull();
    });
    expect(document.activeElement).toBe(newChat);

    await press();
    act(() => screen.getByTestId("chat-not-stored-title").click());
    expect(screen.queryByTestId("chat-not-stored")).toBeNull();

    await press();
    // Enter on the ×: the focus is on it when it goes.
    const close = screen.getByTestId("chat-not-stored-close");
    act(() => { close.focus(); close.click(); });
    expect(screen.queryByTestId("chat-not-stored")).toBeNull();
    expect(document.activeElement).toBe(newChat);
  }, 60_000);

  it("an Escape that closes a menu closes only that, and one typed in a field leaves the focus there", async () => {
    /** A popover that closes on outside clicks and Escape, as the chat's ⋮ menu does, and a message field. */
    function Page() {
      const [open, setOpen] = useState(false);
      const ref = useRef<HTMLDivElement>(null);
      useOutsideDismiss(ref, open, () => setOpen(false));
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Options</button>
          {open && <div ref={ref} data-testid="popover"><button type="button">Pin</button></div>}
          <textarea aria-label="Message" />
        </>
      );
    }
    render(<><Root /><Page /></>);
    const newChat = await screen.findByTestId("sidebar-new-chat");
    fill();
    act(() => { newChat.focus(); newChat.click(); });
    await screen.findByTestId("chat-not-stored", undefined, { timeout: 5_000 });
    const escape = () => act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

    act(() => screen.getByRole("button", { name: "Options" }).click());
    const pin = screen.getByRole("button", { name: "Pin" });
    act(() => pin.focus());
    escape();
    expect(screen.queryByTestId("popover")).toBeNull();
    expect(screen.getByTestId("chat-not-stored")).toBeInTheDocument();

    const field = screen.getByRole("textbox", { name: "Message" });
    act(() => field.focus());
    escape();
    expect(document.activeElement).toBe(field);
  }, 60_000);
});
