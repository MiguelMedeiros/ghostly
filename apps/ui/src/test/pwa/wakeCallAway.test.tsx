import "fake-indexeddb/auto";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: push.wake.call

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");

/**
 * Calling a contact whose app is closed waits up to a minute for it to wake. The wait lived in the chat, which `App`
 * keeps loaded only while it is on a call: leaving the chat meanwhile dropped it without a word, no call was ever
 * placed, and the contact's phone had already said "Incoming call". Now waking counts as a call on its way: the chat
 * stays loaded, and its notice, with Cancel, shows wherever the person is, as a call's own window does.
 */
describe("waking a contact for a call, then leaving the chat", () => {
  it("keeps the chat loaded, and shows the wait with its Cancel over what is on screen", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    const layer = document.createElement("div");
    document.body.append(layer);
    const onCallChange = vi.fn();
    const props = { sessionId: "chat-1", onCallChange, callLayer: layer };
    const { user, engine, rerender } = renderApp(<Chat {...props} visible />);
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => true);
    // Its app is closed: no live session, but it shared how to wake it.
    act(() => engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true } as never)] }));

    await user.click(await screen.findByTestId("call-audio"));
    expect(engine.callsTo("wakeForCall")).toEqual([{ linkId: "link-1" }]);
    expect(await screen.findByTestId("wake-call")).toHaveAttribute("data-state", "waking");
    // A call on its way: `App` keeps the chat loaded for it.
    expect(onCallChange).toHaveBeenLastCalledWith("chat-1", true);

    // The person opens another chat: this one's column is hidden, and the wait shows over what is there.
    rerender(<Chat {...props} visible={false} />);
    expect(onCallChange).toHaveBeenLastCalledWith("chat-1", true);
    const notice = within(layer).getByTestId("wake-call");
    expect(notice).toHaveAttribute("data-state", "waking");
    expect(notice).toHaveTextContent("Ana");
    await user.click(within(layer).getByTestId("wake-call-cancel"));
    expect(within(layer).queryByTestId("wake-call")).toBeNull();
    // Cancelled: nothing on its way any more, and the chat may go.
    expect(onCallChange).toHaveBeenLastCalledWith("chat-1", false);
    layer.remove();
  });
});
