// The engine sends its whole state anew on every change (up to 20 a second while a file moves). An open chat, and one
// kept loaded off screen for the mini-app that runs in it (App.tsx), draw again only when what they show changes: a
// state that changes nothing of either draws neither.
import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const ANA = "ana".padEnd(52, "a");
const BIA = "bia".padEnd(52, "b");
const START = 1_700_000_000_000;

const history = (who: string): ChatMessage[] => Array.from({ length: 20 }, (_, i) => ({
  id: `${who}_${i}`, sender: "peer", timestamp: START + i * 60_000, text: `${who} ${i}`,
} as ChatMessage));
const settle = () => act(() => vi.advanceTimersByTimeAsync(50));

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("an engine state that changes nothing of a chat", () => {
  it("draws neither the open chat nor one kept loaded behind it", async () => {
    const commits = { open: 0, kept: 0 };
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: ANA, encKeyB64: "a2V5", label: "Ana", messages: history("Ana"), createdAt: START });
    saveSession({ id: "chat-2", profile: "paired-chat/1", mySeedB64: "c2VlZB", peerPubKeyB64: BIA, encKeyB64: "a2V6", label: "Bia", messages: history("Bia"), createdAt: START });
    const { engine } = renderApp(
      <>
        <Profiler id="open" onRender={() => { commits.open++; }}>
          <Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />
        </Profiler>
        <div className="hidden">
          <Profiler id="kept" onRender={() => { commits.kept++; }}>
            <Chat sessionId="chat-2" visible={false} onCallChange={() => {}} callLayer={null} />
          </Profiler>
        </div>
      </>,
    );
    engine.on("ensureLink", (params) => ({ linkId: params.peerPubKeyZ32 === ANA ? "link-1" : "link-2" }))
      .on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    // Each state brings every link as a new object, as the engine's do.
    const links = (patch: Record<string, unknown> = {}) => [
      linkView({ id: "link-1", peerPubKeyZ32: ANA, profile: "paired-chat/1", pairing: { status: "ready" }, ...patch } as never),
      linkView({ id: "link-2", peerPubKeyZ32: BIA, profile: "paired-chat/1", pairing: { status: "ready" } } as never),
    ];
    engine.update({ links: links() });
    await screen.findByText("Ana 19");
    await settle();

    commits.open = commits.kept = 0;
    for (let i = 0; i < 20; i++) {
      act(() => engine.update({ links: links(), transfers: { [`t${i}`]: { bytes: i } } } as never));
      await settle();
    }
    expect(commits).toEqual({ open: 0, kept: 0 });

    // The open chat's own link changing still draws it, and only it.
    act(() => engine.update({ links: links({ status: "offline" }) }));
    await settle();
    expect(commits.open).toBeGreaterThan(0);
    expect(commits.kept).toBe(0);
  });
});
