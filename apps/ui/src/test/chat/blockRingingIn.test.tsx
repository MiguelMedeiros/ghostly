import "fake-indexeddb/auto";
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { loadSession, saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.block

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** The call's state, set by the test, and its Decline and hang-up, as the chat page gets them from the real hook. */
const hook = vi.hoisted(() => ({ callState: "idle", rejectCall: (() => {}) as () => void, hangUp: (() => {}) as (send?: boolean, line?: boolean) => void }));
vi.mock("../../hooks/useWebRTC", async () => {
  const real = await vi.importActual<typeof import("../../hooks/useWebRTC")>("../../hooks/useWebRTC");
  return {
    useWebRTC: (options: Parameters<typeof real.useWebRTC>[0]) => ({ ...real.useWebRTC(options), callState: hook.callState, rejectCall: hook.rejectCall, hangUp: hook.hangUp }),
  };
});

const KEY = "a".repeat(52);
const props = { sessionId: "a", onCallChange: () => {}, callLayer: null };

async function ringing(blocked = false) {
  saveSession({ id: "a", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: KEY, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
  const utils = renderApp(<UpdateProvider><Chat {...props} visible={false} /></UpdateProvider>);
  utils.engine.on("setContactBlocked", () => undefined);
  utils.engine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: KEY, label: "Ana", ...(blocked && { blocked: true as const }) })] });
  const card = screen.getByRole("alertdialog", { name: "Ana" });
  return { ...utils, card };
}

/**
 * Block contact on the ringing card: a contact who keeps calling can be blocked from the ring itself. It asks as the
 * chat's ⋮ does; blocked, the ring stops with nothing sent to the caller (no decline, no line), and the chat stays.
 */
describe("Block contact on a ringing call", () => {
  beforeEach(() => {
    localStorage.clear();
    hook.callState = "incoming";
    hook.rejectCall = vi.fn();
    hook.hangUp = vi.fn();
  });

  it("asks first, then blocks the caller and stops the ring silently; the chat stays", async () => {
    const { user, card, engine } = await ringing();
    const block = await within(card).findByRole("button", { name: "Block contact" });
    await user.click(block);
    const dialog = screen.getByRole("dialog", { name: /^Block .*Ana.*\?$/ });
    expect(hook.hangUp).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Block" }));
    expect(hook.hangUp).toHaveBeenCalledWith(false, false);
    expect(hook.rejectCall).not.toHaveBeenCalled();
    expect(engine.callsTo("setContactBlocked")).toEqual([{ peerPubKeyZ32: KEY, blocked: true }]);
    expect(loadSession("a")).not.toBeNull();
  });

  it("Cancel keeps the ring and blocks nothing", async () => {
    const { user, card, engine } = await ringing();
    await user.click(await within(card).findByRole("button", { name: "Block contact" }));
    await user.click(within(screen.getByRole("dialog", { name: /^Block / })).getByRole("button", { name: "Cancel" }));
    expect(hook.hangUp).not.toHaveBeenCalled();
    expect(engine.callsTo("setContactBlocked")).toEqual([]);
  });

  it("a contact blocked already has no Block on the card", async () => {
    const { card } = await ringing(true);
    expect(within(card).getByRole("button", { name: "Delete chat" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Block contact" })).toBeNull();
  });
});
