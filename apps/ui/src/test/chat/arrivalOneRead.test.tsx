import type { ReactNode } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { resetAppBadge, setAppBadgeTarget, useAppBadge } from "../../lib/appBadge";
import { loadSession, saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.storage

/*
 * A message arriving in a long open chat had each part of the page read the chat again, one after the other on the same
 * `session-updated`: the session sync, the chat list with the app's badge, and the open chat, each parsing its stored
 * copy and merging it with the thousands of messages it leaves out. They read the chats through one cache: a chat that
 * changed is read once per arrival, for all of them.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
const LINK = "link-1";
const NOW = Date.now();
const N = 1_000;
const row = (i: number): StoredMessage => ({ linkId: LINK, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (N - i) * 1_000 }) as StoredMessage;
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

function AppIcon({ children }: { children: ReactNode }) {
  useAppBadge();
  return children;
}

afterEach(() => { setAppBadgeTarget(null); vi.restoreAllMocks(); });

describe("a message arriving in a long open chat", () => {
  it("is read once by the whole page: the sync, the chat list, the badge and the chat", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: NOW - N * 2_000 });
    resetAppBadge();
    setAppBadgeTarget({ setAppBadge: async () => {}, clearAppBadge: async () => {} });
    const { engine } = renderApp(
      <UpdateProvider><AppIcon><Sidebar /><Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} /></AppIcon></UpdateProvider>,
      { route: "/chat/chat-1" },
    );
    engine.on("ensureLink", () => ({ linkId: LINK })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    engine.update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    engine.messages(LINK, Array.from({ length: N }, (_, i) => row(i)));
    await tick();
    await screen.findAllByText(`message ${N - 1}`);

    // Each read of the chat's stored copy, from here on.
    const parse = JSON.parse;
    let reads = 0;
    vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (typeof text === "string" && text.includes('"id":"chat-1"') && text.includes('"messages"')) reads++;
      return parse(text, reviver);
    });
    for (let i = 0; i < 3; i++) {
      engine.emit({ kind: "message-changes", linkId: LINK, messages: [{ ...row(N + i), timestamp: NOW + i }], deleted: [] });
      await tick();
      await screen.findAllByText(`message ${N + i}`);
    }
    expect(reads).toBe(3);
    expect(loadSession("chat-1")!.messages).toHaveLength(N + 3);
  });
});
