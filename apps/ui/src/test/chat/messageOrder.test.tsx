import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { addMessages, loadSession, saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.order

/**
 * The timeline reads in the order things happened here (WISP 400, requirement 10). The engine places a received row
 * when it comes (`timestamp`) and keeps what the sender's clock said beside it (`sentAt`): the page sorts by the
 * place and shows the sender's time, never one later than the arrival. Reported with a contact's clock two minutes
 * ahead: its messages read "11:23 PM" at 11:21, and my replies sat above them.
 *
 * The mirror that writes the engine's rows into the chat's session is off in these tests (test/setup.ts): the rows
 * are added as it adds them (`addMessages`); packages/browser/test/platformSync.test.ts covers the mirror itself.
 */
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
const MINUTE = 60_000;
/** 11:21 PM here. */
const T = Date.now() - 10 * MINUTE;

const mine = (text: string, at: number): ChatMessage => ({ id: `me_${at}`, sender: "me", text, timestamp: at, delivery: "delivered" });
/** A contact's row as the engine stores it: placed when it came, with what the contact's clock said. */
const theirs = (text: string, cameAt: number, skew: number): ChatMessage =>
  ({ id: `peer_${text}`, sender: "peer", text, timestamp: cameAt, sentAt: cameAt + skew });

function openChat(messages: ChatMessage[]) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages, createdAt: T - MINUTE });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  return utils;
}

const shownTexts = () => screen.getAllByTestId("message-text").map((el) => el.textContent);
const shownTimes = () => screen.getAllByTestId("message-time").map((el) => Number(el.getAttribute("data-at")));

afterEach(() => { vi.restoreAllMocks(); });

describe("the timeline with a contact whose clock is off", () => {
  it.each([
    ["two minutes ahead", 2 * MINUTE],
    ["two minutes behind", -2 * MINUTE],
    ["three days ahead", 3 * 24 * 60 * MINUTE],
  ])("%s: messages read in the order they came, and none shows a time that has not come", async (_, skew) => {
    // I wrote, the contact answered twice, I replied, the contact answered again: each 20 seconds after the last.
    const step = 20_000;
    openChat([mine("are you there?", T), mine("good, see you then", T + 3 * step)]);
    await screen.findByText("good, see you then");
    act(() => {
      addMessages("chat-1", [theirs("yes", T + step, skew), theirs("just arrived", T + 2 * step, skew), theirs("see you", T + 4 * step, skew)]);
      window.dispatchEvent(new Event("session-updated"));
    });
    await screen.findByText("see you");

    expect(shownTexts()).toEqual(["are you there?", "yes", "just arrived", "good, see you then", "see you"]);
    // What the session keeps reads the same, for the next time the chat opens.
    expect(loadSession("chat-1")!.messages.map((m) => m.text)).toEqual(["are you there?", "yes", "just arrived", "good, see you then", "see you"]);
    const times = shownTimes();
    expect(times).toHaveLength(5);
    for (const at of times) expect(at).toBeLessThanOrEqual(Date.now());
    // The contact's bubbles show what its clock said, or when they came if that is earlier.
    const expected = (cameAt: number) => Math.min(cameAt + skew, cameAt);
    expect(times).toEqual([T, expected(T + step), expected(T + 2 * step), T + 3 * step, expected(T + 4 * step)]);
  });
});
