import "fake-indexeddb/auto";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { servicesPlatform } from "../../lib/platform";
import { saveSession } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: push.wake.call

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

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

/**
 * With Ghostly offline (its own switch) no wake-up can go out: the engine refuses it at once. The call buttons said
 * nothing of it, and a press put up "Ana did not open Ghostly." as if the contact had been woken and stayed away.
 */
describe("calling a contact whose app is closed, with Ghostly offline", () => {
  it("leaves the call buttons off with the reason, and says nothing about the contact", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    const { user, engine } = renderApp(<Chat sessionId="chat-1" onCallChange={vi.fn()} callLayer={null} visible />);
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => false);
    act(() => engine.update({
      settings: { online: false },
      links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true } as never)],
    }));

    const call = await screen.findByTestId("call-audio");
    expect(call).toHaveAttribute("aria-disabled", "true");
    expect(call).toHaveAccessibleDescription("Calls need a live connection");
    await user.click(call);
    expect(engine.callsTo("wakeForCall")).toEqual([]);
    expect(screen.queryByTestId("wake-call")).toBeNull();
  });

  it("or with this app unable to call at all: the contact is not woken for a call that cannot start", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    const { user, engine } = renderApp(<Chat sessionId="chat-1" onCallChange={vi.fn()} callLayer={null} visible />);
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => true);
    // The Linux Desktop without GStreamer's plugins: the engine names what to install, live or not.
    const missing = "Calls need GStreamer's good plugins: install gst-plugins-good.";
    act(() => engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true, callsUnavailable: missing } as never)] }));

    const call = await screen.findByTestId("call-audio");
    expect(call).toHaveAttribute("aria-disabled", "true");
    expect(call).toHaveAccessibleDescription(missing);
    await user.click(call);
    expect(engine.callsTo("wakeForCall")).toEqual([]);
    expect(screen.queryByTestId("wake-call")).toBeNull();
    expect(await screen.findByTestId("call-blocked")).toHaveTextContent(missing);
  });

  it("or with Hide my IP on and call media that cannot keep to the relay: the buttons say calls are off, and nobody is woken", async () => {
    // The Linux Desktop's own call engine (desktop/nativeCalls.ts): it gathers this device's addresses.
    const native = { createPeerConnection: vi.fn(), getUserMedia: vi.fn() };
    const platform = servicesPlatform as { callMedia?: () => unknown };
    platform.callMedia = () => native;
    try {
      saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
      const { user, engine } = renderApp(<Chat sessionId="chat-1" onCallChange={vi.fn()} callLayer={null} visible />);
      engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => true);
      // Not live yet, as a chat whose transports are off with Hide my IP stays: the engine's reason is the live one.
      act(() => engine.update({
        settings: { relayOnly: true },
        links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true, callsUnavailable: "Calls need a live connection" } as never)],
      }));

      const call = await screen.findByTestId("call-audio");
      expect(call).toHaveAttribute("aria-disabled", "true");
      expect(call).toHaveAccessibleDescription("Calls are off while Hide my IP is on");
      await user.click(call);
      expect(engine.callsTo("wakeForCall")).toEqual([]);
      expect(screen.queryByTestId("wake-call")).toBeNull();
      expect(native.createPeerConnection).not.toHaveBeenCalled();
      expect(await screen.findByTestId("call-blocked")).toHaveTextContent("Calls are off while Hide my IP is on");
    } finally {
      delete platform.callMedia;
    }
  });

  it("or with the device offline: no minute's wait for a wake-up that cannot go", async () => {
    const offline = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
      const { user, engine } = renderApp(<Chat sessionId="chat-1" onCallChange={vi.fn()} callLayer={null} visible />);
      engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => true);
      act(() => engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true } as never)] }));

      const call = await screen.findByTestId("call-audio");
      expect(call).toHaveAttribute("aria-disabled", "true");
      await user.click(call);
      expect(engine.callsTo("wakeForCall")).toEqual([]);
      expect(screen.queryByTestId("wake-call")).toBeNull();
    } finally {
      offline.mockRestore();
    }
  });
});
