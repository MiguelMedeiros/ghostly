import "fake-indexeddb/auto";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { startRinging } from "../../lib/sounds";
import { saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.audio

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** The chat's call as the page sees it: its `startCall`, and whether its offer is out (the test's own, once it says). */
const seen = vi.hoisted(() => ({
  startCall: null as ((video: boolean) => Promise<void>) | null,
  offerOut: undefined as boolean | undefined,
}));
vi.mock("../../hooks/useWebRTC", async () => {
  const real = await vi.importActual<typeof import("../../hooks/useWebRTC")>("../../hooks/useWebRTC");
  return {
    useWebRTC: (options: Parameters<typeof real.useWebRTC>[0]) => {
      const webrtc = real.useWebRTC(options);
      seen.startCall = webrtc.startCall;
      return seen.offerOut === undefined ? webrtc : { ...webrtc, ringingOut: seen.offerOut && webrtc.callState === "offering" };
    },
  };
});

let contact = 0;
let ID = "";
const ringbacks = () => vi.mocked(startRinging).mock.calls.filter(([sound]) => sound === "ringback").length;

/*
 * A call placed here plays its ringback ("waiting for a call to be answered") once its offer is out and the contact's
 * app can ring. Before, it played from the press: under the microphone (and on Android, camera) prompt, and while the
 * call's connection gathered, it said a call rang that had reached nobody, and a refused microphone then ended it.
 */
describe("the ringback of a call placed here", () => {
  beforeEach(() => {
    contact++;
    const peer = `back${contact}`.padEnd(52, "b");
    ID = `chat-ringback-${contact}`;
    saveSession({ id: ID, profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: peer, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: peer })] });
    vi.mocked(startRinging).mockClear();
    Object.assign(seen, { startCall: null, offerOut: undefined });
    // The microphone prompt, open: the browser (or Android's dialog) has not answered yet.
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn(() => new Promise<MediaStream>(() => {})),
      enumerateDevices: vi.fn(async () => []),
      addEventListener: () => {},
      removeEventListener: () => {},
    } });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    vi.restoreAllMocks();
  });

  it("is silent while the microphone prompt is open, and plays once the offer is out", async () => {
    const { rerender } = renderApp(<Chat sessionId={ID} visible onCallChange={() => {}} callLayer={null} />);
    act(() => { void seen.startCall!(false); });
    await act(async () => {});
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
    expect(ringbacks()).toBe(0);

    seen.offerOut = true;
    rerender(<Chat sessionId={ID} visible onCallChange={() => {}} callLayer={null} />);
    await act(async () => {});
    expect(ringbacks()).toBe(1);
  });
});
