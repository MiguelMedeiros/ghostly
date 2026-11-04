import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { groupChat, setChatMute } from "../../lib/chatMute";
import { markGroupRead } from "../../lib/groups";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import type { Language } from "../../lib/settings";
import { fakeEngine, groupView } from "../fakeEngine";
import { labelInName } from "../labelInName";
import { renderApp } from "../render";

// covers: chats.list.rows

/*
 * A row's button says what its badges and marks show (agents#2706): moving row by row, a screen reader hears which
 * chats have something unread, which are muted and pinned, and a group's mention, in the app's language. The badges
 * themselves are hidden from it, so nothing is read twice; the name still starts with the name shown (WCAG 2.5.3).
 */

const key = (c: string) => c.repeat(52);
const NOW = Date.now();
const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m-${Math.random()}`, text: "hi", sender: "peer", timestamp: NOW, ...over });
const chat = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: NOW, ...over });
const unread = (n: number) => Array.from({ length: n }, (_, i) => message({ id: `u${i}`, text: `line ${i}` }));
const list = (language?: Language) => renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { language });
const rowOf = (name: string) => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === name)!;
const openOf = (name: string) => within(rowOf(name)).getByTestId("chat-row-open");

describe("a chat's row, read by a screen reader", () => {
  it("says the unread count, muted and pinned after the name, and keeps the last message as its description", () => {
    saveSession(chat("a", { nick: "Alice", nickSource: "profile", messages: unread(3) }));
    setChatMute("a", "forever");
    localStorage.setItem("ghostly_pin_a", "1");
    list();
    expect(screen.getByRole("button", { name: "Alice, 3 unread messages, notifications muted, pinned" })).toBe(openOf("Alice"));
    expect(openOf("Alice")).toHaveAccessibleDescription("line 2");
    // Label in Name (WCAG 2.5.3): the name shown is in the button's name, at its start.
    const shown = within(rowOf("Alice")).getByTestId("chat-row-name").textContent!;
    expect(labelInName(shown, openOf("Alice").getAttribute("aria-label")!)).toBe(true);
    expect(openOf("Alice").getAttribute("aria-label")!.startsWith(shown)).toBe(true);
  });

  it("says one message in the singular, and nothing more for a chat with nothing unread and no marks", () => {
    saveSession(chat("b", { nick: "Bob", nickSource: "profile", messages: unread(1) }));
    saveSession(chat("c", { nick: "Cid", nickSource: "profile", messages: [message({ sender: "me" })] }));
    list();
    expect(openOf("Bob")).toHaveAccessibleName("Bob, 1 unread message");
    expect(openOf("Cid")).toHaveAccessibleName("Cid");
  });

  it("starts with the name shown, the key after it, for a contact with no name", () => {
    saveSession(chat("d", { messages: unread(2) }));
    list();
    expect(openOf("Contact · dddddd").getAttribute("aria-label")).toMatch(/^Contact · dddddd · .+, 2 unread messages$/);
  });

  it("hides the badge and the marks themselves, so the count and the marks are not read a second time", () => {
    saveSession(chat("e", { nick: "Eve", nickSource: "profile", messages: unread(3) }));
    setChatMute("e", "forever");
    localStorage.setItem("ghostly_pin_e", "1");
    list();
    const row = rowOf("Eve");
    for (const id of ["chat-row-unread", "chat-row-muted", "chat-row-pinned"]) {
      expect(within(row).getByTestId(id)).toHaveAttribute("aria-hidden", "true");
    }
    // The badge still shows the count, as before.
    expect(within(row).getByTestId("chat-row-unread")).toHaveTextContent("3");
    expect(within(row).queryByRole("img", { name: /muted|pinned/i })).not.toBeInTheDocument();
  });

  it.each([
    [2, "Ali، رسالتان غير مقروءتين، الإشعارات مكتومة، مثبّتة"],
    [5, "Ali، 5 رسائل غير مقروءة، الإشعارات مكتومة، مثبّتة"],
    [11, "Ali، 11 رسالة غير مقروءة، الإشعارات مكتومة، مثبّتة"],
  ] as const)("says %d unread messages in Arabic in the form that count takes", (count, want) => {
    saveSession(chat("f", { nick: "Ali", nickSource: "profile", messages: unread(count) }));
    setChatMute("f", "forever");
    localStorage.setItem("ghostly_pin_f", "1");
    list("ar");
    expect(openOf("Ali")).toHaveAccessibleName(want);
    expect(labelInName("Ali", want)).toBe(true);
  });

  it("says it in Portuguese, one in the singular", () => {
    saveSession(chat("g", { nick: "Gil", nickSource: "profile", messages: unread(1) }));
    localStorage.setItem("ghostly_pin_g", "1");
    list("pt");
    expect(openOf("Gil")).toHaveAccessibleName("Gil, 1 mensagem não lida, fixada");
  });
});

describe("a group's row, read by a screen reader", () => {
  const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
  const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
  const group = (patch: Partial<GroupView> = {}) =>
    groupView({ status: "active", epoch: 1, name: "Team", members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice" })], ...patch });
  const t = 1_700_000_000_000;
  const open = () => within(screen.getByTestId("group-row")).getByTestId("group-row-open");

  it("says it has unread messages, that I was mentioned, and that it is muted; the dot and the @ are not read again", () => {
    markGroupRead("group-1", t - 10);
    setChatMute(groupChat("group-1"), "forever");
    fakeEngine.update({ groups: [group({ lastMessageAt: t, lastMentionAt: t - 5 })] });
    list();
    expect(screen.getByRole("button", { name: "Team, unread messages, you were mentioned, notifications muted" })).toBe(open());
    const row = screen.getByTestId("group-row");
    expect(within(row).getByTestId("group-row-unread")).toHaveAttribute("aria-hidden", "true");
    expect(within(row).getByTestId("group-row-mention")).toHaveAttribute("aria-hidden", "true");
    expect(within(row).getByTestId("chat-row-muted")).toHaveAttribute("aria-hidden", "true");
  });

  it("says only its name once read", () => {
    markGroupRead("group-1", t);
    fakeEngine.update({ groups: [group({ lastMessageAt: t, lastMentionAt: t - 5 })] });
    list();
    expect(open()).toHaveAccessibleName("Team");
  });

  it("says it in Arabic", () => {
    markGroupRead("group-1", t - 10);
    fakeEngine.update({ groups: [group({ lastMessageAt: t, lastMentionAt: t - 5 })] });
    list("ar");
    expect(open()).toHaveAccessibleName("Team، رسائل غير مقروءة، تمت الإشارة إليك");
  });
});
