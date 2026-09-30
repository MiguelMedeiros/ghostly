import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCE_CLEAR_MS, ANNOUNCE_WINDOW_MS, MessageAnnouncer, type Announceable } from "../../components/chat/MessageAnnouncer";
import { renderApp } from "../render";

// covers: app.accessibility, chat.paired.send, groups.send

let n = 0;
const peer = (text: string, extra: Partial<Announceable> = {}): Announceable => ({ id: `m${++n}`, sender: "peer", text, ...extra });
const mine = (text: string): Announceable => ({ id: `m${++n}`, sender: "me", text });
const HISTORY = [peer("an old one"), mine("my old one")];

const nameOf = (m: Announceable) => m.member === "b" ? "Bob" : "Alice";

function setup(messages: readonly Announceable[], chat = "chat-1", active = true) {
  const view = renderApp(<MessageAnnouncer chat={chat} messages={messages} nameOf={nameOf} active={active} />);
  const update = (next: readonly Announceable[], nextChat = chat, nextActive = active) =>
    view.rerender(<MessageAnnouncer chat={nextChat} messages={next} nameOf={nameOf} active={nextActive} />);
  return { update };
}

const region = () => screen.getByTestId("chat-announcement");
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("a new message, read out to a screen reader", () => {
  it("is one polite, atomic line that is there, empty, before anything comes", () => {
    setup(HISTORY);
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toHaveAttribute("aria-atomic", "true");
    expect(region()).toHaveClass("sr-only");
    expect(region()).toHaveTextContent("");
  });

  it("the chat's history, as it opens, is not read out", () => {
    setup(HISTORY);
    wait(ANNOUNCE_WINDOW_MS * 2);
    expect(region()).toHaveTextContent("");
  });

  it("a message from the contact: who, and what it says", () => {
    const { update } = setup(HISTORY);
    update([...HISTORY, peer("see you at **noon**")]);
    expect(region()).toHaveTextContent("");
    wait(ANNOUNCE_WINDOW_MS);
    expect(region()).toHaveTextContent(/^Alice: see you at noon$/);
    wait(ANNOUNCE_CLEAR_MS);
    expect(region()).toHaveTextContent("");
  });

  it("a long message is cut short", () => {
    const { update } = setup(HISTORY);
    update([...HISTORY, peer("word ".repeat(60))]);
    wait(ANNOUNCE_WINDOW_MS);
    const said = region().textContent!;
    expect(said.startsWith("Alice: word word")).toBe(true);
    expect(said.endsWith("…")).toBe(true);
    expect(said.length).toBeLessThan(100);
  });

  it("my own messages, and the chat's notes, are not read out", () => {
    const { update } = setup(HISTORY);
    update([...HISTORY, mine("hi"), peer("Alice joined", { systemEvent: { type: "join" } }), peer("Missed call", { callEvent: { type: "missed" } }), peer("joined", { event: { type: "joined" } })]);
    wait(ANNOUNCE_WINDOW_MS * 2);
    expect(region()).toHaveTextContent("");
  });

  it("several at once are counted, not read one after the other", () => {
    const { update } = setup(HISTORY);
    const one = peer("one"), two = peer("two"), three = peer("three");
    update([...HISTORY, one]);
    wait(ANNOUNCE_WINDOW_MS / 3);
    update([...HISTORY, one, two]);
    update([...HISTORY, one, two, three]);
    wait(ANNOUNCE_WINDOW_MS);
    expect(region()).toHaveTextContent(/^3 new messages from Alice$/);
  });

  it("in a group, several from different members are counted without a name", () => {
    const { update } = setup(HISTORY);
    update([...HISTORY, peer("hi", { member: "a" }), peer("hey", { member: "b" })]);
    wait(ANNOUNCE_WINDOW_MS);
    expect(region()).toHaveTextContent(/^2 new messages$/);
  });

  it("the same words twice are read out twice (the line empties between them)", () => {
    const { update } = setup(HISTORY);
    const first = [...HISTORY, peer("ok")];
    update(first);
    wait(ANNOUNCE_WINDOW_MS);
    expect(region()).toHaveTextContent("Alice: ok");
    wait(ANNOUNCE_CLEAR_MS);
    update([...first, peer("ok")]);
    wait(ANNOUNCE_WINDOW_MS);
    expect(region()).toHaveTextContent("Alice: ok");
  });

  it("older messages loaded above, an edit or a reaction are not news", () => {
    const { update } = setup(HISTORY);
    update([peer("older"), peer("older still"), ...HISTORY]);
    update([peer("older"), peer("older still"), { ...HISTORY[0], text: "an old one, edited" }, HISTORY[1]]);
    wait(ANNOUNCE_WINDOW_MS * 2);
    expect(region()).toHaveTextContent("");
  });

  it("another chat opening is not news either, and nothing of the last one is read out in it", () => {
    const { update } = setup(HISTORY);
    update([...HISTORY, peer("for chat 1")]);
    update([peer("chat 2's history")], "chat-2");
    wait(ANNOUNCE_WINDOW_MS * 2);
    expect(region()).toHaveTextContent("");
  });

  it("a chat kept open behind another one reads nothing out", () => {
    const { update } = setup(HISTORY, "chat-1", false);
    update([...HISTORY, peer("while away")]);
    wait(ANNOUNCE_WINDOW_MS * 2);
    expect(region()).toHaveTextContent("");
  });
});
