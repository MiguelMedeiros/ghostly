import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { addMessages, getUnreadCount, loadSession, saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.attention.unread, app.attention.badge

/**
 * A chat open in a hidden page has not been read. Reported on the Mac Desktop (bug hunt r10g): with a chat open, the
 * window closed to the Dock, the contact's messages were marked read as they came, so the Dock icon showed no badge
 * and nothing was unread once the window came back. The same chat open in a page on screen reads them at once.
 */
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
const T = Date.now() - 60_000;
const theirs = (text: string, at: number): ChatMessage => ({ id: `peer_${text}`, sender: "peer", text, timestamp: at });

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
};

function openChat() {
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [theirs("hello", T)], createdAt: T - 1000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  return utils;
}

const unread = () => getUnreadCount(loadSession("chat-1")!);

afterEach(() => { visibility = "visible"; vi.restoreAllMocks(); });

describe("the open chat's unread messages", () => {
  it("in a hidden page stay unread until the page shows again", async () => {
    openChat();
    await screen.findByText("hello");
    expect(unread()).toBe(0);

    act(() => setVisibility("hidden"));
    act(() => {
      addMessages("chat-1", [theirs("while away", T + 1000), theirs("still away", T + 2000)]);
      window.dispatchEvent(new Event("session-updated"));
    });
    await screen.findByText("still away");
    expect(unread()).toBe(2);

    act(() => setVisibility("visible"));
    expect(unread()).toBe(0);
  });

  it("on screen are read as they come", async () => {
    openChat();
    await screen.findByText("hello");
    act(() => {
      addMessages("chat-1", [theirs("on screen", T + 1000)]);
      window.dispatchEvent(new Event("session-updated"));
    });
    await screen.findByText("on screen");
    expect(unread()).toBe(0);
  });
});
