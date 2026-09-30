import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallMedia } from "@ghostly/core";
import { FakePeerConnection, device, installWebRTCFakes, remote, type FakeMediaDevices, type FakeTrack } from "./fakes";
import { renderCall, settle } from "./harness";

// covers: calls.devices

/**
 * The microphone and camera a call uses: the profile's choice when the call starts, and another one switched
 * in during the call with `replaceTrack`, which needs no new offer and keeps the call as it was.
 */

let devices: FakeMediaDevices;
let uninstall: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
  devices.devices = [
    device("audioinput", "mic-builtin", "MacBook Pro Microphone"),
    device("audioinput", "mic-headset", "AirPods"),
    device("videoinput", "cam-builtin", "FaceTime HD Camera"),
    device("videoinput", "cam-usb", "Logitech C920"),
  ];
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

/** A call we placed, answered by the peer and connected. */
async function connectedCall(video = false, choices?: () => { audio?: ConstrainDOMString; video?: ConstrainDOMString }) {
  const call = renderCall(undefined, choices);
  act(() => { void call.result.current.startCall(video); });
  const stream = devices.userMedia[0].grant();
  await settle();
  const pc = FakePeerConnection.instances[0];
  call.receive(remote.answer(Date.now() + 1));
  await settle();
  act(() => pc.setIceState("connected"));
  const senders = (kind: string) => pc.getTransceivers().find((t) => t.receiver.track.kind === kind)!.sender;
  return { call, stream, pc, audio: senders("audio"), video: senders("video") };
}

describe("the devices a call starts with", () => {
  it("are the chosen microphone and camera", async () => {
    const { stream } = await connectedCall(true, () => ({ audio: { ideal: "mic-headset" }, video: { ideal: "cam-usb" } }));

    expect(devices.userMedia[0].constraints).toEqual({ audio: { deviceId: { ideal: "mic-headset" } }, video: { deviceId: { ideal: "cam-usb" } } });
    expect(stream.getTracks().map((t) => (t as FakeTrack).deviceId)).toEqual(["mic-headset", "cam-usb"]);
  });

  it("are the defaults when nothing was chosen, and a voice call asks for no camera", async () => {
    await connectedCall(false, () => ({}));
    expect(devices.userMedia[0].constraints).toEqual({ audio: true, video: false });
  });

  it("are the defaults when the chosen one is not connected", async () => {
    const { stream } = await connectedCall(false, () => ({ audio: { ideal: "mic-gone" } }));
    expect((stream.getAudioTracks()[0] as FakeTrack).deviceId).toBe("default");
  });

  it("answering uses them too", async () => {
    const call = renderCall(undefined, () => ({ audio: { ideal: "mic-headset" } }));
    call.receive(remote.offer(Date.now() + 1));
    act(() => { void call.result.current.acceptCall(false); });
    expect(devices.userMedia[0].constraints).toEqual({ audio: { deviceId: { ideal: "mic-headset" } }, video: false });
  });

  it("turning the camera on later uses the chosen camera", async () => {
    const { call } = await connectedCall(false, () => ({ video: { ideal: "cam-usb" } }));
    act(() => { void call.result.current.toggleVideo(); });
    expect(devices.userMedia[1].constraints).toEqual({ video: { deviceId: { ideal: "cam-usb" } } });
  });

  it("Linux Desktop's native media picks its own: no choice is passed, and nothing can be switched", async () => {
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => devices.getUserMedia(constraints) as unknown as Promise<MediaStream>);
    const media: CallMedia = { createPeerConnection: (config) => new FakePeerConnection(config) as unknown as RTCPeerConnection, getUserMedia };
    const call = renderCall(media, () => ({ audio: { ideal: "mic-headset" } }));
    act(() => { void call.result.current.startCall(false); });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(call.result.current.canSwitchDevices).toBe(false);
  });
});

describe("switching the microphone during a call", () => {
  it("swaps the track the audio sender carries, with no new offer, and stops the old one", async () => {
    const { call, stream, audio } = await connectedCall();
    const old = stream.getAudioTracks()[0] as FakeTrack;
    const kinds = call.publishedKinds();

    act(() => { void call.result.current.switchMicrophone("mic-headset"); });
    expect(devices.userMedia[1].constraints).toEqual({ audio: { deviceId: { exact: "mic-headset" } } });
    const headset = devices.userMedia[1].grant().getAudioTracks()[0];
    await settle();

    expect(audio.replaceTrack).toHaveBeenCalledWith(headset);
    expect(audio.track).toBe(headset);
    expect(old.stop).toHaveBeenCalled();
    expect(call.result.current.localStream?.getAudioTracks()).toEqual([headset]);
    expect(call.publishedKinds(), "nothing is signaled").toEqual(kinds);
    expect(call.result.current.callState).toBe("connected");
  });

  it("keeps a muted call muted", async () => {
    const { call } = await connectedCall();
    act(() => call.result.current.toggleMute());

    act(() => { void call.result.current.switchMicrophone("mic-headset"); });
    const headset = devices.userMedia[1].grant().getAudioTracks()[0];
    await settle();

    expect(headset.enabled).toBe(false);
    expect(call.result.current.isMuted).toBe(true);
  });

  it("back to the default asks for no device", async () => {
    const { call } = await connectedCall();
    act(() => { void call.result.current.switchMicrophone(null); });
    expect(devices.userMedia[1].constraints).toEqual({ audio: true });
  });

  it("keeps the camera's track in the call's stream", async () => {
    const { call, stream } = await connectedCall(true);
    act(() => { void call.result.current.switchMicrophone("mic-headset"); });
    devices.userMedia[1].grant();
    await settle();
    expect(call.result.current.localStream?.getVideoTracks()).toEqual(stream.getVideoTracks());
  });

  it("a hang-up while the microphone opens lets go of it", async () => {
    const { call } = await connectedCall();
    act(() => { void call.result.current.switchMicrophone("mic-headset"); });
    act(() => call.result.current.hangUp());
    devices.userMedia[1].grant();
    await settle();
    expect(devices.liveTracks()).toEqual([]);
  });

  it("a device that is gone fails, and the call keeps its microphone", async () => {
    const { call, stream, audio } = await connectedCall();
    let failure: unknown;
    act(() => { call.result.current.switchMicrophone("mic-gone").catch((e: unknown) => { failure = e; }); });
    devices.userMedia[1].grant();
    await settle();
    expect((failure as Error).name).toBe("OverconstrainedError");
    expect(audio.track).toBe(stream.getAudioTracks()[0]);
  });
});

describe("switching the camera during a call", () => {
  it("swaps the camera's track, and the call keeps going", async () => {
    const { call, stream, video } = await connectedCall(true);
    const old = stream.getVideoTracks()[0] as FakeTrack;

    act(() => { void call.result.current.switchCamera("cam-usb"); });
    expect(devices.userMedia[1].constraints).toEqual({ video: { deviceId: { exact: "cam-usb" } } });
    const usb = devices.userMedia[1].grant().getVideoTracks()[0];
    await settle();

    expect(video.replaceTrack).toHaveBeenCalledWith(usb);
    expect(old.stop).toHaveBeenCalled();
    expect(call.result.current.isVideoOff).toBe(false);
    expect(call.result.current.callState).toBe("connected");
  });

  it("turned off while the other camera opens, it stays off and lets go of that camera", async () => {
    const { call, video } = await connectedCall(true);

    act(() => { void call.result.current.switchCamera("cam-usb"); });
    await act(() => call.result.current.toggleVideo());
    expect(call.result.current.isVideoOff).toBe(true);

    const usb = devices.userMedia[1].grant().getVideoTracks()[0] as FakeTrack;
    await settle();

    expect(call.result.current.isVideoOff).toBe(true);
    expect(video.track).toBeNull();
    expect(usb.stop).toHaveBeenCalled();
    expect(call.result.current.localStream?.getVideoTracks()).toEqual([]);
    expect(devices.liveTracks().map((t) => t.kind)).toEqual(["audio"]);
  });

  it("switched twice quickly, the camera picked last is the one shown", async () => {
    const { call, video } = await connectedCall(true);

    act(() => { void call.result.current.switchCamera("cam-usb"); });
    act(() => { void call.result.current.switchCamera("cam-builtin"); });
    const builtin = devices.userMedia[2].grant().getVideoTracks()[0] as FakeTrack;
    await settle();
    const usb = devices.userMedia[1].grant().getVideoTracks()[0] as FakeTrack;
    await settle();

    expect(video.track).toBe(builtin);
    expect(usb.stop).toHaveBeenCalled();
    expect(call.result.current.localStream?.getVideoTracks()).toEqual([builtin]);
  });

  it("with the camera off, or a screen shared, there is nothing to swap", async () => {
    const { call } = await connectedCall(false);
    await act(() => call.result.current.switchCamera("cam-usb"));
    expect(devices.userMedia).toHaveLength(1);
  });
});
