import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";

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
});

describe("answering a call", () => {
  it("rings for an incoming offer and answers with our half of the video lane open", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    expect(call.result.current.callState).toBe("incoming");
    expect(call.addCallEventMessage).toHaveBeenCalledWith("call_received", false);

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
    // It never connected, so there is no "call ended" line in the chat.
    expect(call.addCallEventMessage).not.toHaveBeenCalledWith("call_ended", expect.anything(), expect.anything());
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
  });

  it("no camera when answering with video reports the error and sends no answer", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now(), true));
    act(() => { void call.result.current.acceptCall(true); });
    const error = new DOMException("Requested device not found", "NotFoundError");

    devices.userMedia[0].deny(error);
    await settle();

    expect(call.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(call.result.current.callState).toBe("idle");
    expect(FakePeerConnection.instances).toEqual([]);
    expect(call.published).toEqual([]);
  });

  it("sharing the screen with the microphone denied stops the screen capture it already had", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(true, "screen"); });
    const screen = devices.displayMedia[0].grant();
    await settle();

    devices.userMedia[0].deny(denied());
    await settle();

    expect(screen.getVideoTracks()[0].readyState).toBe("ended");
    expect(devices.liveTracks()).toEqual([]);
    expect(call.onError).toHaveBeenCalledOnce();
    expect(call.result.current.callState).toBe("idle");
    expect(call.published).toEqual([]);
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

