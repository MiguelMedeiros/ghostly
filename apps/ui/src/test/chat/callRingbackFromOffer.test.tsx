import "fake-indexeddb/auto";
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { startRinging } from "../../lib/sounds";
import { saveSession } from "../../lib/storage";
import { renderApp } from "../render";

// covers: calls.audio, calls.media-blocked

const stopRingback = vi.hoisted(() => vi.fn());
vi.mock("../../lib/sounds", () => ({
  playSound: vi.fn(() => () => {}),
  startRinging: vi.fn((kind: string) => (kind === "ringback" ? stopRingback : () => {})),
  installAudioGestures: () => () => {},
  warmSound: () => {},
}));

/** The call's state and whether its offer went out, set by the test: the call itself is not what is tested here. */
const hook = vi.hoisted(() => ({ callState: "idle", offerSent: false }));
vi.mock("../../hooks/useWebRTC", async () => {
  const real = await vi.importActual<typeof import("../../hooks/useWebRTC")>("../../hooks/useWebRTC");
  return {
    useWebRTC: (options: Parameters<typeof real.useWebRTC>[0]) => ({ ...real.useWebRTC(options), callState: hook.callState, offerSent: hook.offerSent }),
  };
});

const PEER = "peer".padEnd(52, "p");
const props = { sessionId: "chat-ringback", onCallChange: () => {}, callLayer: null };
const save = () => saveSession({ id: "chat-ringback", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
const ringbacks = () => vi.mocked(startRinging).mock.calls.filter(([kind]) => kind === "ringback").length;

/**
 * The caller's ringback says the contact's device rings. It played from `offering`, which starts before the microphone
 * or camera prompt and before the offer goes out: a prompt left open rang back for a call that rang nowhere.
 */
describe("the caller's ringback", () => {
  beforeEach(() => {
    localStorage.clear();
    save();
    Object.assign(hook, { callState: "idle", offerSent: false });
    vi.mocked(startRinging).mockClear();
    stopRingback.mockClear();
  });

  it("does not play while the microphone prompt is open, and starts once the offer is out", async () => {
    hook.callState = "offering";
    const view = renderApp(<Chat {...props} visible />);
    await act(async () => {});
    expect(ringbacks()).toBe(0);

    // Still asking a while later: still nothing rings the contact.
    view.rerender(<Chat {...props} visible />);
    await act(async () => {});
    expect(ringbacks()).toBe(0);

    hook.offerSent = true;
    view.rerender(<Chat {...props} visible />);
    await act(async () => {});
    expect(ringbacks()).toBe(1);
    expect(stopRingback).not.toHaveBeenCalled();

    // Stops as it always has, when the call leaves `offering`.
    Object.assign(hook, { callState: "connecting", offerSent: false });
    view.rerender(<Chat {...props} visible />);
    await act(async () => {});
    expect(stopRingback).toHaveBeenCalledOnce();
    expect(ringbacks()).toBe(1);
  });

  it("never plays for a call hung up while the prompt was open", async () => {
    hook.callState = "offering";
    const view = renderApp(<Chat {...props} visible />);
    await act(async () => {});
    hook.callState = "idle";
    view.rerender(<Chat {...props} visible />);
    await act(async () => {});
    expect(ringbacks()).toBe(0);
  });
});
