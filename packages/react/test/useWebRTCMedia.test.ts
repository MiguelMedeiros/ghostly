import { act } from "@testing-library/react";
import type { CallMedia } from "@ghostly/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeMediaDevices, FakePeerConnection, installWebRTCFakes, remote } from "./fakes";
import { renderCall, settle } from "./harness";

// covers: calls.linux-native

/**
 * A call whose media is not the page's own WebRTC: Ghostly Desktop on Linux, whose WebKitGTK has none, brings a
 * stand-in with the same shape (src/desktop/nativeCalls.ts). The hook uses what it is given for the connection
 * and the camera, and where the screen cannot be shared, the call window says why instead of hiding it.
 */

const REASON = "Screen sharing is not available on Linux yet";
let uninstall: () => void;
let devices: FakeMediaDevices;
let media: CallMedia & { createPeerConnection: ReturnType<typeof vi.fn>; getUserMedia: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  ({ uninstall } = installWebRTCFakes());
  devices = new FakeMediaDevices();
  media = {
    createPeerConnection: vi.fn((config: RTCConfiguration) => new FakePeerConnection(config) as unknown as RTCPeerConnection),
    getUserMedia: vi.fn((constraints: MediaStreamConstraints) => devices.getUserMedia(constraints) as unknown as Promise<MediaStream>),
    screenUnavailable: REASON,
  };
  // The page has none of it: using the globals would throw.
  vi.stubGlobal("RTCPeerConnection", vi.fn(() => { throw new Error("no WebRTC in this page"); }));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

describe("a call with media from the app, not the page", () => {
  it("places a call through it, and connects", async () => {
    const call = renderCall(media);
    act(() => { void call.result.current.startCall(true); });
    devices.userMedia[0].grant();
    await settle();
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(media.createPeerConnection).toHaveBeenCalledTimes(1);
    expect(call.publishedKinds()).toEqual(["o"]);

    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => FakePeerConnection.instances[0].setIceState("connected"));
    expect(call.result.current.callState).toBe("connected");
    expect(call.onError).not.toHaveBeenCalled();
  });

  it("answers through it", async () => {
    const call = renderCall(media);
    call.receive(remote.offer(Date.now(), true));
    await settle();
    act(() => { void call.result.current.acceptCall(false); });
    devices.userMedia[0].grant();
    await settle();
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(call.publishedKinds()).toEqual(["a"]);
  });

  it("where it cannot share the screen, the connected call says why on a share button turned off", async () => {
    const call = renderCall(media);
    act(() => { void call.result.current.startCall(false); });
    devices.userMedia[0].grant();
    await settle();
    expect(call.result.current.screenShareUnavailable).toBeNull();
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => FakePeerConnection.instances[0].setIceState("connected"));
    expect(call.result.current.canShareScreen).toBe(false);
    expect(call.result.current.screenShareUnavailable).toBe(REASON);

    // Pressed anyway, it explains and changes nothing.
    await act(async () => { await call.result.current.toggleScreenShare(); });
    expect(call.result.current.screenShareError).toBe("Screen sharing is not available here");
    expect(call.result.current.isScreenSharing).toBe(false);
  });
});
