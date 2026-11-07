import "fake-indexeddb/auto";
import { act } from "@testing-library/react";
import { useCallback, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUICK_REDIAL_MS } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { Chat } from "../../pages/Chat";
import { offerSession } from "../../lib/lockedRing";
import { startRinging } from "../../lib/sounds";
import { saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.ring-elsewhere

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** Each test's chat is a contact of its own: what a chat remembers of its contact's last call outlives its page. */
let contact = 0;
let PEER = "";
let ID = "";
const save = () => saveSession({ id: ID, profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });

/** The contact's side of the call, as its signals reach this page through the engine. */
let ts = 0;
const signal = (t: "o" | "h") => {
  ts = Math.max(ts + 1, Date.now());
  const value = t === "o"
    ? JSON.stringify({ t, ts, u: "peer", p: "peerpeerpeerpeerpeerpeer", f: "cd".repeat(32), s: "actpass", m: ["a", "v"], c: [], ss: [1, 2], v: 0 })
    : JSON.stringify({ t, ts });
  act(() => fakeEngine.emit({ kind: "call-signal", linkId: "link-1", signal: value }));};
const rings = () => vi.mocked(startRinging).mock.calls.filter(([sound]) => sound === "ring").length;

/**
 * The chat as `App` loads it while another page is on screen (App.tsx, `useLoadedChats`): from the contact's offer
 * until its call ends, then let go.
 */
function OffScreen() {
  const [ringing, setRinging] = useState(false);
  const [onCall, setOnCall] = useState(false);
  useEffect(() => engine.onCallSignal((linkId, value) => { if (offerSession(linkId, value)) setRinging(true); }), []);
  const onCallChange = useCallback((_: string, on: boolean) => {
    setOnCall(on);
    if (on) setRinging(false);
  }, []);
  return ringing || onCall ? <Chat sessionId={ID} visible={false} onCallChange={onCallChange} callLayer={null} /> : null;
}

/**
 * A contact's call placed again faster than a person redials, after one that barely rang, is kept as missed with no
 * ring (QUICK_REDIAL_MS, BURST_RING_MS). A chat off screen is loaded only for its call and let go as it ends, so the
 * burst's next call found a chat that knew nothing of the last one and rang again: every call of a ring-and-hang-up
 * loop rang while the person was anywhere but that chat.
 */
describe("a burst of a contact's calls", () => {
  beforeEach(() => {
    contact++;
    PEER = `peer${contact}`.padEnd(52, "p");
    ID = `chat-burst-${contact}`;
    save();
    fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: PEER })] });
  });
  afterEach(() => vi.useRealTimers());

  it("rings once while its chat is not the one open", async () => {
    renderApp(<OffScreen />);
    signal("o");
    await act(async () => {});
    expect(rings()).toBe(1);
    signal("h");
    await act(async () => {});

    // Placed again at once: held back, though the chat was let go between the calls; and again.
    signal("o");
    await act(async () => {});
    expect(rings()).toBe(1);
    signal("h");
    await act(async () => {});
    for (let i = 0; i < 3; i++) {
      signal("o");
      await act(async () => {});
      signal("h");
      await act(async () => {});
    }
    expect(rings()).toBe(1);
  });

  it("rings again off screen once a person could have redialled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    renderApp(<OffScreen />);
    signal("o");
    await act(async () => {});
    signal("h");
    await act(async () => {});
    vi.setSystemTime(Date.now() + QUICK_REDIAL_MS);
    signal("o");
    await act(async () => {});
    expect(rings()).toBe(2);
  });

  it("rings once in the chat that is open, as before", async () => {
    renderApp(<Chat sessionId={ID} visible onCallChange={() => {}} callLayer={null} />);
    signal("o");
    await act(async () => {});
    signal("h");
    await act(async () => {});
    signal("o");
    await act(async () => {});
    expect(rings()).toBe(1);
  });
});
