import "fake-indexeddb/auto";
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { DeleteChatDialog } from "../../components/DeleteChatDialog";
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

/**
 * Where the focus goes after the Block question. The ring stops with it (the card and the question go together), and
 * the chat stays: the focus goes back to where it was before the ring, as Decline's does, or to the chat's ⋮; never to
 * the chat list's New chat, which is Delete chat's place once the chat is gone (and is not on a phone's screen).
 */
describe("Block contact on a ringing call: the focus", () => {
  beforeEach(() => {
    localStorage.clear();
    hook.callState = "idle";
    hook.rejectCall = vi.fn(() => { hook.callState = "idle"; });
    hook.hangUp = vi.fn(() => { hook.callState = "idle"; });
  });

  /** The chat, with the chat list's New chat beside it and the focus in the message field; then the contact calls. */
  async function ringingWhileTyping() {
    saveSession({ id: "a", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: KEY, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    const tree = () => <UpdateProvider><button type="button" data-testid="sidebar-new-chat">New</button><Chat {...props} visible /></UpdateProvider>;
    const utils = renderApp(tree());
    utils.engine.on("setContactBlocked", () => undefined);
    utils.engine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: KEY, label: "Ana" })] });
    const field = await waitFor(() => { const textarea = document.querySelector("textarea"); expect(textarea).not.toBeNull(); return textarea!; });
    act(() => field.focus());
    expect(document.activeElement).toBe(field);
    hook.callState = "incoming";
    utils.rerender(tree());
    const card = await screen.findByRole("alertdialog", { name: "Ana" });
    return { ...utils, card, field };
  }

  it("Block goes back to where the focus was before the ring, not to New chat", async () => {
    const { user, card, field } = await ringingWhileTyping();
    await user.click(await within(card).findByRole("button", { name: "Block contact" }));
    await user.click(within(screen.getByRole("dialog", { name: /^Block / })).getByRole("button", { name: "Block" }));
    expect(hook.hangUp).toHaveBeenCalledWith(false, false);
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Ana" })).toBeNull());
    expect(document.activeElement).not.toBe(screen.getByTestId("sidebar-new-chat"));
    expect(document.activeElement).toBe(field);
  });

  it("Block goes to the chat's ⋮ when where the focus was before the ring is gone", async () => {
    const { user, card, field } = await ringingWhileTyping();
    // What had the focus before the ring went while it rang.
    field.remove();
    await user.click(await within(card).findByRole("button", { name: "Block contact" }));
    await user.click(within(screen.getByRole("dialog", { name: /^Block / })).getByRole("button", { name: "Block" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Ana" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId("chat-options"));
  });

  it("Escape or Cancel keeps the ring, and the focus goes back to the card's Block contact", async () => {
    const { user, card } = await ringingWhileTyping();
    const block = await within(card).findByRole("button", { name: "Block contact" });
    await user.click(block);
    // Escape on a modal <dialog> is its cancel event (happy-dom sends none for the key).
    act(() => { screen.getByRole("dialog", { name: /^Block / }).dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(screen.queryByRole("dialog", { name: /^Block / })).toBeNull();
    expect(document.activeElement).toBe(block);
    await user.click(block);
    await user.click(within(screen.getByRole("dialog", { name: /^Block / })).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("alertdialog", { name: "Ana" })).toBeInTheDocument();
    expect(document.activeElement).toBe(block);
    expect(hook.hangUp).not.toHaveBeenCalled();
  });

  it("⋮ → Block contact → Block goes back to ⋮", async () => {
    saveSession({ id: "a", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: KEY, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    const { user, engine } = renderApp(<UpdateProvider><button type="button" data-testid="sidebar-new-chat">New</button><Chat {...props} visible /></UpdateProvider>);
    engine.on("setContactBlocked", () => undefined);
    engine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: KEY, label: "Ana" })] });
    const options = await screen.findByTestId("chat-options");
    await user.click(options);
    await user.click(await screen.findByTestId("chat-block"));
    await user.click(within(screen.getByRole("dialog", { name: /^Block / })).getByRole("button", { name: "Block" }));
    expect(engine.callsTo("setContactBlocked")).toEqual([{ peerPubKeyZ32: KEY, blocked: true }]);
    expect(document.activeElement).toBe(options);
  });

  it("Delete chat still goes to New chat once what asked is gone with the chat", async () => {
    // As the chat list's Delete chat: the row that asked goes with the chat, in the same commit as the question.
    function Row() {
      const [asking, setAsking] = useState(false), [gone, setGone] = useState(false);
      return <>
        <button type="button" data-testid="sidebar-new-chat">New</button>
        {!gone && <button type="button" onClick={() => setAsking(true)}>Ana</button>}
        {asking && <DeleteChatDialog name="Ana" onClose={() => setAsking(false)} onConfirm={() => { setAsking(false); setGone(true); }} />}
      </>;
    }
    const { user } = renderApp(<Row />);
    await user.click(screen.getByRole("button", { name: "Ana" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete chat" }));
    expect(screen.queryByRole("button", { name: "Ana" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("sidebar-new-chat"));
  });
});
