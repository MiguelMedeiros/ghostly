import "fake-indexeddb/auto";
import { screen } from "@testing-library/react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupChat } from "../../pages/GroupChat";
import { saveSession } from "../../lib/storage";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: transport.native-pool, groups.native-links

/*
 * The chat or group on screen keeps this device's native connections (WISP 902 § Transports). A chat kept loaded off
 * screen (a mini-app running in it, a call) is on screen again when it comes back: after a group, or another chat, let
 * go of theirs, it must not stay unmarked, or its slot can go to another chat (ghostly#3332's review).
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));
vi.mock("../../components/Sidebar", () => ({
  Sidebar: () => {
    const navigate = useNavigate();
    return <nav>
      <button data-testid="to-ana" onClick={() => navigate("/chat/chat-1")}>Ana</button>
      <button data-testid="to-bia" onClick={() => navigate("/chat/chat-2")}>Bia</button>
      <button data-testid="to-group" onClick={() => navigate("/group/group-1")}>Friends</button>
      <button data-testid="to-settings" onClick={() => navigate("/settings")}>Settings</button>
    </nav>;
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

function open(route: string) {
  chat("chat-1", ANA, "Ana");
  chat("chat-2", BIA, "Bia");
  fakeEngine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }))
    .on("groupMessages", () => []).on("updateSettings", () => undefined);
  fakeEngine.update({
    links: [linkView({ id: "link-1", peerPubKeyZ32: ANA, profile: "paired-chat/1", pairing: { status: "ready" } } as never),
      linkView({ id: "link-2", peerPubKeyZ32: BIA, profile: "paired-chat/1", pairing: { status: "ready" } } as never)],
    groups: [groupView({ id: "group-1", status: "active", epoch: 1, members: [] })],
  });
  return renderApp(<Routes>
    <Route path="/" element={<App />}>
      <Route path="group/:groupId" element={<GroupChat />} />
      <Route path="*" element={null} />
    </Route>
  </Routes>, { route });
}

/** What the engine was last told is on screen. */
const onScreen = () => { const told = fakeEngine.callsTo("setActiveLink"); return told[told.length - 1]?.linkId; };

/** Ana's chat, as App draws it: there while hidden, on screen or not. */
const anaChat = () => screen.getAllByTestId("chat-name").filter(name => name.textContent?.includes("Ana"));

afterEach(() => { appSessions = []; });

describe("the chat or group on screen, as the engine knows it", () => {
  it("is a chat with a mini-app running again once it comes back from a group", async () => {
    const { user } = open("/chat/chat-1");
    await vi.waitFor(() => expect(onScreen()).toBe("link-1"));
    appSessions = ["chat-1"];
    await user.click(screen.getByTestId("to-group"));
    await vi.waitFor(() => expect(onScreen()).toBe("group:group-1"));
    expect(anaChat()).toHaveLength(1);
    await user.click(screen.getByTestId("to-ana"));
    await vi.waitFor(() => expect(onScreen()).toBe("link-1"));
  });

  it("is a chat with a mini-app running again once it comes back from another chat", async () => {
    const { user } = open("/chat/chat-1");
    await vi.waitFor(() => expect(onScreen()).toBe("link-1"));
    appSessions = ["chat-1"];
    await user.click(screen.getByTestId("to-bia"));
    await vi.waitFor(() => expect(onScreen()).toBe("link-2"));
    expect(anaChat()).toHaveLength(1);
    await user.click(screen.getByTestId("to-ana"));
    await vi.waitFor(() => expect(onScreen()).toBe("link-1"));
  });

  it("is nothing on a page that is neither, and a group while the group is on screen", async () => {
    const { user } = open("/group/group-1");
    await vi.waitFor(() => expect(onScreen()).toBe("group:group-1"));
    await user.click(screen.getByTestId("to-settings"));
    await vi.waitFor(() => expect(onScreen()).toBeNull());
  });
});
