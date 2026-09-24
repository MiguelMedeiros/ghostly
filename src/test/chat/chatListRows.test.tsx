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

  it("keeps the pin and delete buttons in a layer over the time, and a pinned chat's pin beside the message", async () => {
    saveSession(chat("g", { nick: "Gus" }));
    const { user } = list();
    const actions = within(rowOf("Gus")).getByTestId("chat-row-actions");
    expect(actions).toHaveClass("absolute");
    expect(within(actions).getByRole("button", { name: "Delete chat" })).toBeInTheDocument();
    await user.click(within(actions).getByRole("button", { name: "Pin chat" }));
    expect(isSessionPinned("g")).toBe(true);
    const pinned = await within(rowOf("Gus")).findByRole("button", { name: "Unpin chat" });
    expect(pinned).toHaveAttribute("aria-pressed", "true");
    expect(within(rowOf("Gus")).getByTestId("chat-row-actions")).not.toContainElement(pinned);
    // Pinning does not open the chat.
    expect(rowOf("Gus")).not.toHaveClass("bg-surface-hover");
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
