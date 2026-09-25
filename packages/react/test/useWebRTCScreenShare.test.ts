import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCREEN_SHARE_ERROR_MS, screenShareErrorMessage } from "../src/useWebRTC";
import { FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices, type FakeTrack } from "./fakes";
import { renderCall, settle } from "./harness";

// covers: calls.screen-share, calls.upgrade

/**
 * Sharing the screen happens inside a call, voice or video: the screen goes on the video section every call
 * negotiates, in place of the camera or of no picture at all, and stopping (from the button, from the browser's
 * own "Stop sharing", or by hanging up) goes back to what was there.
 */

let devices: FakeMediaDevices;
let uninstall: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

/** A call we placed (voice, or video), answered by the peer and connected. */
async function connectedCall(video = false) {
  const call = renderCall();
  act(() => { void call.result.current.startCall(video); });
  const stream = devices.userMedia[0].grant();
  await settle();
  const pc = FakePeerConnection.instances[0];
  call.receive(remote.answer(Date.now() + 1));
  await settle();
  act(() => pc.setIceState("connected"));
  const sender = pc.getTransceivers().find((t) => t.receiver.track.kind === "video")!.sender;
  return { call, stream, pc, sender };
}

/** What the picture signals this side published said, in order: `1s` a screen, `1c` a camera, `0` none. */
function pictures(call: ReturnType<typeof renderCall>): string[] {
  return call.published
    .map((s) => (s === null ? null : (JSON.parse(s) as { t: string; v?: number; k?: string })))
    .filter((s) => s?.t === "v")
    .map((s) => `${s!.v}${s!.k ?? ""}`);
}

/** Presses the share button and answers the picker with a screen. */
async function share(call: ReturnType<typeof renderCall>): Promise<FakeTrack> {
  act(() => { void call.result.current.toggleScreenShare(); });
  const screen = devices.displayMedia[devices.displayMedia.length - 1].grant().getVideoTracks()[0];
  await settle();
  return screen;
}

/** The browser's (or the system's) own "Stop sharing": the track ends, and nothing else says so. */
function endedByBrowser(track: FakeTrack) {
  track.readyState = "ended";
  act(() => track.onended?.());
}

describe("sharing the screen in a voice call", () => {
  it("goes on the video section the call negotiated empty: no second offer, and the peer is told it is a screen", async () => {
    const { call, sender } = await connectedCall();
    expect(call.result.current.canShareScreen).toBe(true);
    expect(call.result.current.screenShareUnavailable).toBeNull();

    const screen = await share(call);

    expect(devices.getDisplayMedia).toHaveBeenCalledExactlyOnceWith({ video: true, audio: false });
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(screen);
    expect(screen.contentHint).toBe("detail");
    expect(call.result.current.isScreenSharing).toBe(true);
    expect(call.result.current.localStream!.getTracks().map((t) => t.kind)).toEqual(["audio", "video"]);
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(call.publishedKinds()).toEqual(["o", "v"]);
    expect(pictures(call)).toEqual(["1s"]);
  });

  it("stopping from the button goes back to voice: the section is emptied, the capture stopped, the peer told", async () => {
    const { call, sender } = await connectedCall();
    const screen = await share(call);

    await act(() => call.result.current.toggleScreenShare());

    expect(sender.replaceTrack).toHaveBeenLastCalledWith(null);
    expect(screen.readyState).toBe("ended");
    expect(call.result.current.isScreenSharing).toBe(false);
    expect(call.result.current.isVideoOff).toBe(true);
    // Voice again: the camera was never asked for.
    expect(devices.getUserMedia).toHaveBeenCalledOnce();
    expect(pictures(call)).toEqual(["1s", "0"]);
    expect(devices.liveTracks().map((t) => t.kind)).toEqual(["audio"]);
  });

  it("the browser's own Stop sharing ends it the same way", async () => {
    const { call, sender } = await connectedCall();
    const screen = await share(call);

    endedByBrowser(screen);
    await settle();

    expect(sender.replaceTrack).toHaveBeenLastCalledWith(null);
    expect(call.result.current.isScreenSharing).toBe(false);
    expect(pictures(call)).toEqual(["1s", "0"]);
  });

  it("hanging up while sharing stops the capture, and sends a hang-up, not a picture change", async () => {
    const { call } = await connectedCall();
    const screen = await share(call);

    act(() => call.result.current.hangUp());

    expect(screen.readyState).toBe("ended");
    expect(devices.liveTracks()).toEqual([]);
    expect(call.publishedKinds()).toEqual(["o", "v", "h"]);
    expect(call.result.current.isScreenSharing).toBe(false);
  });

  it("hanging up while the picker is open lets go of the screen it returns, and says nothing", async () => {
    const { call } = await connectedCall();
    act(() => { void call.result.current.toggleScreenShare(); });
    act(() => call.result.current.hangUp());

    const screen = devices.displayMedia[0].grant().getVideoTracks()[0];
    await settle();

    expect(screen.readyState).toBe("ended");
    expect(pictures(call)).toEqual([]);
    expect(call.onError).not.toHaveBeenCalled();
    expect(call.result.current.screenShareError).toBeNull();
  });

  it("a second press while the picker is open asks once", async () => {
    const { call } = await connectedCall();
    act(() => {
      void call.result.current.toggleScreenShare();
      void call.result.current.toggleScreenShare();
    });
    devices.displayMedia[0].grant();
    await settle();

    expect(devices.getDisplayMedia).toHaveBeenCalledOnce();
    expect(call.result.current.isScreenSharing).toBe(true);
  });
});

describe("sharing the screen in a video call", () => {
  it("takes the camera's place, and stopping turns the camera back on", async () => {
    const { call, stream, sender } = await connectedCall(true);
    const camera = stream.getVideoTracks()[0];
    const screen = await share(call);
    expect(camera.readyState).toBe("ended");
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(screen);

    act(() => { void call.result.current.toggleScreenShare(); });
    expect(devices.getUserMedia).toHaveBeenLastCalledWith({ video: true });
    const back = devices.userMedia[1].grant().getVideoTracks()[0];
    await settle();

    expect(sender.replaceTrack).toHaveBeenLastCalledWith(back);
    expect(screen.readyState).toBe("ended");
    expect(call.result.current.isScreenSharing).toBe(false);
    expect(call.result.current.isVideoOff).toBe(false);
    expect(pictures(call)).toEqual(["1s", "1c"]);
  });

  it("the browser's own Stop sharing turns the camera back on too, and a press meanwhile asks for it once", async () => {
    const { call, sender } = await connectedCall(true);
    const screen = await share(call);

    endedByBrowser(screen);
    act(() => { void call.result.current.toggleScreenShare(); });
    const back = devices.userMedia[1].grant().getVideoTracks()[0];
    await settle();

    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(back);
    expect(pictures(call)).toEqual(["1s", "1c"]);
    expect(call.result.current.isScreenSharing).toBe(false);
  });

  it("a camera that cannot come back still ends the share, as a voice call", async () => {
    const { call, sender } = await connectedCall(true);
    const screen = await share(call);

    act(() => { void call.result.current.toggleScreenShare(); });
    devices.userMedia[1].deny(new DOMException("Could not start video source", "NotReadableError"));
    await settle();

    expect(sender.replaceTrack).toHaveBeenLastCalledWith(null);
    expect(screen.readyState).toBe("ended");
    expect(call.result.current.isScreenSharing).toBe(false);
    expect(call.result.current.isVideoOff).toBe(true);
    expect(pictures(call)).toEqual(["1s", "0"]);
    expect(call.onError).toHaveBeenCalledOnce();
    // It is the camera that failed, not the share.
    expect(call.result.current.screenShareError).toBeNull();
  });
});

describe("when the screen cannot be shared", () => {
  it("closing the picker changes nothing and says nothing", async () => {
    const { call, sender } = await connectedCall();
    act(() => { void call.result.current.toggleScreenShare(); });
    // A person looks at the picker, then closes it.
    act(() => { vi.advanceTimersByTime(2000); });
    devices.displayMedia[0].deny(new DOMException("Permission denied", "NotAllowedError"));
    await settle();

    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(call.result.current.isScreenSharing).toBe(false);
    expect(call.onError).not.toHaveBeenCalled();
    expect(call.result.current.screenShareError).toBeNull();
    expect(pictures(call)).toEqual([]);
  });

  it("a system that refuses screen recording is explained for a few seconds, and the call goes on", async () => {
    const { call } = await connectedCall();
    const error = new DOMException("Permission denied by system", "NotAllowedError");
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { void call.result.current.toggleScreenShare(); });
    devices.displayMedia[0].deny(error);
    await settle();

    expect(call.result.current.screenShareError).toMatch(/blocked.*screen recording/i);
    expect(call.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(call.result.current.callState).toBe("connected");

    act(() => { vi.advanceTimersByTime(SCREEN_SHARE_ERROR_MS); });
    expect(call.result.current.screenShareError).toBeNull();
  });

  it("an explanation goes away with the next try, and with the call", async () => {
    const { call } = await connectedCall();
    act(() => { void call.result.current.toggleScreenShare(); });
    devices.displayMedia[0].deny(new DOMException("Could not start video source", "NotReadableError"));
    await settle();
    expect(call.result.current.screenShareError).toBe("Could not share the screen. Try again.");

    await share(call);
    expect(call.result.current.screenShareError).toBeNull();

    act(() => { void call.result.current.toggleScreenShare(); });
    await settle();
    act(() => { void call.result.current.toggleScreenShare(); });
    devices.displayMedia[devices.displayMedia.length - 1].deny(new DOMException("No screen", "NotFoundError"));
    await settle();
    expect(call.result.current.screenShareError).toBe("There is no screen to share");
    act(() => call.result.current.hangUp());
    expect(call.result.current.screenShareError).toBeNull();
  });

  it("a call whose offer had no video section keeps the button, turned off, with the reason", async () => {
    const call = renderCall();
    // An app from before calls always carried a video section: its voice call has audio only.
    const audioOnly = JSON.stringify({ ...JSON.parse(remote.offer(Date.now())), m: ["a"], ss: [1], v: undefined });
    call.receive(audioOnly);
    act(() => { void call.result.current.acceptCall(false); });
    devices.userMedia[0].grant();
    await settle();
    act(() => FakePeerConnection.instances[0].setIceState("connected"));

    expect(call.result.current.callState).toBe("connected");
    expect(call.result.current.canShareScreen).toBe(false);
    expect(call.result.current.screenShareUnavailable).toBe("Your contact's app cannot show a screen in this call");
  });

  it("where no screen can be captured (phones), there is no share and no reason to give", async () => {
    (devices as { getDisplayMedia?: unknown }).getDisplayMedia = undefined;
    const { call } = await connectedCall();

    expect(call.result.current.canSendVideo).toBe(true);
    expect(call.result.current.canShareScreen).toBe(false);
    expect(call.result.current.screenShareUnavailable).toBeNull();
  });

  it("before the call connects there is nothing to share on yet", () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });

    expect(call.result.current.canShareScreen).toBe(false);
    expect(call.result.current.screenShareUnavailable).toBeNull();
  });
});

describe("the peer sharing its screen", () => {
  it("is told apart from its camera, whichever way the call started", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { void call.result.current.acceptCall(false); });
    devices.userMedia[0].grant();
    await settle();
    act(() => FakePeerConnection.instances[0].setIceState("connected"));
    expect(call.result.current.remoteHasVideo).toBe(false);

    const picture = (ts: number, v: number, k?: string) => JSON.stringify({ t: "v", ts, v, ...(k ? { k } : {}) });
    call.receive(picture(Date.now() + 1, 1, "s"));
    expect(call.result.current.remoteHasVideo).toBe(true);
    expect(call.result.current.remoteIsScreenSharing).toBe(true);

    call.receive(picture(Date.now() + 2, 1, "c"));
    expect(call.result.current.remoteIsScreenSharing).toBe(false);
    expect(call.result.current.remoteHasVideo).toBe(true);

    call.receive(picture(Date.now() + 3, 1, "s"));
    call.receive(picture(Date.now() + 4, 0));
    expect(call.result.current.remoteHasVideo).toBe(false);
    expect(call.result.current.remoteIsScreenSharing).toBe(false);
  });
});

describe("screenShareErrorMessage", () => {
  const error = (name: string, message = "") => new DOMException(message, name);

  it("says nothing when a person closed the picker", () => {
    expect(screenShareErrorMessage(error("NotAllowedError", "Permission denied"), 1500)).toBeNull();
  });

  it("explains a refusal by the system, whether it says so (Chromium) or refuses before any picker (WebKit)", () => {
    expect(screenShareErrorMessage(error("NotAllowedError", "Permission denied by system"), 1500)).toMatch(/screen recording/);
    expect(screenShareErrorMessage(error("NotAllowedError", "The request is not allowed"), 20)).toMatch(/screen recording/);
  });

  it("gives a short reason for the rest", () => {
    expect(screenShareErrorMessage(error("NotFoundError"))).toBe("There is no screen to share");
    expect(screenShareErrorMessage(error("NotSupportedError"))).toBe("Screen sharing is not available here");
    expect(screenShareErrorMessage(new TypeError("getDisplayMedia is not a function"))).toBe("Screen sharing is not available here");
    expect(screenShareErrorMessage(error("NotReadableError"))).toBe("Could not share the screen. Try again.");
    expect(screenShareErrorMessage(undefined)).toBe("Could not share the screen. Try again.");
  });
});
