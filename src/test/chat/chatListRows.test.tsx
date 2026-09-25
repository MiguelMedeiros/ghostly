import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { formatListTime, previewText } from "../../lib/chatList";
import { publicKeyLabel } from "../../lib/publicKeyLabel";
import { isSessionPinned, saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { Settings } from "../../pages/Settings";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.rows, settings.chat-list-density

const key = (c: string) => c.repeat(52);
const NOW = Date.now();
const message = (over: Partial<ChatMessage>): ChatMessage => ({ id: `m-${Math.random()}`, text: "hi", sender: "peer", timestamp: NOW, ...over });
const chat = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: NOW, ...over });
const rowOf = (name: string) => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === name)!;
const list = () => renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);

describe("the chat list's rows (compact, the default)", () => {
  it("are two lines: the name and the time, then the last message; the key only in the tooltip and for screen readers", () => {
    saveSession(chat("a", { nick: "Alice", nickSource: "profile", lastSyncAt: NOW - 5 * 60_000, messages: [message({ text: "see you at eight" })] }));
    list();
    const row = rowOf("Alice");
    expect(within(row).getByTestId("chat-row-time")).toHaveTextContent("5m");
    expect(row).toHaveTextContent("see you at eight");
    const short = publicKeyLabel(key("a"));
    expect(row).toHaveAttribute("title", `Alice · ${short}`);
    expect(within(row).queryByTestId("chat-row-key")).not.toBeInTheDocument();
    expect(within(row).getByText(`· ${short}`)).toHaveClass("sr-only");
  });

  it("a contact with no name keeps the friendlier fallback, not the key", () => {
    saveSession(chat("c"));
    list();
    const row = rowOf("Contact · cccccc");
    expect(within(row).getByTestId("chat-row-name")).toHaveClass("italic");
    expect(within(row).queryByTestId("chat-row-key")).not.toBeInTheDocument();
    expect(within(row).getByText("No messages")).toBeInTheDocument();
  });

  it.each([
    ["delivered", "Received"],
    ["sent", "Sent"],
    ["held", "Sent"],
    [undefined, "Sent"],
    ["sending", "Sending"],
    ["queued", "Sending"],
    ["failed", "Not delivered"],
  ] as const)("marks my last message %s as %s", (delivery, label) => {
    saveSession(chat("d", { nick: "Dan", messages: [message({ sender: "me", text: "⚡ Requested 100 sats", delivery })] }));
    list();
    const row = rowOf("Dan");
    expect(within(row).getByTestId("chat-row-delivery")).toHaveAccessibleName(label);
    expect(row).toHaveTextContent("⚡ Requested 100 sats");
  });

  it("puts no delivery mark on the contact's message, and counts what is unread beside it", () => {
    saveSession(chat("e", { nick: "Eve", messages: [message({ text: "one" }), message({ text: "two" }), message({ text: "three" })] }));
    list();
    const row = rowOf("Eve");
    expect(within(row).queryByTestId("chat-row-delivery")).not.toBeInTheDocument();
    expect(within(row).getByTestId("chat-row-unread")).toHaveTextContent("3");
    expect(within(row).getByTestId("chat-row-name")).toHaveClass("font-semibold");
    expect(within(row).getByTestId("chat-row-time")).toHaveClass("text-accent");
  });

  it("caps the unread count at 99+", () => {
    saveSession(chat("f", { nick: "Fay", messages: Array.from({ length: 120 }, (_, i) => message({ id: `f${i}` })) }));
    list();
    expect(within(rowOf("Fay")).getByTestId("chat-row-unread")).toHaveTextContent("99+");
  });

  it("keeps the pin and delete buttons in a layer over the time; a pinned chat says so with a quiet mark before the time", async () => {
    saveSession(chat("g", { nick: "Gus" }));
    const { user } = list();
    const actions = within(rowOf("Gus")).getByTestId("chat-row-actions");
    expect(actions).toHaveClass("absolute", "min-w-full");
    expect(within(actions).getByRole("button", { name: "Delete chat" })).toBeInTheDocument();
    expect(within(rowOf("Gus")).queryByTestId("chat-row-pinned")).not.toBeInTheDocument();
    await user.click(within(actions).getByRole("button", { name: "Pin chat" }));
    expect(isSessionPinned("g")).toBe(true);

    const row = rowOf("Gus");
    const mark = await within(row).findByRole("img", { name: "Pinned" });
    expect(mark).toHaveAttribute("data-testid", "chat-row-pinned");
    // Muted, the size of the delivery ticks, on the name's line just before the time — not under it.
    const status = within(row).getByTestId("chat-row-status");
    expect(status).toContainElement(mark);
    expect(status).toHaveClass("text-text-muted");
    expect(mark.querySelector("svg")).toHaveAttribute("width", "12");
    const time = within(row).getByTestId("chat-row-time");
    expect(status.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status.closest(".contact-row")).toContainElement(time);
    expect(row.querySelector("p")!.parentElement).not.toContainElement(mark);
    // The same layer holds its Unpin button, over the mark and the time, and says it is pressed.
    const unpin = within(within(row).getByTestId("chat-row-actions")).getByRole("button", { name: "Unpin chat" });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    expect(unpin).toHaveAttribute("title", "Unpin chat");
    expect(within(row).getAllByRole("button", { name: /pin chat/i })).toEqual([unpin]);
    // Pinning does not open the chat.
    expect(row).not.toHaveClass("bg-surface-hover");

    await user.click(unpin);
    expect(isSessionPinned("g")).toBe(false);
    expect(within(rowOf("Gus")).queryByTestId("chat-row-pinned")).not.toBeInTheDocument();
    expect(within(rowOf("Gus")).getByRole("button", { name: "Pin chat" })).toHaveAttribute("aria-pressed", "false");
  });

  it("pins and unpins from the keyboard, the layer showing while a button in it has focus", async () => {
    saveSession(chat("k", { nick: "Kim" }));
    const { user } = list();
    const actions = within(rowOf("Kim")).getByTestId("chat-row-actions");
    expect(actions).toHaveClass("group-focus-within:opacity-100");
    within(actions).getByRole("button", { name: "Pin chat" }).focus();
    await user.keyboard("{Enter}");
    expect(isSessionPinned("k")).toBe(true);
    const unpin = await within(rowOf("Kim")).findByRole("button", { name: "Unpin chat" });
    expect(unpin).toHaveFocus();
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    await user.keyboard(" ");
    expect(isSessionPinned("k")).toBe(false);
    expect(within(rowOf("Kim")).getByRole("button", { name: "Pin chat" })).toHaveAttribute("aria-pressed", "false");
  });

  it("the pinned mark takes nothing from the time or the row: its own lane, shrinking never, the name giving way", () => {
    saveSession(chat("l", { nick: "Lou with a name long enough to need cutting", messages: [message({ text: "one" }), message({ text: "two" })] }));
    localStorage.setItem("ghostly_pin_l", "1");
    list();
    const row = rowOf("Lou with a name long enough to need cutting");
    const time = within(row).getByTestId("chat-row-time");
    const status = within(row).getByTestId("chat-row-status");
    // The marks and the time sit together in a lane that never shrinks; the name is what truncates.
    expect(time.parentElement).toBe(status.parentElement);
    expect(time.parentElement).toHaveClass("shrink-0");
    expect(within(row).getByTestId("chat-row-name")).toHaveClass("min-w-0", "truncate");
    // Line-high at most (h-5 = the time's leading-5), so the row keeps its height; the count keeps the second line.
    expect(status).toHaveClass("h-5");
    expect(time).toHaveClass("leading-5");
    expect(within(row).getByTestId("chat-row-unread")).toHaveTextContent("2");
    expect(within(row).getByTestId("chat-row-unread").parentElement!.children).toHaveLength(1);
    // An unread chat's time turns accent; the mark stays quiet.
    expect(time).toHaveClass("text-accent");
    expect(status).not.toHaveClass("text-accent");
  });

  it("names the mark and the buttons in the app's language", () => {
    saveSession(chat("m", { nick: "Mia" }));
    localStorage.setItem("ghostly_pin_m", "1");
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { language: "pt" });
    const row = rowOf("Mia");
    expect(within(row).getByTestId("chat-row-pinned")).toHaveAccessibleName("Fixada");
    expect(within(row).getByTestId("chat-row-pin")).toHaveAccessibleName("Desafixar conversa");
  });

  it("a group with messages shows when, and its members as the second line", () => {
    act(() => fakeEngine.update({ groups: [groupView({ id: "g1", name: "Climbing", status: "active", lastMessageAt: NOW - 2 * 3_600_000 })] }));
    list();
    const row = screen.getByTestId("group-row");
    expect(within(row).getByTestId("chat-row-time")).toHaveTextContent("2h");
    expect(row).toHaveTextContent("0 members");
  });
});

describe("Comfortable density", () => {
  it("brings the key back as its own line, and the choice is kept", async () => {
    saveSession(chat("h", { nick: "Hal" }));
    const settings = renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>);
    const choice = screen.getByTestId("chat-list-density");
    expect(within(choice).getByRole("button", { name: "Compact" })).toHaveAttribute("aria-pressed", "true");
    await settings.user.click(within(choice).getByRole("button", { name: "Comfortable" }));
    expect(within(choice).getByRole("button", { name: "Comfortable" })).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(localStorage.getItem("ghostly_app_settings")!).chatListDensity).toBe("comfortable");
    settings.unmount();

    list();
    expect(within(rowOf("Hal")).getByTestId("chat-row-key")).toHaveTextContent(publicKeyLabel(key("h")));
  });

  it("an unknown stored value falls back to Compact", () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListDensity: "roomy" }));
    saveSession(chat("i", { nick: "Ida" }));
    list();
    expect(within(rowOf("Ida")).queryByTestId("chat-row-key")).not.toBeInTheDocument();
  });
});

describe("the list's words", () => {
  it("say how long ago in the fewest letters", () => {
    expect(formatListTime(NOW - 10_000, NOW)).toBe("now");
    expect(formatListTime(NOW - 59 * 60_000, NOW)).toBe("59m");
    expect(formatListTime(NOW - 23 * 3_600_000, NOW)).toBe("23h");
    expect(formatListTime(NOW - 6 * 86_400_000, NOW)).toBe("6d");
    expect(formatListTime(NOW - 30 * 86_400_000, NOW)).not.toMatch(/^\d+[mhd]$/);
  });

  it("read a pasted token as what it is", () => {
    expect(previewText("hello")).toBe("hello");
    expect(previewText("cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vbWludCJ9XX0")).toBe("⚡ Ecash");
  });
});
