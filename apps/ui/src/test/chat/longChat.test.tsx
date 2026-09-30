import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { loadSession, saveSession } from "../../lib/storage";
import { sameValue } from "../../lib/sameValue";
import type { ChatMessage } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { OPEN_ROWS } from "../../hooks/useRowWindow";

// covers: chat.scroll

/**
 * A long chat is drawn once, not again on every change of its page (Miguel, 2026-09-28: a long chat was slow to open
 * and lagged while open). Each message's text is drawn by `RichText`, so its draws count the bubbles drawn.
 */

const draws = vi.hoisted(() => ({ text: 0, files: [] as string[] }));
vi.mock("../../components/rich/RichText", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../components/rich/RichText")>();
  return { ...real, RichText: (props: Parameters<typeof real.RichText>[0]) => { draws.text++; return real.RichText(props); } };
});
// A bubble with a file asks, each time it is drawn, whether its transfer can be tried again: its draws.
vi.mock("../../lib/fileStatus", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/fileStatus")>();
  return { ...real, canRetryFile: (...args: Parameters<typeof real.canRetryFile>) => { draws.files.push(args[0].id); return real.canRetryFile(...args); } };
});
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
const COUNT = 300;
const wire = (i: number) => `w${String(i).padStart(21, "0")}`;
/** A message of mine among the last ones (in the page: useRowWindow), with the contact's ❤️. */
const REACTED = COUNT - 6;
/** A message of mine among the last ones, answering the contact's before it. */
const REPLY = COUNT - 21;

/** `COUNT` texts, every third mine, every tenth answering the one before it, every sixth with the contact's ❤️. */
function history(): ChatMessage[] {
  return Array.from({ length: COUNT }, (_, i) => {
    const mine = i % 3 === 0, ref = wire(i);
    return {
      id: mine ? `me_${ref}` : `peer_${ref}`, ref, sender: mine ? "me" : "peer", timestamp: 1_700_000_000_000 + i * 60_000, text: `Message ${i}`,
      ...(mine && { delivery: "delivered" as const }),
      ...(i % 10 === 9 && { replyTo: { id: wire(i - 1), snippet: `Message ${i - 1}`, from: (i - 1) % 3 === 0 ? "me" as const : "peer" as const, messageId: `${(i - 1) % 3 === 0 ? "me" : "peer"}_${wire(i - 1)}` } }),
      ...(i % 6 === 0 && { reactions: { peer: { e: "❤️", n: 1, at: 1_700_000_000_000 + i * 60_000 + 1 } } }),
    };
  });
}

const link = () => linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never);

function openChat(withLink = true, messages = history()) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages, createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("react", () => ({ error: null })).on("sendMessage", () => ({ error: null }));
  if (withLink) utils.engine.update({ links: [link()] });
  return utils;
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(50));

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); draws.text = 0; draws.files = []; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("a long chat", () => {
  it("draws its messages again for nothing that changed none of them", async () => {
    const { engine } = openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    await settle();
    // The rows in the page: the last ones, not the whole history.
    expect(draws.text).toBeGreaterThanOrEqual(OPEN_ROWS);
    expect(draws.text).toBeLessThan(COUNT);

    draws.text = 0;
    // The engine's state moves on (a poll, a delivery elsewhere, the contact typing), and storage is read again.
    for (let i = 0; i < 5; i++) {
      act(() => engine.update({ links: [link()], transport: { ...engine.state.transport, relays: [`wss://relay-${i}.example`] } }));
      act(() => { window.dispatchEvent(new Event("session-updated")); });
    }
    await settle();
    expect(draws.text).toBe(0);
  });

  it("draws its files again only when their transfer changes, not on every change of the engine's state", { timeout: 15_000 }, async () => {
    // Every thirtieth message a voice note of mine: each one watches its transfer.
    const messages = history().map((m, i): ChatMessage => i % 30 === 0
      ? { ...m, text: "", file: { id: `voice-${i}`, name: `voice-${i}.webm`, size: 40_000, mime: "audio/webm", voice: { duration: 4_000, peaks: [1, 2, 3] } } }
      : m);
    const { engine } = openChat(true, messages);
    await screen.findByText(`Message ${COUNT - 1}`);
    await settle();
    expect(new Set(draws.files).size).toBe(messages.slice(-OPEN_ROWS).filter(m => m.file).length);

    draws.files = [];
    for (let i = 0; i < 5; i++) act(() => engine.update({ links: [link()], transport: { ...engine.state.transport, relays: [`wss://relay-${i}.example`] } }));
    await settle();
    expect(draws.files).toEqual([]);

    // Its transfer moves: that bubble, and only that one, is drawn again.
    act(() => engine.update({ transfers: { "voice-270": { state: "transferring", transferred: 10_000, size: 40_000 } } } as never));
    await settle();
    expect(new Set(draws.files)).toEqual(new Set(["voice-270"]));
  });

  it("draws no message while you type, and does not collapse the field on each keystroke", async () => {
    const { user } = openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    await settle();
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
    let styleChanges = 0;
    new MutationObserver(records => { styleChanges += records.length; }).observe(field, { attributes: true, attributeFilter: ["style"] });
    draws.text = 0;
    await user.type(field, "typing in a long chat");
    await settle();
    expect(field).toHaveValue("typing in a long chat");
    expect(draws.text).toBe(0);
    // Its height is given once: a collapse and a measure on every keystroke laid the whole chat out again.
    expect(styleChanges).toBeLessThanOrEqual(1);
  });

  it("draws only the new message when one comes", async () => {
    openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    await settle();
    draws.text = 0;
    act(() => {
      const session = loadSession("chat-1")!;
      session.messages.push({ id: `peer_${wire(COUNT)}`, ref: wire(COUNT), sender: "peer", timestamp: Date.now(), text: "Hello again" });
      saveSession(session);
      window.dispatchEvent(new Event("session-updated"));
    });
    await screen.findByText("Hello again");
    await settle();
    expect(draws.text).toBe(1);
  });

  it("a bubble drawn before the chat's link came reacts over it (its callbacks are the latest)", async () => {
    const { engine } = openChat(false);
    await screen.findByText(`Message ${COUNT - 1}`);
    await settle();
    act(() => engine.update({ links: [link()] }));
    await settle();
    const row = document.querySelector<HTMLElement>(`[data-message-id="me_${wire(REACTED)}"]`)!;
    act(() => within(row).getByTestId("reaction-chip").click());
    await settle();
    expect(engine.callsTo("react")).toEqual([{ linkId: "link-1", messageId: `me_${wire(REACTED)}`, emoji: "❤️" }]);
  });

  it("a quote tapped whose original is not in the page still goes to it", () => {
    // The original is the first message: far above the rows in the page, until the tap brings it in.
    vi.useRealTimers();
    vi.useFakeTimers();
    const messages = history();
    messages[COUNT - 1] = { ...messages[COUNT - 1], replyTo: { id: wire(0), snippet: "Message 0", from: "me", messageId: `me_${wire(0)}` } };
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages, createdAt: 1_700_000_000_000 });
    const { engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    const original = () => document.querySelector<HTMLElement>(`[data-message-id="me_${wire(0)}"]`);
    expect(original()).toBeNull();
    const last = document.querySelector<HTMLElement>(`[data-message-id="${messages[COUNT - 1].id}"]`)!;
    act(() => within(last).getByTestId("message-quote").click());
    expect(original()).toHaveAttribute("data-reply-flash");
    expect(within(last).queryByTestId("reply-quote-note")).not.toBeInTheDocument();
  });

  it("names the contact anew in its reactions and quotes when the chat is renamed", async () => {
    const { user } = openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    await settle();
    const row = () => document.querySelector<HTMLElement>(`[data-message-id="me_${wire(REACTED)}"]`)!;
    expect(within(row()).getByTestId("reaction-chip")).toHaveAccessibleName("❤️: Ana");
    await user.click(screen.getByTestId("chat-name"));
    const input = screen.getByPlaceholderText("Set a name...");
    await user.clear(input);
    await user.type(input, "Bea{Enter}");
    await settle();
    expect(within(row()).getByTestId("reaction-chip")).toHaveAccessibleName("❤️: Bea");
    // Message 279 answers Message 278, the contact's.
    expect(within(document.querySelector<HTMLElement>(`[data-message-id="me_${wire(REPLY)}"]`)!).getByTestId("message-quote")).toHaveTextContent("Bea");
  });
});

describe("sameValue", () => {
  it("compares what JSON holds by content, a missing key as undefined", () => {
    const message = { id: "a", n: 1, file: { peaks: [1, 2, 3] }, reactions: { peer: { e: "❤️" } } };
    expect(sameValue(message, JSON.parse(JSON.stringify(message)))).toBe(true);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameValue({ file: { peaks: [1, 2, 3] } }, { file: { peaks: [1, 2, 4] } })).toBe(false);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue([], {})).toBe(false);
    expect(sameValue(null, {})).toBe(false);
    expect(sameValue(NaN, NaN)).toBe(true);
    expect(sameValue(new Date(1), new Date(2))).toBe(false);
  });
});
