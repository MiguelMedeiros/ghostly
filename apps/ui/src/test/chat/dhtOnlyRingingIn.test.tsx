import "fake-indexeddb/auto";
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: transport.chat-switch, calls.decline

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** The call's state, set by the test, and its Decline, as the chat page gets them from the real hook. */
const hook = vi.hoisted(() => ({ callState: "idle", rejectCall: (() => {}) as () => void }));
vi.mock("../../hooks/useWebRTC", async () => {
  const real = await vi.importActual<typeof import("../../hooks/useWebRTC")>("../../hooks/useWebRTC");
  return {
    useWebRTC: (options: Parameters<typeof real.useWebRTC>[0]) => ({ ...real.useWebRTC(options), callState: hook.callState, rejectCall: hook.rejectCall }),
  };
});

const PEER = "peer".padEnd(52, "p");
const reason = "Hang up the call to use DHT only";

async function openPanel() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  act(() => utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open", transportAutomatic: false,
    preferredTransport: "webrtc/1", availableTransports: ["webrtc/1", "iroh/1", "hyperdht/1"],
    pairing: { status: "ready", transport: "webrtc/1" } } as never)] }));
  await utils.user.click(await screen.findByTestId("connection-options"));
  return { ...utils, dht: screen.getByTestId("connection-option-dht") };
}

/**
 * A contact's call that only rings in kept DHT only off ("Hang up the call"), and a contact who called again as soon as
 * one was declined kept the chat on its direct link for as long as they wanted. DHT only declines that call, while the
 * live link is there for the decline to cross, then goes through; a call that is on still keeps it off.
 */
describe("DHT only while a contact's call rings in", () => {
  beforeEach(() => {
    localStorage.clear();
    hook.rejectCall = vi.fn();
  });

  it("is on, declines the call, then puts the chat on DHT only", async () => {
    hook.callState = "incoming";
    const { user, engine, dht } = await openPanel();
    expect(dht).toBeEnabled();
    expect(dht).not.toHaveAccessibleDescription(reason);
    await user.click(dht);
    expect(hook.rejectCall).toHaveBeenCalledTimes(1);
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "dht" }]);
  });

  it("is still off for a call that is on, and declines nothing", async () => {
    hook.callState = "connected";
    const { user, engine, dht } = await openPanel();
    expect(dht).toBeDisabled();
    expect(dht).toHaveAccessibleDescription(reason);
    await user.click(dht);
    expect(hook.rejectCall).not.toHaveBeenCalled();
    expect(engine.callsTo("setChatTransport")).toEqual([]);
  });
});
