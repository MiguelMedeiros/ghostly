// An app running in another chat (hidden is enough) that starts and stops serving a file, up to its 50 requests a
// second, does not draw this chat again: each chat's page follows only its own chat's app.
import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { setChatApp, updateChatApp } from "../../lib/apps/running";
import type { RunningApp } from "../../lib/apps/broker";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
const START = 1_700_000_000_000;

const history = (): ChatMessage[] => Array.from({ length: 20 }, (_, i) => ({
  id: `peer_${i}`, sender: "peer", timestamp: START + i * 60_000, text: `Message ${i}`,
} as ChatMessage));
const link = () => linkView({ id: "link-1", peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never);
const settle = () => act(() => vi.advanceTimersByTimeAsync(50));

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { setChatApp("link-2", null); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("an app in another chat", () => {
  it("serving and unserving a file does not draw this chat again", async () => {
    let commits = 0;
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: history(), createdAt: START });
    const { engine } = renderApp(
      <Profiler id="chat" onRender={() => { commits++; }}>
        <Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />
      </Profiler>,
    );
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    engine.update({ links: [link()] });
    await screen.findByText("Message 19");
    await settle();

    const running = { frame: document.createElement("iframe"), phase: "running", stop: () => {} } as unknown as RunningApp;
    act(() => setChatApp("link-2", { ref: "k/cinema", title: "Cinema", shown: false, wide: false, view: "chat", running }));
    await settle();
    commits = 0;
    for (let i = 0; i < 20; i++) act(() => updateChatApp("link-2", { serving: i % 2 === 0 }));
    await settle();
    expect(commits).toBe(0);
  });
});
