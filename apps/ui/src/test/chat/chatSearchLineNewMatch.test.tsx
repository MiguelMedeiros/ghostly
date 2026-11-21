import "fake-indexeddb/auto";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { SEARCH_DEBOUNCE_MS } from "../../hooks/useChatSearch";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.search

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p");
const COUNT = 300;
const AT = 1_700_000_000_000;

/** "Message 0" to "Message 299" (every third one mine, the rest Ana's), and Ana's "Um Café amanhã?" among the last. */
function history(): ChatMessage[] {
  const list: ChatMessage[] = Array.from({ length: COUNT }, (_, i) => ({ id: `m${i}`, sender: i % 3 ? "peer" : "me", timestamp: AT + i * 60_000, text: `Message ${i}`, delivery: "delivered" }));
  list.splice(280, 0, { id: "cafe", sender: "peer", timestamp: AT + 280 * 60_000 - 1, text: "Um Café amanhã?" });
  return list;
}

// Each test draws the whole Chat page with a hundred rows: seconds on a busy machine, with nothing in it that waits.
vi.setConfig({ testTimeout: 30_000 });

function openChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: history(), createdAt: AT });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  return utils;
}

const settle = (ms = 50) => act(() => vi.advanceTimersByTimeAsync(ms));
const field = () => screen.getByTestId<HTMLInputElement>("chat-search-input");
const said = () => screen.getByTestId("chat-search-said");
const ctrlF = () => fireEvent.keyDown(window, { key: "f", ctrlKey: true });
const type = async (text: string) => { fireEvent.change(field(), { target: { value: text } }); await settle(SEARCH_DEBOUNCE_MS + 10); };
const key = async (shiftKey = false) => { fireEvent.keyDown(field(), { key: "Enter", shiftKey }); await settle(); };

/**
 * Every text the search's live line holds from now on, in order: each change's value before it (a text node's old
 * value, or the nodes it replaced), then the last one. Empty ones and a repeat of the one before are left out: a screen
 * reader says neither.
 */
function listen() {
  const el = said();
  const records: MutationRecord[] = [];
  const observer = new MutationObserver(list => { records.push(...list); });
  observer.observe(el, { childList: true, characterData: true, characterDataOldValue: true, subtree: true });
  return () => {
    records.push(...observer.takeRecords());
    observer.disconnect();
    const held: string[] = [];
    for (const r of records) {
      if (r.type === "characterData") held.push(r.oldValue ?? "");
      else if (r.removedNodes.length) held.push([...r.removedNodes].map(n => n.textContent).join(""));
    }
    held.shift(); // what it said before listening
    held.push(el.textContent ?? "");
    const lines: string[] = [];
    for (const text of held) if (text && text !== lines[lines.length - 1]) lines.push(text);
    return lines;
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Element.prototype.scrollIntoView = function () {};
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// Before, new words drew their matches once with the match read before them: a screen reader heard that one (or the
// new count alone) first, then the newest match.
describe("the search's live line says each new match once", () => {
  it("narrowed words: the newest match of the new words, not the one being read", async () => {
    openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    ctrlF();
    await type("message 2");
    for (let i = 0; i < 29; i++) fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(said().textContent).toBe("30 of 111: You, Message 270");

    const stop = listen();
    await type("message 27");
    await settle();
    expect(stop()).toEqual(["1 of 11: You, Message 279"]);
  });

  it("new words that do not find the match being read: the new match with its count, said once", async () => {
    openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    ctrlF();
    await type("message 29");
    await key();
    expect(said().textContent).toBe("2 of 11: Ana, Message 298");

    const stop = listen();
    await type("cafe");
    await settle();
    expect(stop()).toEqual(["1 of 1: Ana, Um Café amanhã?"]);
  });

  it("Enter and Shift+Enter: one line for each step", async () => {
    openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    ctrlF();
    await type("message 29");
    expect(said().textContent).toBe("1 of 11: Ana, Message 299");

    const stop = listen();
    await key();
    await key();
    await key(true);
    expect(stop()).toEqual(["2 of 11: Ana, Message 298", "3 of 11: You, Message 297", "2 of 11: Ana, Message 298"]);
  });
});
