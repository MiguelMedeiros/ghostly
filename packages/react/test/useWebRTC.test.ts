import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";
import { MEDIA_PROBLEM_SHOWN_MS, NO_ANSWER_SHOWN_MS, RESTART_GRACE_MS, RING_MS, mediaProblem } from "../src/useWebRTC";

// covers: calls.audio, calls.video, calls.cancel, calls.decline, calls.end-and-answer, calls.media-blocked, calls.screen-share, calls.upgrade

let devices: FakeMediaDevices;
let uninstall: () => void;

beforeEach(() => {
  // The hang-up clears the record 5 s later and ICE gathering has a 10 s cap: neither is waited for for real.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

const denied = () => new DOMException("Permission denied", "NotAllowedError");

/** The call lines the chat was given, in order. */
const lines = (call: ReturnType<typeof renderCall>) => call.addCallEventMessage.mock.calls.map(([type]) => type);

/** Places an audio call and gets it to the offer, with the microphone granted. */
async function offered(call: ReturnType<typeof renderCall>) {
  act(() => { void call.result.current.startCall(false); });
  const stream = devices.userMedia[0].grant();
  await settle();
  return { stream, pc: FakePeerConnection.instances[0] };
}

describe("placing a call", () => {
  it("publishes an offer once the microphone is granted, with a video section an audio call can grow into", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });

    expect(call.result.current.callState).toBe("offering");
    expect(call.fastPoll()).toBe(true);
    expect(call.addCallEventMessage).toHaveBeenCalledWith("call_started", false);
    expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(call.published).toEqual([]);

    const stream = devices.userMedia[0].grant();
    await settle();

    const pc = FakePeerConnection.instances[0];
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(pc.getTransceivers().map((t) => t.receiver.track.kind)).toEqual(["audio", "video"]);
    expect(call.result.current.localStream).toBe(stream);
    expect(call.publishedKinds()).toEqual(["o"]);
    // No trickle ICE: the candidates travel inside the offer, so none can arrive before a description.
    const offer = JSON.parse(call.published[0]!);
    expect(offer).toMatchObject({ t: "o", u: "fake", s: "actpass", v: 0, m: ["a", "v"] });
    expect(offer.c).toHaveLength(2);
  });

  it("applies the peer's answer and connects when ICE does", async () => {
    const call = renderCall();
    const { pc } = await offered(call);

    call.receive(remote.answer(Date.now() + 1));
    await settle();
    expect(pc.remoteDescription?.type).toBe("answer");
    expect(call.result.current.callState).toBe("connecting");

    act(() => pc.setIceState("connected"));
    expect(call.result.current.callState).toBe("connected");
    expect(call.result.current.canSendVideo).toBe(true);
    expect(call.addCallEventMessage).toHaveBeenCalledWith("call_connected", false);
    expect(call.fastPoll()).toBe(false);
  });

  it("ICE connecting before the answer's description comes back stays connected, with its video lane open", async () => {
    const call = renderCall();
    const { pc } = await offered(call);
    // Two apps on one Mac, in WebKit: ICE is up before the promise returns, and the lane's direction is not settled yet.
    const apply = pc.setRemoteDescription.bind(pc);
    vi.spyOn(pc, "setRemoteDescription").mockImplementation(async (description) => {
      pc.setIceState("connected");
      await apply(description);
    });

    call.receive(remote.answer(Date.now() + 1));
    await settle();

    expect(call.result.current.callState).toBe("connected");
    expect(call.result.current.canSendVideo).toBe(true);
    expect(call.result.current.canShareScreen).toBe(true);
    expect(call.addCallEventMessage.mock.calls.filter(([type]) => type === "call_connected")).toHaveLength(1);
  });

  it("a hang-up while the answer's description is being applied leaves the call ended", async () => {
    const call = renderCall();
    const { pc } = await offered(call);
    const applied = deferred<void>();
    vi.spyOn(pc, "setRemoteDescription").mockReturnValue(applied.promise);
    call.receive(remote.answer(Date.now() + 1));

    act(() => call.result.current.hangUp());
    applied.resolve();
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(call.onError).not.toHaveBeenCalled();
  });

  it("a description refused after the hang-up closed the connection is not reported as an error", async () => {
    const call = renderCall();
    const { pc } = await offered(call);
    const applied = deferred<void>();
    vi.spyOn(pc, "setRemoteDescription").mockReturnValue(applied.promise);
    call.receive(remote.answer(Date.now() + 1));

    act(() => call.result.current.hangUp());
    applied.reject(new DOMException("The RTCPeerConnection is closed", "InvalidStateError"));
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(call.onError).not.toHaveBeenCalled();
  });

  it("hanging up closes the connection, stops the tracks, publishes a hang-up and clears it 5 s later", async () => {
    const call = renderCall();
    const { stream, pc } = await offered(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => pc.setIceState("connected"));
    act(() => { vi.advanceTimersByTime(3000); });

    act(() => call.result.current.hangUp());

    expect(pc.close).toHaveBeenCalledOnce();
    expect(stream.getTracks().every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.localStream).toBeNull();
    expect(call.publishedKinds()).toEqual(["o", "h"]);
    expect(call.addCallEventMessage).toHaveBeenCalledWith("call_ended", false, 3000);

    act(() => { vi.advanceTimersByTime(5000); });
    expect(call.publishedKinds()).toEqual(["o", "h", null]);
  });

  it("a call nobody answers hangs up after RING_MS and says \"No answer\" for a while", async () => {
    const call = renderCall();
    const { stream, pc } = await offered(call);

    act(() => { vi.advanceTimersByTime(RING_MS - 1); });
    expect(call.result.current.callState).toBe("offering");
    expect(call.result.current.noAnswer).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.noAnswer).toBe(true);
    expect(call.publishedKinds()).toEqual(["o", "h"]);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(stream.getTracks().every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    expect(call.addCallEventMessage).not.toHaveBeenCalledWith("call_ended", expect.anything(), expect.anything());
    // The caller's chat keeps a line for it, as the side it rang keeps "Missed call".
    expect(call.addCallEventMessage).toHaveBeenLastCalledWith("call_unanswered", false);

    act(() => { vi.advanceTimersByTime(NO_ANSWER_SHOWN_MS); });
    expect(call.result.current.noAnswer).toBe(false);
  });

  it("a call cancelled while it rings keeps a cancelled line, with no length", async () => {
    const call = renderCall();
    await offered(call);
    act(() => { vi.advanceTimersByTime(3000); });

    act(() => call.result.current.hangUp());

    expect(call.publishedKinds()).toEqual(["o", "h"]);
    expect(lines(call)).toEqual(["call_started", "call_cancelled"]);
    expect(call.addCallEventMessage).toHaveBeenLastCalledWith("call_cancelled", false);
  });

  it("the contact declining our ringing call ends it here with a declined line", async () => {
    const call = renderCall();
    const { pc } = await offered(call);

    call.receive(remote.hangUp(Date.now() + 1));

    expect(call.result.current.callState).toBe("idle");
    expect(pc.close).toHaveBeenCalledOnce();
    expect(devices.liveTracks()).toEqual([]);
    // Nothing more to say: their hang-up is the last word.
    expect(call.publishedKinds()).toEqual(["o", null]);
    expect(lines(call)).toEqual(["call_started", "call_rejected"]);
  });

  it("an answered call hung up while it still connects keeps an end line, with no length", async () => {
    const call = renderCall();
    await offered(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    expect(call.result.current.callState).toBe("connecting");

    call.receive(remote.hangUp(Date.now() + 2));

    expect(call.result.current.callState).toBe("idle");
    expect(lines(call)).toEqual(["call_started", "call_ended"]);
  });

  it("an answered call does not ring out", async () => {
    const call = renderCall();
    const { pc } = await offered(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => pc.setIceState("connected"));

    act(() => { vi.advanceTimersByTime(RING_MS * 2); });

    expect(call.result.current.callState).toBe("connected");
    expect(call.result.current.noAnswer).toBe(false);
    expect(call.publishedKinds()).toEqual(["o"]);
  });

  it("the peer hanging up a connected call ends it here without a hang-up of our own", async () => {
    const call = renderCall();
    const { pc } = await offered(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => pc.setIceState("connected"));

    call.receive(remote.hangUp(Date.now() + 2));

    expect(call.result.current.callState).toBe("idle");
    expect(pc.close).toHaveBeenCalledOnce();
    expect(devices.liveTracks()).toEqual([]);
    expect(call.publishedKinds()).toEqual(["o", null]);
  });

  it("a connected call whose contact went away (a closed tab, a reload) ends with its line, as a hang-up does", async () => {
    const call = renderCall();
    const { stream, pc } = await offered(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => pc.setIceState("connected"));
    act(() => { vi.advanceTimersByTime(4000); });

    act(() => pc.setIceState("failed"));

    expect(call.result.current.callState).toBe("idle");
    expect(stream.getTracks().every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    expect(call.addCallEventMessage).toHaveBeenCalledWith("call_ended", false, 4000);

    // The next call is a call of its own: connected again, ended once more.
    act(() => { void call.result.current.startCall(false); });
    devices.userMedia[1].grant();
    await settle();
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => FakePeerConnection.instances[1].setIceState("connected"));
    act(() => call.result.current.hangUp());
    expect(call.addCallEventMessage.mock.calls.map(([type]) => type).filter((t) => t === "call_connected" || t === "call_ended")).toEqual(["call_connected", "call_ended", "call_connected", "call_ended"]);
  });

  it.each(["ghostly-departing", "pagehide"])("the app closing mid-call (%s) hangs up, with the call's end line", async (event) => {
    const call = renderCall();
    const { stream, pc } = await offered(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => pc.setIceState("connected"));
    act(() => { vi.advanceTimersByTime(2000); });

    act(() => { window.dispatchEvent(new Event(event)); });

    expect(call.result.current.callState).toBe("idle");
    expect(call.publishedKinds()).toEqual(["o", "h"]);
    expect(stream.getTracks().every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    expect(call.addCallEventMessage).toHaveBeenCalledWith("call_ended", false, 2000);
  });

  it("the app closing while our call rings cancels it, as a hang-up does", async () => {
    const call = renderCall();
    await offered(call);
    act(() => { window.dispatchEvent(new Event("ghostly-departing")); });
    expect(call.result.current.callState).toBe("idle");
    expect(call.publishedKinds()).toEqual(["o", "h"]);
    expect(lines(call)).toEqual(["call_started", "call_cancelled"]);
  });

  it("a call that never connected and fails ends with no line", async () => {
    const call = renderCall();
    const { pc } = await offered(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => pc.setIceState("failed"));
    expect(call.result.current.callState).toBe("idle");
    expect(call.addCallEventMessage).not.toHaveBeenCalledWith("call_ended", expect.anything(), expect.anything());
  });
});

describe("both calling at once", () => {
  /** Their offer, with `patch` over the usual one (an earlier or later timestamp, another fingerprint). */
  const theirOffer = (ts: number, f?: string) => JSON.stringify({ ...JSON.parse(remote.offer(ts)), ...(f ? { f } : {}) });
  const ours = (call: ReturnType<typeof renderCall>) => JSON.parse(call.published.find((s) => s && JSON.parse(s).t === "o")!) as { ts: number; f: string };

  it("an earlier offer from the contact wins: ours is dropped without a hang-up, and theirs rings", async () => {
    const call = renderCall();
    const { stream, pc } = await offered(call);
    const mine = ours(call);

    call.receive(theirOffer(mine.ts - 1));

    expect(call.result.current.callState).toBe("incoming");
    expect(pc.close).toHaveBeenCalledOnce();
    expect(stream.getTracks().every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    expect(call.addCallEventMessage).toHaveBeenCalledWith("call_received", false, undefined, expect.any(Number));
    // A hang-up would end the winner's call on the other side.
    expect(call.publishedKinds()).toEqual(["o"]);
    // Our attempt's "call started" goes: the chat keeps the winning call's lines only, as the contact's does.
    const started = call.addCallEventMessage.mock.results[call.addCallEventMessage.mock.calls.findIndex(([type]) => type === "call_started")].value;
    expect(call.removeCallEventMessage).toHaveBeenCalledExactlyOnceWith(started);

    act(() => { void call.result.current.acceptCall(false); });
    devices.userMedia[1].grant();
    await settle();
    expect(call.publishedKinds()).toEqual(["o", "a"]);
    expect(call.result.current.callState).toBe("connecting");
  });

  it("their offer while ours still waits for the microphone wins: our attempt leaves no line and no offer", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });

    call.receive(theirOffer(Date.now()));
    devices.userMedia[0].grant();
    await settle();

    expect(call.result.current.callState).toBe("incoming");
    expect(call.publishedKinds()).toEqual([]);
    expect(call.removeCallEventMessage).toHaveBeenCalledExactlyOnceWith(call.addCallEventMessage.mock.results[0].value);
  });

  it("a later offer from the contact loses: ours keeps ringing them", async () => {
    const call = renderCall();
    const { pc } = await offered(call);
    const mine = ours(call);

    call.receive(theirOffer(mine.ts + 1));

    expect(call.result.current.callState).toBe("offering");
    expect(pc.close).not.toHaveBeenCalled();
    expect(call.addCallEventMessage.mock.calls.filter(([type]) => type === "call_received")).toEqual([]);
    expect(call.removeCallEventMessage).not.toHaveBeenCalled();
    // Their answer to ours still connects the call.
    call.receive(remote.answer(mine.ts + 2));
    await settle();
    expect(call.result.current.callState).toBe("connecting");
  });

  it("at the same millisecond the lower fingerprint wins: ours when it is lower", async () => {
    const call = renderCall();
    await offered(call);
    const mine = ours(call);
    call.receive(theirOffer(mine.ts, "ff".repeat(32)));
    expect(call.result.current.callState).toBe("offering");
  });

  it("at the same millisecond the lower fingerprint wins: theirs when it is lower", async () => {
    const call = renderCall();
    await offered(call);
    const mine = ours(call);
    call.receive(theirOffer(mine.ts, "00".repeat(32)));
    expect(call.result.current.callState).toBe("incoming");
  });

  it("an offer arriving while ours is still gathering wins: ours is never sent", async () => {
    FakePeerConnection.holdGathering = true;
    const call = renderCall();
    const { pc } = await offered(call);

    call.receive(theirOffer(Date.now()));
    expect(call.result.current.callState).toBe("incoming");

    act(() => pc.finishGathering());
    await settle();
    expect(call.published).toEqual([]);
    expect(call.result.current.callState).toBe("incoming");
  });
});

describe("answering a call", () => {
  it("rings for an incoming offer and answers with our half of the video lane open", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    expect(call.result.current.callState).toBe("incoming");
    expect(call.addCallEventMessage).toHaveBeenCalledWith("call_received", false, undefined, expect.any(Number));

    act(() => { void call.result.current.acceptCall(false); });
    expect(call.result.current.callState).toBe("answering");
    devices.userMedia[0].grant();
    await settle();

    const pc = FakePeerConnection.instances[0];
    expect(pc.remoteDescription?.type).toBe("offer");
    expect(pc.getTransceivers().find((t) => t.receiver.track.kind === "video")?.direction).toBe("sendrecv");
    expect(call.publishedKinds()).toEqual(["a"]);
    expect(call.result.current.callState).toBe("connecting");
  });

  it("ICE connecting while our answer is still gathering stays connected once the answer goes out", async () => {
    FakePeerConnection.holdGathering = true;
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { void call.result.current.acceptCall(false); });
    devices.userMedia[0].grant();
    await settle();
    const pc = FakePeerConnection.instances[0];

    act(() => pc.setIceState("connected"));
    act(() => pc.finishGathering());
    await settle();

    expect(call.publishedKinds()).toEqual(["a"]);
    expect(call.result.current.callState).toBe("connected");
  });

  it("the app closing while a call rings here sends nothing: the caller's ring runs out", () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { window.dispatchEvent(new Event("ghostly-departing")); });
    expect(call.result.current.callState).toBe("incoming");
    expect(call.publishedKinds()).toEqual([]);
  });

  it("declining publishes a hang-up and never asks for the microphone", () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));

    act(() => call.result.current.rejectCall());

    expect(call.addCallEventMessage).toHaveBeenCalledWith("call_rejected", false);
    expect(call.addCallEventMessage).not.toHaveBeenCalledWith("call_ended", expect.anything(), expect.anything());
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(FakePeerConnection.instances).toEqual([]);
    expect(call.result.current.callState).toBe("idle");
    expect(call.publishedKinds()).toEqual(["h"]);
    expect(call.fastPoll()).toBe(false);
  });

  it("stops ringing when the caller gives up before we answer", () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));

    call.receive(remote.hangUp(Date.now() + 1));

    expect(call.result.current.callState).toBe("idle");
    expect(call.publishedKinds()).toEqual([null]);
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    // It never connected, so there is no "call ended" line in the chat: a missed call instead.
    expect(call.addCallEventMessage).not.toHaveBeenCalledWith("call_ended", expect.anything(), expect.anything());
    expect(call.addCallEventMessage).toHaveBeenLastCalledWith("call_missed", false, undefined, expect.any(Number));
  });

  it("an offer heard again after the app reopened rings with the same call: its lines are the same lines", () => {
    const ts = Date.now();
    const first = renderCall();
    first.receive(remote.offer(ts));
    first.unmount();
    // The app reopened while it rang: the contact's record still holds the offer.
    const again = renderCall();
    again.receive(remote.offer(ts));
    act(() => { vi.advanceTimersByTime(RING_MS); });

    const received = [...first.addCallEventMessage.mock.calls, ...again.addCallEventMessage.mock.calls].filter(([type]) => type === "call_received");
    expect(received).toEqual([["call_received", false, undefined, ts], ["call_received", false, undefined, ts]]);
    expect(again.addCallEventMessage).toHaveBeenLastCalledWith("call_missed", false, undefined, ts);
  });

  it("stops ringing on its own after RING_MS, with a missed call and nothing sent", () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    expect(call.result.current.callState).toBe("incoming");

    act(() => { vi.advanceTimersByTime(RING_MS - 1); });
    expect(call.result.current.callState).toBe("incoming");
    act(() => { vi.advanceTimersByTime(1); });

    expect(call.result.current.callState).toBe("idle");
    expect(call.addCallEventMessage).toHaveBeenLastCalledWith("call_missed", false, undefined, expect.any(Number));
    expect(call.publishedKinds()).not.toContain("h");
    expect(call.fastPoll()).toBe(false);
    // The caller's hang-up, arriving later, adds no second line.
    call.receive(remote.hangUp(Date.now()));
    expect(call.addCallEventMessage.mock.calls.filter(([type]) => type === "call_missed")).toHaveLength(1);
  });

  it("an answered call is not missed when RING_MS passes", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { void call.result.current.acceptCall(false); });
    devices.userMedia[0].grant();
    await settle();
    expect(call.result.current.callState).toBe("connecting");
    act(() => FakePeerConnection.instances[0].setIceState("connected"));

    act(() => { vi.advanceTimersByTime(RING_MS); });

    expect(call.result.current.callState).toBe("connected");
    expect(call.addCallEventMessage.mock.calls.filter(([type]) => type === "call_missed")).toEqual([]);
  });

  it("an accept clicked twice asks for the microphone once", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));

    act(() => {
      void call.result.current.acceptCall(false);
      void call.result.current.acceptCall(false);
    });
    devices.userMedia[0].grant();
    await settle();

    expect(devices.getUserMedia).toHaveBeenCalledOnce();
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(call.publishedKinds()).toEqual(["a"]);
  });
});

/** Answers an incoming audio call and gets it to "connecting", with the microphone granted. */
async function answered(call: ReturnType<typeof renderCall>) {
  call.receive(remote.offer(Date.now()));
  act(() => { void call.result.current.acceptCall(false); });
  const stream = devices.userMedia[devices.userMedia.length - 1].grant();
  await settle();
  return { stream, pc: FakePeerConnection.instances[FakePeerConnection.instances.length - 1] };
}

describe("a headless caller starting over on a second offer", () => {
  it("a newer offer while our answer connects is answered on a new connection with the same microphone", async () => {
    const call = renderCall();
    const { stream, pc: first } = await answered(call);
    expect(call.result.current.callState).toBe("connecting");

    call.receive(remote.offer(Date.now() + 1));
    await settle();

    expect(first.close).toHaveBeenCalledOnce();
    expect(FakePeerConnection.instances).toHaveLength(2);
    const second = FakePeerConnection.instances[1];
    expect(second.remoteDescription?.type).toBe("offer");
    expect(second.getTransceivers().find((t) => t.receiver.track.kind === "audio")?.sender.track).toBe(stream.getAudioTracks()[0]);
    expect(devices.getUserMedia).toHaveBeenCalledOnce();
    expect(call.publishedKinds()).toEqual(["a", "a"]);
    expect(call.result.current.callState).toBe("connecting");

    act(() => second.setIceState("connected"));
    expect(call.result.current.callState).toBe("connected");
    // The connection it replaced has nothing more to say.
    act(() => first.setIceState("failed"));
    expect(call.result.current.callState).toBe("connected");
    expect(call.addCallEventMessage.mock.calls.filter(([type]) => type === "call_connected")).toHaveLength(1);
    expect(call.onError).not.toHaveBeenCalled();
  });

  it("our answered connection failing before it connected waits for the second offer", async () => {
    const call = renderCall();
    const { pc: first } = await answered(call);

    // The caller's libdatachannel refused our answer and failed the handshake: our side fails first.
    act(() => first.setIceState("failed"));
    expect(call.result.current.callState).toBe("connecting");
    expect(call.publishedKinds()).toEqual(["a"]);

    act(() => { vi.advanceTimersByTime(RESTART_GRACE_MS - 1000); });
    call.receive(remote.offer(Date.now()));
    await settle();
    const second = FakePeerConnection.instances[1];
    act(() => second.setIceState("connected"));
    expect(call.result.current.callState).toBe("connected");

    // The wait was cancelled by the new offer: nothing ends the call later.
    act(() => { vi.advanceTimersByTime(RESTART_GRACE_MS); });
    expect(call.result.current.callState).toBe("connected");
    expect(call.publishedKinds()).toEqual(["a", "a"]);
  });

  it("the handshake failing after ICE came up (the caller refused our answer) waits for the second offer too", async () => {
    const call = renderCall();
    const { pc: first } = await answered(call);
    act(() => first.setIceState("connected"));
    // The caller's DTLS rejected ours: the connection fails while ICE had said connected.
    act(() => first.setConnectionState("failed"));
    expect(call.result.current.callState).toBe("connected");
    expect(call.publishedKinds()).toEqual(["a"]);

    call.receive(remote.offer(Date.now() + 1));
    await settle();
    const second = FakePeerConnection.instances[1];
    act(() => { second.setIceState("connected"); second.setConnectionState("connected"); });
    act(() => { vi.advanceTimersByTime(RESTART_GRACE_MS); });
    expect(call.result.current.callState).toBe("connected");
    expect(call.publishedKinds()).toEqual(["a", "a"]);
  });

  it("gives up when no second offer comes, as a failed connection always did", async () => {
    const call = renderCall();
    const { stream, pc } = await answered(call);
    act(() => pc.setIceState("failed"));

    act(() => { vi.advanceTimersByTime(RESTART_GRACE_MS); });

    expect(call.result.current.callState).toBe("idle");
    expect(call.publishedKinds()).toEqual(["a", null]);
    expect(stream.getTracks().every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    expect(call.fastPoll()).toBe(false);
  });

  it("a failure after starting over is final", async () => {
    const call = renderCall();
    const { pc: first } = await answered(call);
    act(() => first.setIceState("failed"));
    call.receive(remote.offer(Date.now() + 1));
    await settle();

    act(() => FakePeerConnection.instances[1].setIceState("failed"));

    expect(call.result.current.callState).toBe("idle");
    expect(call.publishedKinds()).toEqual(["a", "a", null]);
  });

  it("hanging up while it waits ends the call, and the wait does nothing later", async () => {
    const call = renderCall();
    const { pc } = await answered(call);
    act(() => pc.setIceState("failed"));

    act(() => call.result.current.hangUp());
    act(() => { vi.advanceTimersByTime(RESTART_GRACE_MS); });

    expect(call.result.current.callState).toBe("idle");
    expect(call.publishedKinds()).toEqual(["a", "h", null]);
  });

  it("an offer while ICE already says connected, before the connection came up, is a restart too", async () => {
    const call = renderCall();
    const { pc: first } = await answered(call);
    // A headless caller answers our checks before it has our answer: ICE is up, DTLS is not.
    act(() => first.setIceState("connected"));
    expect(call.result.current.callState).toBe("connected");

    call.receive(remote.offer(Date.now() + 1));
    await settle();
    expect(first.close).toHaveBeenCalledOnce();
    expect(call.publishedKinds()).toEqual(["a", "a"]);

    const second = FakePeerConnection.instances[1];
    act(() => { second.setIceState("connected"); second.setConnectionState("connected"); });
    expect(call.result.current.callState).toBe("connected");
    expect(call.addCallEventMessage.mock.calls.filter(([type]) => type === "call_connected")).toHaveLength(1);
  });

  it("an offer is not a restart for a call we placed, nor for one whose connection came up", async () => {
    const call = renderCall();
    const { pc } = await offered(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    call.receive(remote.offer(Date.now() + 2));
    await settle();
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(call.result.current.callState).toBe("connecting");

    act(() => pc.setIceState("connected"));
    const other = renderCall();
    const { pc: answeredPc } = await answered(other);
    act(() => { answeredPc.setIceState("connected"); answeredPc.setConnectionState("connected"); });
    other.receive(remote.offer(Date.now() + 3));
    await settle();
    expect(answeredPc.close).not.toHaveBeenCalled();
    expect(other.result.current.callState).toBe("connected");
  });
});

describe("hanging up while the camera or microphone prompt is still open", () => {
  it("stops the stream that arrives afterwards and publishes no offer", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(true); });

    act(() => call.result.current.hangUp());
    expect(call.result.current.callState).toBe("idle");
    expect(call.publishedKinds()).toEqual(["h"]);

    const stream = devices.userMedia[0].grant();
    await settle();

    expect(stream.getTracks()).toHaveLength(2);
    expect(devices.liveTracks()).toEqual([]);
    expect(FakePeerConnection.instances).toEqual([]);
    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.localStream).toBeNull();
    expect(call.result.current.isVideoOff).toBe(true);
    expect(call.publishedKinds()).toEqual(["h"]);
    expect(call.onError).not.toHaveBeenCalled();
    expect(call.fastPoll()).toBe(false);

    act(() => { vi.advanceTimersByTime(5000); });
    expect(call.publishedKinds()).toEqual(["h", null]);
  });

  it("the peer hanging up meanwhile cancels the attempt the same way", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });

    call.receive(remote.hangUp(Date.now() + 1));
    expect(call.result.current.callState).toBe("idle");

    devices.userMedia[0].grant();
    await settle();

    expect(devices.liveTracks()).toEqual([]);
    expect(FakePeerConnection.instances).toEqual([]);
    expect(call.publishedKinds()).toEqual([null]);
    expect(call.result.current.callState).toBe("idle");
  });

  it("a prompt denied after the hang-up is not reported as an error", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    act(() => call.result.current.hangUp());

    devices.userMedia[0].deny(denied());
    await settle();

    expect(call.onError).not.toHaveBeenCalled();
    expect(call.result.current.callState).toBe("idle");
  });

  it("declining while the answer's microphone prompt is open stops that stream and sends no answer", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { void call.result.current.acceptCall(false); });

    act(() => call.result.current.hangUp());
    devices.userMedia[0].grant();
    await settle();

    expect(devices.liveTracks()).toEqual([]);
    expect(FakePeerConnection.instances).toEqual([]);
    expect(call.publishedKinds()).toEqual(["h"]);
    expect(call.result.current.callState).toBe("idle");
  });

  it("the caller giving up while our answer waits for the microphone stops that stream and sends no answer", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { void call.result.current.acceptCall(true); });

    call.receive(remote.hangUp(Date.now() + 1));
    devices.userMedia[0].grant();
    await settle();

    expect(devices.liveTracks()).toEqual([]);
    expect(FakePeerConnection.instances).toEqual([]);
    expect(call.publishedKinds()).toEqual([null]);
    expect(call.result.current.callState).toBe("idle");
  });

  it("hanging up while ICE is still gathering closes the connection and publishes no offer", async () => {
    FakePeerConnection.holdGathering = true;
    const call = renderCall();
    const { stream, pc } = await offered(call);
    expect(call.published).toEqual([]);

    act(() => call.result.current.hangUp());
    expect(pc.close).toHaveBeenCalledOnce();
    expect(stream.getTracks().every((t) => t.readyState === "ended")).toBe(true);

    act(() => pc.finishGathering());
    await settle();
    expect(call.publishedKinds()).toEqual(["h"]);
  });

  it("hanging up while the answer's ICE is still gathering publishes no answer", async () => {
    FakePeerConnection.holdGathering = true;
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { void call.result.current.acceptCall(false); });
    devices.userMedia[0].grant();
    await settle();
    const pc = FakePeerConnection.instances[0];

    act(() => call.result.current.hangUp());
    // Gathering never finishing is capped at 10 s; the cap runs out after the hang-up.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(pc.close).toHaveBeenCalledOnce();
    expect(call.publishedKinds()).toEqual(["h", null]);
    expect(call.result.current.callState).toBe("idle");
  });

  it("a camera turned on mid-call that arrives after the hang-up is stopped and not announced", async () => {
    const call = renderCall();
    const { pc } = await offered(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => pc.setIceState("connected"));

    act(() => { void call.result.current.toggleVideo(); });
    expect(devices.getUserMedia).toHaveBeenLastCalledWith({ video: true });
    act(() => call.result.current.hangUp());
    const camera = devices.userMedia[1].grant();
    await settle();

    expect(camera.getVideoTracks()[0].readyState).toBe("ended");
    expect(devices.liveTracks()).toEqual([]);
    expect(call.publishedKinds()).toEqual(["o", "h"]);
    expect(call.result.current.localStream).toBeNull();
    expect(call.result.current.isVideoOff).toBe(true);
    // The call it was meant for is over: there is nothing to report.
    expect(call.onError).not.toHaveBeenCalled();
  });
});

describe("when the prompt is refused or there is no device", () => {
  it("a denied microphone reports the error, returns to idle and leaves nothing open", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    const error = denied();

    devices.userMedia[0].deny(error);
    await settle();

    expect(call.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.localStream).toBeNull();
    expect(FakePeerConnection.instances).toEqual([]);
    expect(call.published).toEqual([]);
    expect(call.fastPoll()).toBe(false);
    // The person is told why, for a while, and the chat's "call started" line is not left without an end.
    expect(call.result.current.mediaProblem).toBe("denied");
    expect(call.addCallEventMessage.mock.calls.map(([type]) => type)).toEqual(["call_started", "call_failed"]);
    act(() => { vi.advanceTimersByTime(MEDIA_PROBLEM_SHOWN_MS); });
    expect(call.result.current.mediaProblem).toBeNull();
  });

  it("a microphone refused while answering tells the caller at once, instead of leaving it ringing", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { void call.result.current.acceptCall(false); });

    devices.userMedia[0].deny(denied());
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.mediaProblem).toBe("denied");
    expect(FakePeerConnection.instances).toEqual([]);
    // A hang-up that says the call could not connect: the caller's chat says the same.
    expect(call.published.map((s) => s && JSON.parse(s))).toEqual([expect.objectContaining({ t: "h", r: "u" })]);
    expect(call.addCallEventMessage.mock.calls.map(([type]) => type)).toEqual(["call_received", "call_failed"]);
    expect(call.fastPoll()).toBe(false);
  });

  it("a camera refused when turned on mid-call says why, and the call goes on", async () => {
    const call = renderCall();
    const { pc } = await offered(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => pc.setIceState("connected"));

    act(() => { void call.result.current.toggleVideo(); });
    devices.userMedia[1].deny(denied());
    await settle();

    expect(call.result.current.callState).toBe("connected");
    expect(call.result.current.mediaProblem).toBe("denied");
  });

  it.each([
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "unavailable"],
    ["NotReadableError", "unavailable"],
    ["OverconstrainedError", "unavailable"],
    ["OperationError", null],
  ] as const)("reads %s as %s", (name, problem) => {
    expect(mediaProblem(new DOMException("", name))).toBe(problem);
  });

  it("no camera when answering with video reports the error and hangs up instead of answering", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now(), true));
    act(() => { void call.result.current.acceptCall(true); });
    const error = new DOMException("Requested device not found", "NotFoundError");

    devices.userMedia[0].deny(error);
    await settle();

    expect(call.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(call.result.current.callState).toBe("idle");
    expect(FakePeerConnection.instances).toEqual([]);
    // No answer, but a hang-up: the caller stops ringing now.
    expect(call.publishedKinds()).toEqual(["h"]);
    expect(call.result.current.mediaProblem).toBe("unavailable");
  });

  it("an answer the connection refuses reports the error and closes everything", async () => {
    const call = renderCall();
    const { stream, pc } = await offered(call);
    const error = new DOMException("Failed to set remote answer", "OperationError");
    vi.spyOn(pc, "setRemoteDescription").mockRejectedValue(error);

    call.receive(remote.answer(Date.now() + 1));
    await settle();

    expect(call.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(pc.close).toHaveBeenCalledOnce();
    expect(stream.getTracks()[0].readyState).toBe("ended");
    expect(call.result.current.callState).toBe("idle");
  });
});

describe("a second call while the first is still getting its microphone", () => {
  it("a second start is ignored: one prompt, one connection, one offer", async () => {
    const call = renderCall();
    act(() => {
      void call.result.current.startCall(false);
      void call.result.current.startCall(true);
    });

    expect(devices.getUserMedia).toHaveBeenCalledOnce();
    devices.userMedia[0].grant();
    await settle();

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(call.publishedKinds()).toEqual(["o"]);
  });

  it("calling again after hanging up on a pending call keeps only the new call's stream", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    act(() => call.result.current.hangUp());
    act(() => { void call.result.current.startCall(true); });
    expect(devices.userMedia).toHaveLength(2);

    const second = devices.userMedia[1].grant();
    await settle();
    const first = devices.userMedia[0].grant();
    await settle();

    expect(first.getTracks().every((t) => t.readyState === "ended")).toBe(true);
    expect(second.getTracks().every((t) => t.readyState === "live")).toBe(true);
    expect(call.result.current.localStream).toBe(second as unknown as MediaStream);
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(call.publishedKinds()).toEqual(["h", "o"]);
    expect(call.result.current.callState).toBe("offering");

    // The hang-up's delayed clear would wipe the new offer; placing the call cancelled it.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(call.publishedKinds()).toEqual(["h", "o"]);
  });

  it("the old prompt failing after the new call started leaves the new call alone", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    act(() => call.result.current.hangUp());
    act(() => { void call.result.current.startCall(false); });

    devices.userMedia[0].deny(denied());
    await settle();

    expect(call.onError).not.toHaveBeenCalled();
    expect(call.result.current.callState).toBe("offering");
    devices.userMedia[1].grant();
    await settle();
    expect(call.publishedKinds()).toEqual(["h", "o"]);
  });
});

describe("a call ringing in another chat while one is on (End and answer)", () => {
  /** A call this chat placed, answered and connected for 3 s: its microphone, its connection. */
  async function onACall() {
    const call = renderCall();
    const { stream, pc } = await offered(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => pc.setIceState("connected"));
    act(() => { vi.advanceTimersByTime(3000); });
    expect(call.result.current.callState).toBe("connected");
    return { call, stream, pc };
  }

  /** Another chat, its contact calling. */
  function ringing(video = false) {
    const call = renderCall();
    call.receive(remote.offer(Date.now(), video));
    expect(call.result.current.callState).toBe("incoming");
    return call;
  }

  it("answering ends the call that is on first, with its hang-up and its end line, then answers: one microphone", async () => {
    const { call: first, stream, pc } = await onACall();
    const second = ringing();
    expect(second.result.current.otherCallOn).toBe(true);
    expect(first.result.current.otherCallOn).toBe(false);

    act(() => { void second.result.current.acceptCall(false); });

    // The first call ended as its person's hang-up ends it: the contact is told, the chat keeps its line and length.
    expect(first.result.current.callState).toBe("idle");
    expect(first.publishedKinds()).toEqual(["o", "h"]);
    expect(first.addCallEventMessage).toHaveBeenCalledWith("call_ended", false, 3000);
    expect(pc.close).toHaveBeenCalledOnce();
    // Its microphone was let go before the second call asked for one.
    expect(stream.getTracks().every((t) => t.readyState === "ended")).toBe(true);
    expect(devices.userMedia).toHaveLength(2);

    expect(second.result.current.callState).toBe("answering");
    devices.userMedia[1].grant();
    await settle();
    expect(second.publishedKinds()).toEqual(["a"]);
    expect(second.result.current.callState).toBe("connecting");
    expect(second.result.current.otherCallOn).toBe(false);
    expect(first.result.current.otherCallOn).toBe(true);
  });

  it("declining leaves the call that is on going, and the caller hears it declined", async () => {
    const { call: first } = await onACall();
    const second = ringing();

    act(() => second.result.current.rejectCall());

    expect(second.publishedKinds()).toEqual(["h"]);
    expect(second.addCallEventMessage).toHaveBeenCalledWith("call_rejected", false);
    expect(first.result.current.callState).toBe("connected");
    expect(first.publishedKinds()).toEqual(["o"]);
    expect(devices.userMedia).toHaveLength(1);
  });

  it("the second caller giving up stops the ring and leaves the call that is on alone", async () => {
    const { call: first } = await onACall();
    const second = ringing(true);

    second.receive(remote.hangUp(Date.now() + 1));

    expect(second.result.current.callState).toBe("idle");
    expect(second.addCallEventMessage).toHaveBeenCalledWith("call_missed", true, undefined, expect.any(Number));
    expect(first.result.current.callState).toBe("connected");
    expect(first.publishedKinds()).toEqual(["o"]);
  });

  it("the call that is on ending by itself while the other rings brings back the plain Accept", async () => {
    const { call: first } = await onACall();
    const second = ringing();
    expect(second.result.current.otherCallOn).toBe(true);

    first.receive(remote.hangUp(Date.now() + 1));

    expect(first.result.current.callState).toBe("idle");
    expect(second.result.current.callState).toBe("incoming");
    expect(second.result.current.otherCallOn).toBe(false);
  });

  it("a call ringing out counts as on: answering another cancels it", async () => {
    const first = renderCall();
    await offered(first);
    const second = ringing();
    expect(second.result.current.otherCallOn).toBe(true);

    act(() => { void second.result.current.acceptCall(false); });

    expect(first.result.current.callState).toBe("idle");
    expect(first.publishedKinds()).toEqual(["o", "h"]);
    expect(first.addCallEventMessage).toHaveBeenCalledWith("call_cancelled", false);
  });

  it("two calls ringing with none on: answering one makes the other an End and answer", () => {
    const first = ringing();
    const second = ringing();
    expect(first.result.current.otherCallOn).toBe(false);
    expect(second.result.current.otherCallOn).toBe(false);

    act(() => { void first.result.current.acceptCall(false); });

    expect(second.result.current.callState).toBe("incoming");
    expect(second.result.current.otherCallOn).toBe(true);
  });

  it("no call is placed from another chat while one is on", async () => {
    await onACall();
    const other = renderCall();
    expect(other.result.current.otherCallOn).toBe(true);

    act(() => { void other.result.current.startCall(false); });

    expect(other.result.current.callState).toBe("idle");
    expect(devices.userMedia).toHaveLength(1);
    expect(other.addCallEventMessage).not.toHaveBeenCalled();
  });

  it("the same contact offering again during the call is not a second call: it is ignored, as before", async () => {
    const { call } = await onACall();

    call.receive(remote.offer(Date.now() + 1));

    expect(call.result.current.callState).toBe("connected");
    expect(call.result.current.otherCallOn).toBe(false);
    expect(call.addCallEventMessage).not.toHaveBeenCalledWith("call_received", expect.anything(), undefined, expect.anything());
  });

  it("a chat that goes away with its call on no longer counts as on", async () => {
    const { call: first } = await onACall();
    const second = ringing();

    first.unmount();

    expect(second.result.current.otherCallOn).toBe(false);
  });
});

describe("unmounting", () => {
  it("closes the connection and stops the tracks of a call in progress", async () => {
    const call = renderCall();
    const { stream, pc } = await offered(call);

    call.unmount();

    expect(pc.close).toHaveBeenCalledOnce();
    expect(stream.getTracks().every((t) => t.readyState === "ended")).toBe(true);
  });

  it("cancels the hang-up's delayed clear", () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => call.result.current.rejectCall());

    call.unmount();
    act(() => { vi.advanceTimersByTime(5000); });

    expect(call.publishedKinds()).toEqual(["h"]);
  });
});

