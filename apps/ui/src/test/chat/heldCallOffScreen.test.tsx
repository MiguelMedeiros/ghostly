import "fake-indexeddb/auto";
import { act, screen } from "@testing-library/react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RING_MS } from "@ghostly/react";
import { startRinging } from "../../lib/sounds";
import { saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.ring-elsewhere

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));
vi.mock("../../components/Sidebar", () => ({
  Sidebar: () => {
    const navigate = useNavigate();
    return <nav><button data-testid="to-ana" onClick={() => navigate("/chat/chat-held")}>Ana</button></nav>;
  },
}));
vi.mock("../../components/MobileTabBar", () => ({ MobileTabBar: () => null }));
vi.mock("../../components/InstallApp", () => ({ InstallSteps: () => null }));
vi.mock("../../hooks/useAppCommands", () => ({ useAppCommands: () => {} }));

const { App } = await import("../../App");

const ANA = "anaheld".padEnd(52, "a");

/** The contact's side of the call, as its signals reach the app through the engine. */
let ts = 0;
const signal = (t: "o" | "h") => {
  ts = Math.max(ts + 1, Date.now());
  const value = t === "o"
    ? JSON.stringify({ t, ts, u: "peer", p: "peerpeerpeerpeerpeerpeer", f: "cd".repeat(32), s: "actpass", m: ["a", "v"], c: [], ss: [1, 2], v: 0 })
    : JSON.stringify({ t, ts });
  act(() => fakeEngine.emit({ kind: "call-signal", linkId: "link-1", signal: value }));
};
const rings = () => vi.mocked(startRinging).mock.calls.filter(([sound]) => sound === "ring").length;
/** Ana's chat, as App draws it: there while hidden, on screen or not. */
const anaChat = () => screen.queryAllByTestId("chat-name").filter((name) => name.textContent?.includes("Ana"));
const later = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

afterEach(() => vi.useRealTimers());

/**
 * A contact's call placed again at once after one that barely rang is held back as missed, with no ring
 * (QUICK_REDIAL_MS), while it still rings on the contact's side. Calling them back rings it here instead, or the two
 * calls would cross and neither ring (`useWebRTC`'s `startCall`). The chat holds that call only while it is loaded:
 * with another page on screen, App let it go 15 s after the contact's first offer, and a call back after that crossed
 * the held one: both sides said "Calling..." until it ran out.
 */
describe("a contact's call held back while their chat is not the one open", () => {
  it("keeps the chat loaded while the held call can still ring, and lets it go after", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    saveSession({ id: "chat-held", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: ANA, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    fakeEngine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    fakeEngine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: ANA, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    renderApp(<Routes><Route path="/" element={<App />}><Route path="*" element={null} /></Route></Routes>, { route: "/settings" });

    // A ring that barely rang, then the same call again at once: held back, no second ring.
    signal("o");
    await act(async () => {});
    expect(rings()).toBe(1);
    signal("h");
    await act(async () => {});
    await later(500);
    signal("o");
    await act(async () => {});
    expect(rings()).toBe(1);
    expect(anaChat()).toHaveLength(1);

    // It still rings on the contact's side for its minute: the chat that holds it stays.
    await later(20_000);
    expect(anaChat()).toHaveLength(1);
    await later(RING_MS - 20_000 - 1_000);
    expect(anaChat()).toHaveLength(1);
    // Past it, nothing is held any more: let go.
    await later(2_000);
    expect(anaChat()).toHaveLength(0);
  });
});
