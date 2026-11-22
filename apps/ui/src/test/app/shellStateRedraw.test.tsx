import "fake-indexeddb/auto";
import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

/*
 * The engine sends its whole state anew on every change, up to 20 a second while a file moves. The app's shell holds
 * the open chat and every chat kept loaded for a mini-app or a call (App.tsx): a state that changes nothing they show
 * draws none of it. The shell's own hooks (the icon's badge, the wake-up table, the hold storage, checking other
 * profiles) followed the whole state, and each state drew the shell and every chat in it again.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));
vi.mock("../../components/Sidebar", () => ({
  Sidebar: () => {
    const navigate = useNavigate();
    return <nav><button data-testid="to-bia" onClick={() => navigate("/chat/chat-2")}>Bia</button></nav>;
  },
}));
/** The chats a mini-app runs in (lib/apps/running.ts): App keeps them loaded while another is on screen. */
let appSessions: readonly string[] = [];
vi.mock("../../lib/apps/running", async (actual) => ({ ...(await actual<typeof import("../../lib/apps/running")>()), useAppSessions: () => appSessions }));
vi.mock("../../components/MobileTabBar", () => ({ MobileTabBar: () => null }));
vi.mock("../../components/InstallApp", () => ({ InstallSteps: () => null }));
vi.mock("../../hooks/useAppCommands", () => ({ useAppCommands: () => {} }));

const { App } = await import("../../App");

const ANA = "ana".padEnd(52, "a"), BIA = "bia".padEnd(52, "b");
const chat = (id: string, peer: string, label: string) =>
  saveSession({ id, profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: peer, encKeyB64: "a2V5", label, messages: [], createdAt: 1_700_000_000_000 });
/** Every link as a new object, as each of the engine's states brings them. */
const links = () => [
  linkView({ id: "link-1", peerPubKeyZ32: ANA, profile: "paired-chat/1", pairing: { status: "ready" } } as never),
  linkView({ id: "link-2", peerPubKeyZ32: BIA, profile: "paired-chat/1", pairing: { status: "ready" } } as never),
];
const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

afterEach(() => { appSessions = []; });

describe("an engine state that changes nothing the app shows", () => {
  it("draws neither the shell, the open chat nor a chat kept loaded for its mini-app", async () => {
    chat("chat-1", ANA, "Ana");
    chat("chat-2", BIA, "Bia");
    fakeEngine.on("ensureLink", (params) => ({ linkId: params.peerPubKeyZ32 === ANA ? "link-1" : "link-2" }))
      .on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null })).on("updateSettings", () => undefined);
    fakeEngine.update({ links: links() });
    let draws = 0;
    const { user } = renderApp(
      <Profiler id="app" onRender={() => { draws++; }}>
        <Routes><Route path="/" element={<App />}><Route path="*" element={null} /></Route></Routes>
      </Profiler>,
      { route: "/chat/chat-1" },
    );
    await wait(300);
    // A mini-app runs in Ana's chat: it stays loaded behind Bia's.
    appSessions = ["chat-1"];
    await user.click(screen.getByTestId("to-bia"));
    await wait(300);
    expect(screen.getAllByTestId("chat-name").filter((name) => name.textContent?.includes("Ana"))).toHaveLength(1);

    draws = 0;
    for (let i = 0; i < 20; i++) act(() => fakeEngine.update({ links: links(), transfers: { [`t${i}`]: { bytes: i } } } as never));
    await wait(100);
    expect(draws).toBe(0);
  });
});
