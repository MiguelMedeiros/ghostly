import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { loadSession, saveSession } from "../../lib/storage";
import { sameValue } from "../../lib/sameValue";
import type { ChatMessage } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.scroll

/**
 * A long chat is drawn once, not again on every change of its page (Miguel, 2026-09-28: a long chat was slow to open
 * and lagged while open). Each message's text is drawn by `RichText`, so its draws count the bubbles drawn.
 */

const draws = vi.hoisted(() => ({ text: 0 }));
vi.mock("../../components/rich/RichText", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../components/rich/RichText")>();
  return { ...real, RichText: (props: Parameters<typeof real.RichText>[0]) => { draws.text++; return real.RichText(props); } };
});
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
const COUNT = 300;
const wire = (i: number) => `w${String(i).padStart(21, "0")}`;

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

function openChat(withLink = true) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: history(), createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("react", () => undefined).on("sendMessage", () => ({ error: null }));
  if (withLink) utils.engine.update({ links: [link()] });
  return utils;
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(50));

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); draws.text = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("a long chat", () => {
  it("draws its messages again for nothing that changed none of them", async () => {
    const { engine } = openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    await settle();
    expect(draws.text).toBeGreaterThanOrEqual(COUNT);

    draws.text = 0;
    // The engine's state moves on (a poll, a delivery elsewhere, the contact typing), and storage is read again.
    for (let i = 0; i < 5; i++) {
      act(() => engine.update({ links: [link()], transport: { ...engine.state.transport, relays: [`wss://relay-${i}.example`] } }));
      act(() => { window.dispatchEvent(new Event("session-updated")); });
    }
    await settle();
    expect(draws.text).toBe(0);
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
    const row = document.querySelector<HTMLElement>(`[data-message-id="me_${wire(0)}"]`)!;
    act(() => within(row).getByTestId("reaction-chip").click());
    await settle();
    expect(engine.callsTo("react")).toEqual([{ linkId: "link-1", messageId: `me_${wire(0)}`, emoji: "❤️" }]);
  });

  it("names the contact anew in its reactions and quotes when the chat is renamed", async () => {
    const { user } = openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    await settle();
    const row = () => document.querySelector<HTMLElement>(`[data-message-id="me_${wire(0)}"]`)!;
    expect(within(row()).getByTestId("reaction-chip")).toHaveAccessibleName("❤️: Ana");
    await user.click(screen.getByTestId("chat-name"));
    const input = screen.getByPlaceholderText("Set a name...");
    await user.clear(input);
    await user.type(input, "Bea{Enter}");
    await settle();
    expect(within(row()).getByTestId("reaction-chip")).toHaveAccessibleName("❤️: Bea");
    // Message 9 answers Message 8, the contact's.
    expect(within(document.querySelector<HTMLElement>(`[data-message-id="me_${wire(9)}"]`)!).getByTestId("message-quote")).toHaveTextContent("Bea");
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
