import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JoinDialog } from "../../components/JoinDialog";
import { Home } from "../../pages/Home";
import { renderApp } from "../render";

// covers: chat.paired.storage, invite.code

/**
 * The first two things a new person presses, from the keyboard: Home's New chat and Join's Paste (pressed again, the
 * clipboard still empty). The button pressed is busy while it works, not disabled, so the focus stays on it through a
 * refusal, and a second press while it works does nothing.
 */
const created = vi.hoisted(() => ({ next: null as Promise<string> | null }));
vi.mock("../../lib/pairedChat", () => ({ createPairedChat: vi.fn(() => created.next!) }));
const { createPairedChat } = await import("../../lib/pairedChat");

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const later = <T,>() => { let answer!: (value: T) => void, refuse!: (e: Error) => void; const promise = new Promise<T>((resolve, reject) => { answer = resolve; refuse = reject; }); return { promise, answer, refuse }; };

/**
 * Chromium and WebKit move the focus to the page the moment the focused button turns disabled; happy-dom keeps it (and
 * ignores a disabled button's blur), so the focus is dropped here as theirs is.
 */
let browser: MutationObserver;
const dropFocus = () => {
  const focused = document.activeElement as HTMLButtonElement | null;
  if (!focused?.disabled) return;
  focused.disabled = false; focused.blur(); focused.disabled = true;
};
beforeEach(() => {
  browser = new MutationObserver(dropFocus);
  browser.observe(document.body, { attributes: true, attributeFilter: ["disabled"], subtree: true });
});
afterEach(() => { browser.disconnect(); vi.clearAllMocks(); });

const busy = (button: HTMLElement) => {
  expect(button).toHaveFocus();
  expect(button).toBeEnabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).toHaveAttribute("aria-disabled", "true");
};

describe("Home's New chat", () => {
  it("is busy where pressed, keeps its name, takes no second press and keeps the focus after a refusal", async () => {
    const asked = later<string>();
    created.next = asked.promise;
    const { user } = renderApp(<Home />);
    const newChat = screen.getByRole("button", { name: "New chat" });
    newChat.focus();
    await user.keyboard("{Enter}");
    busy(newChat);
    expect(newChat).toHaveAccessibleName("New chat");
    for (const icon of newChat.querySelectorAll("svg")) expect(icon).toHaveAttribute("aria-hidden", "true");
    await user.keyboard("{Enter}");
    expect(createPairedChat).toHaveBeenCalledTimes(1);
    asked.refuse(new Error("No room for a new chat"));
    await waitFor(() => expect(newChat).not.toHaveAttribute("aria-busy"));
    expect(newChat).toHaveFocus();
    expect(newChat).not.toHaveAttribute("aria-disabled");
  });
});

describe("Join's Paste, pressed again on an empty clipboard", () => {
  it("is busy while it reads and keeps the focus after the second refusal", async () => {
    const { user, engine } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    engine.readClipboardText = vi.fn(async () => "");
    const paste = screen.getByRole("button", { name: "Paste from clipboard" });
    await user.click(paste);
    await screen.findByRole("alert");
    expect(screen.getByRole("textbox", { name: "Invite code" })).toHaveFocus();

    const read = later<string>();
    engine.readClipboardText = vi.fn(() => read.promise);
    paste.focus();
    await user.keyboard("{Enter}");
    busy(paste);
    await user.keyboard("{Enter}");
    expect(engine.readClipboardText).toHaveBeenCalledTimes(1);
    read.answer("");
    await waitFor(() => expect(paste).not.toHaveAttribute("aria-busy"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard is empty.");
    expect(paste).toHaveFocus();
  });
});
