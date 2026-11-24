import "fake-indexeddb/auto";
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { listSessions, loadSession, saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { Settings } from "../../pages/Settings";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: chats.list.delete, chats.list.delete-all, calls.decline

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** The call's state, set by the test, and its Decline, as the chat page gets them from the real hook. */
const hook = vi.hoisted(() => ({ callState: "idle", rejectCall: (() => {}) as () => void }));
vi.mock("../../hooks/useWebRTC", async () => {
  const real = await vi.importActual<typeof import("../../hooks/useWebRTC")>("../../hooks/useWebRTC");
  return {
    useWebRTC: (options: Parameters<typeof real.useWebRTC>[0]) => ({ ...real.useWebRTC(options), callState: hook.callState, rejectCall: hook.rejectCall }),
  };
});

const props = { sessionId: "a", onCallChange: () => {}, callLayer: null };
const chat = (id: string, label: string) =>
  saveSession({ id, profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: id.repeat(52), encKeyB64: "a2V5", label, messages: [], createdAt: 1_700_000_000_000 });
const rowOf = (name: string) => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === name)!;

/**
 * A contact's call that only rings in held the chat: Delete chat and Delete all chats were off until it stopped. A
 * contact who called again as soon as it did (a newer offer takes the ring's place; nothing holds one back after
 * Decline) kept it ringing for as long as they wanted, and the chat could never be deleted. The call is declined, and
 * the chat goes; a call that is on still holds it.
 */
describe("deleting a chat whose contact's call rings in", () => {
  beforeEach(() => {
    localStorage.clear();
    chat("a", "Ana");
    chat("b", "Bo");
    hook.callState = "incoming";
    hook.rejectCall = vi.fn();
  });

  it("from the chat list: declines the call, then deletes the chat", async () => {
    const { user } = renderApp(<UpdateProvider><Chat {...props} visible={false} /><Sidebar /></UpdateProvider>);
    await user.click(within(rowOf("Ana")).getByRole("button", { name: "Delete chat" }));
    const dialog = screen.getByRole("dialog", { name: "Delete chat?" });
    expect(dialog).toHaveAccessibleDescription(/^This deletes the chat and its history from this device/);
    await user.click(within(dialog).getByRole("button", { name: "Delete chat" }));
    expect(hook.rejectCall).toHaveBeenCalledTimes(1);
    expect(loadSession("a")).toBeNull();
    expect(loadSession("b")).not.toBeNull();
  });

  it("from Settings > Delete all chats: declines the call, then deletes them all", async () => {
    windowIs(false);
    const { user } = renderApp(
      <LockScreenProvider><UpdateProvider><Chat {...props} visible={false} /><Settings /></UpdateProvider></LockScreenProvider>,
      { route: "/settings/storage" });
    const remove = await screen.findByTestId("delete-all-chats");
    await vi.waitFor(() => expect(remove).toBeEnabled());
    await user.click(remove);
    const confirm = screen.getByTestId("delete-all-chats-confirm");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(hook.rejectCall).toHaveBeenCalledTimes(1);
    expect(listSessions()).toHaveLength(0);
  });

  it("a call that is on still holds the chat, and is not hung up", async () => {
    hook.callState = "connected";
    const { user } = renderApp(<UpdateProvider><Chat {...props} visible={false} /><Sidebar /></UpdateProvider>);
    await user.click(within(rowOf("Ana")).getByRole("button", { name: "Delete chat" }));
    const dialog = screen.getByRole("dialog", { name: "Delete chat?" });
    expect(dialog).toHaveAccessibleDescription("A call is on in this chat. End it first, then delete the chat.");
    await user.click(within(dialog).getByRole("button", { name: "Delete chat" }));
    expect(hook.rejectCall).not.toHaveBeenCalled();
    expect(loadSession("a")).not.toBeNull();
  });
});
