import "fake-indexeddb/auto";
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.block

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** The call's state, set by the test, and its hang-up, as the chat page gets them from the real hook. */
const hook = vi.hoisted(() => ({ callState: "idle", hangUp: (() => {}) as (send?: boolean, line?: boolean) => void }));
vi.mock("../../hooks/useWebRTC", async () => {
  const real = await vi.importActual<typeof import("../../hooks/useWebRTC")>("../../hooks/useWebRTC");
  return { useWebRTC: (options: Parameters<typeof real.useWebRTC>[0]) => ({ ...real.useWebRTC(options), callState: hook.callState, hangUp: hook.hangUp }) };
});

const KEY = "a".repeat(52);

/**
 * Blocked during a call with the contact: the block drops every call signal of theirs (their hang-up too), so the
 * call ends here, as a hang-up does, for a call that is on and for one of mine that rings on their side.
 */
describe("Block contact during a call", () => {
  beforeEach(() => { localStorage.clear(); hook.hangUp = vi.fn(); });

  // One ringing in stops with nothing sent: the caller's ring runs out, as it does when the app is closed.
  it.each([["connected", true], ["offering", true], ["incoming", false]] as const)("a call %s ends when the contact is blocked (signal sent: %s)", async (state, send) => {
    hook.callState = state;
    saveSession({ id: "a", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: KEY, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    const { user, engine } = renderApp(<UpdateProvider><Chat sessionId="a" visible onCallChange={() => {}} callLayer={null} /></UpdateProvider>);
    engine.on("ensureLink", () => ({ linkId: "link-a" })).on("setActiveLink", () => undefined).on("setContactBlocked", () => undefined);
    engine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: KEY, label: "Ana" })] });
    await user.click(screen.getByTestId("chat-options"));
    await user.click(within(await screen.findByTestId("chat-options-menu")).getByTestId("chat-block"));
    await user.click(within(screen.getByRole("dialog", { name: /^Block .*Ana.*\?$/ })).getByRole("button", { name: "Block" }));
    expect(hook.hangUp).toHaveBeenCalledTimes(1);
    expect(hook.hangUp).toHaveBeenCalledWith(send, send);
    expect(engine.callsTo("setContactBlocked")).toEqual([{ peerPubKeyZ32: KEY, blocked: true }]);
  });
});
