import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { forgetChatScroll } from "../../hooks/useChatScroll";
import { saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.days

/**
 * A chat's messages under the date of their day (public request ghostly#3781): one date before each day's first
 * message, the first day's included, never two for one day; Today and Yesterday for the last two, which move on at
 * midnight. In 1:1 chats and groups, and when a group's older history comes in above its first page.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const at = (d: number, h: number, min = 0) => new Date(2026, 9, d, h, min).getTime();
/** Each date on screen, in order, with the first message under it. */
const days = () => [...document.querySelectorAll<HTMLElement>("[data-message-list] section[data-day]")].map(section => ({
  label: section.querySelector("[data-testid=chat-day]")!.textContent,
  first: section.querySelector<HTMLElement>("[data-message-id]")?.dataset.messageId,
}));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: at(29, 15) });
  forgetChatScroll();
});
afterEach(() => { vi.useRealTimers(); });

describe("a 1:1 chat", () => {
  const PEER = "peer".padEnd(52, "p");
  const message = (n: number, timestamp: number): ChatMessage => n % 2
    ? { id: `peer_m${n}`, ref: `m${n}`, sender: "peer", timestamp, text: `Message ${n}` }
    : { id: `me_m${n}`, ref: `m${n}`, sender: "me", timestamp, text: `Message ${n}`, delivery: "delivered" };
  function open(messages: ChatMessage[], paired = true) {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages, createdAt: at(20, 9) });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    if (paired) utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    return utils;
  }

  it("has a date before each day's first message, Today and Yesterday the last two", async () => {
    open([message(1, at(27, 9)), message(2, at(27, 23, 59)), message(3, at(28, 0, 0)), message(4, at(28, 18)), message(5, at(29, 8)), message(6, at(29, 14))]);
    await screen.findByText("Message 6");
    expect(days()).toEqual([
      { label: "Tuesday, October 27", first: "peer_m1" },
      { label: "Yesterday", first: "peer_m3" },
      { label: "Today", first: "peer_m5" },
    ]);
    // The date takes no click: what is under it does.
    expect(screen.getAllByTestId("chat-day")[0]).toHaveClass("pointer-events-none", "sticky");
    expect(screen.getAllByTestId("chat-day")[0].querySelector("time")).toHaveAttribute("dateTime", "2026-10-27");
  });

  it("moves Today and Yesterday on at midnight, with the chat open", async () => {
    open([message(1, at(28, 10)), message(2, at(29, 10))]);
    await screen.findByText("Message 2");
    expect(days().map(d => d.label)).toEqual(["Yesterday", "Today"]);
    await act(() => vi.advanceTimersByTimeAsync(at(30, 0) - at(29, 15) + 1_000));
    expect(days().map(d => d.label)).toEqual(["Wednesday, October 28", "Yesterday"]);
  });

  it("an empty chat has no date", async () => {
    // Not paired yet: no line of its own ("You joined") either.
    open([], false);
    await screen.findByText("Send a message or wait for your contact");
    expect(screen.queryAllByTestId("chat-day")).toHaveLength(0);
  });
});

describe("a group", () => {
  const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
  const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
  /** Two messages a day from the 1st of October, at 10:00 and 20:00: 58 rows over 29 days. */
  const history: StoredMessage[] = Array.from({ length: 58 }, (_, i) => ({
    linkId: "group:group-1", id: `g${String(i).padStart(3, "0")}`, text: `Message ${i}`, sender: "peer", member: ALICE,
    timestamp: at(1 + (i >> 1), i % 2 ? 20 : 10), via: "datalink",
  }));

  it("has one date per day, its first page's and the older days' coming in above it", async () => {
    let whole!: (list: StoredMessage[]) => void;
    fakeEngine.on("messagePage", () => ({ messages: history.slice(-5), more: true }))
      .on("groupMessages", () => new Promise<StoredMessage[]>(done => { whole = done; }))
      .on("updateSettings", () => undefined)
      .update({ groups: [groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice" })] })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });

    await screen.findByText("Message 57");
    // The page starts with the 27th's second message: its date is above it.
    expect(days()).toEqual([
      { label: "Tuesday, October 27", first: "g053" },
      { label: "Yesterday", first: "g054" },
      { label: "Today", first: "g056" },
    ]);

    await act(async () => { whole(history); await vi.advanceTimersByTimeAsync(0); });
    const shown = days();
    // The 27th's first message came in above: the same date, now above it, and no second one.
    expect(shown.slice(-3)).toEqual([
      { label: "Tuesday, October 27", first: "g052" },
      { label: "Yesterday", first: "g054" },
      { label: "Today", first: "g056" },
    ]);
    expect(new Set(shown.map(d => d.label)).size).toBe(shown.length);
    for (const { first } of shown) expect(Number(first!.slice(1)) % 2).toBe(0);
  });
});
