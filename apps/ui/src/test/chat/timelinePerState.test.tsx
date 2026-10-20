import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import type { TransportEntry } from "../../lib/transportEvents";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.scroll, transport.timeline

/*
 * The engine sends a new state a few times a second while nothing happens in a chat (its polls, presence, typing
 * elsewhere), and four a second while a file or a voice message moves. The open chat's timeline (its messages with
 * the transport and identity lines between them) goes over the whole history: it is put together again only when one
 * of those changed, not because a state brought a new copy of the same lines. The engine gives a chat with no identity
 * shares a new empty list each time, and the extension's port copies every list.
 */

const merges = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../lib/transportEvents", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/transportEvents")>();
  return { ...real, mergeTimeline: (...args: Parameters<typeof real.mergeTimeline>) => { merges.count++; return real.mergeTimeline(...args); } };
});
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
const COUNT = 300;
const START = 1_700_000_000_000;

function history(): ChatMessage[] {
  return Array.from({ length: COUNT }, (_, i) => ({ id: `peer_${i}`, sender: "peer", timestamp: START + i * 60_000, text: `Message ${i}` }));
}

const connected: TransportEntry = { id: "t1", at: START + (COUNT - 2) * 60_000 + 1, kind: "connected", transport: "webrtc/1" };
const link = (transportLog: TransportEntry[]) => linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" }, transportLog, identityTimeline: [] } as never);

const settle = () => act(() => vi.advanceTimersByTimeAsync(50));

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); merges.count = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("an open chat's timeline", () => {
  it("is not put together again by an engine state that changes none of its rows, and follows one that does", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: history(), createdAt: START });
    const { engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    engine.update({ links: [link([connected])] });
    await screen.findByText(`Message ${COUNT - 1}`);
    await settle();
    expect(screen.getAllByTestId("transport-line")).toHaveLength(1);
    merges.count = 0;

    // The same chat in each state, every list a new copy: a poll, the contact's presence, a file moving elsewhere.
    for (let i = 0; i < 5; i++) act(() => engine.setState(structuredClone(engine.state)));
    // As the engine in the page gives it: the same transport lines, and a new empty list for no identity shares.
    const lines = engine.state.links[0]!.transportLog!;
    for (let i = 0; i < 5; i++) act(() => engine.update({ links: [link(lines)] }));
    await settle();
    expect(merges.count).toBe(0);

    // A new transport line: the timeline follows.
    act(() => engine.update({ links: [link([connected, { id: "t2", at: START + COUNT * 60_000, kind: "lost", from: "webrtc/1" }])] }));
    await settle();
    expect(merges.count).toBeGreaterThan(0);
    expect(screen.getAllByTestId("transport-line")).toHaveLength(2);
  });
});
