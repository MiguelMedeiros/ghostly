import "fake-indexeddb/auto";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCallSignal } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { Chat } from "../../pages/Chat";
import { takeHandedCall } from "../../lib/lockedRing";
import { saveSession } from "../../lib/storage";
import type { LockedCall } from "../../contexts/LockScreenContext";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: calls.lock-ring, calls.lock-ring-start, calls.end-and-answer

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** What the chat hands the lock screen while it rings, the answers it makes, and the ring's system notification. */
const seen = vi.hoisted(() => ({
  locked: null as LockedCall | null,
  accepted: [] as boolean[],
  otherCallOn: false,
  noticeTs: [] as (number | undefined)[],
}));
vi.mock("../../contexts/LockScreenContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../contexts/LockScreenContext")>()),
  useRingOnLockScreen: (call: LockedCall | null) => { seen.locked = call; },
}));
vi.mock("../../hooks/useIncomingCallNotice", () => ({
  useIncomingCallNotice: (on: boolean, _id: string, _text: string, ts?: number) => { if (on) seen.noticeTs.push(ts); },
}));
vi.mock("../../hooks/useWebRTC", async () => {
  const real = await vi.importActual<typeof import("../../hooks/useWebRTC")>("../../hooks/useWebRTC");
  return {
    useWebRTC: (options: Parameters<typeof real.useWebRTC>[0]) => {
      const webrtc = real.useWebRTC(options);
      return { ...webrtc, otherCallOn: seen.otherCallOn, acceptCall: async (video: boolean) => { seen.accepted.push(video); } };
    },
  };
});

let contact = 0;
let PEER = "";
let ID = "";

/** The contact's side of the call, as its signals reach this page through the engine. */
let ts = 0;
const send = (value: Record<string, unknown>) => {
  ts = Math.max(ts + 1, Date.now());
  const text = JSON.stringify({ ...value, ts });
  act(() => fakeEngine.emit({ kind: "call-signal", linkId: "link-1", signal: text }));
  return ts;
};
const audioOffer = () => send({ t: "o", u: "peer", p: "peerpeerpeerpeerpeerpeer", f: "cd".repeat(32), s: "actpass", m: ["a", "v"], c: [], ss: [1, 2], v: 0 });
const cameraOn = () => send({ t: "v", v: 1, k: "c" });

/**
 * A ringing call is what its offer says: an audio call rings as one and is answered as one by every answer that takes
 * the call "as it came". A picture-change signal the contact sends while it rings is not the offer, and does not turn
 * the answer into one with the camera.
 */
describe("a ringing call's kind", () => {
  beforeEach(() => {
    contact++;
    PEER = `kind${contact}`.padEnd(52, "k");
    ID = `chat-kind-${contact}`;
    saveSession({ id: ID, profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
    fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: PEER })] });
    Object.assign(seen, { locked: null, accepted: [], otherCallOn: false, noticeTs: [] });
  });
  afterEach(() => { takeHandedCall(ID, null); vi.restoreAllMocks(); });

  it("stays audio on the lock screen and its Answer, whatever picture the contact says it sends", async () => {
    renderApp(<Chat sessionId={ID} visible onCallChange={() => {}} callLayer={null} />);
    const offerTs = audioOffer();
    await act(async () => {});
    expect(seen.locked?.hasVideo).toBe(false);

    cameraOn();
    await act(async () => {});
    expect(seen.locked?.hasVideo).toBe(false);
    // The ring's system notification stays keyed to the call that rings.
    expect(seen.noticeTs[seen.noticeTs.length - 1]).toBe(offerTs);
    await act(async () => { seen.locked!.answer(); });
    expect(seen.accepted).toEqual([false]);
  });

  it("End and answer answers audio, as the card says", async () => {
    seen.otherCallOn = true;
    const { user } = renderApp(<Chat sessionId={ID} visible onCallChange={() => {}} callLayer={null} />);
    audioOffer();
    await act(async () => {});
    cameraOn();
    await act(async () => {});
    expect(screen.getByText("Incoming audio call...")).toBeInTheDocument();
    await user.click(screen.getByTestId("end-and-answer"));
    expect(seen.accepted).toEqual([false]);
  });

  it("before the first unlock, hands the offer that rang to the unlocked chat, answered as audio", async () => {
    const kept = vi.spyOn(engine, "keepCallOffer").mockImplementation(() => {});
    renderApp(<Chat sessionId={ID} visible={false} onCallChange={() => {}} callLayer={null} holdForUnlock />);
    const offerTs = audioOffer();
    await act(async () => {});
    cameraOn();
    await act(async () => {});
    act(() => { seen.locked!.answer(); });

    expect(kept).toHaveBeenCalledOnce();
    const handed = kept.mock.calls[0][1];
    expect(parseCallSignal(handed)).toMatchObject({ t: "o", ts: offerTs, v: 0 });
    expect(takeHandedCall(ID, handed)).toBe(false);
  });
});
