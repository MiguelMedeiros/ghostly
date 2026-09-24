import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";

/**
 * Unmounting cancels a call attempt still waiting for the microphone or for ICE, as a hang-up does. Before, the
 * unmount cleanup only stopped the tracks and closed the connection it had then: when the prompt answered
 * afterwards, the attempt kept the stream (the microphone stayed on), opened a connection nobody would close,
 * and published an offer or an answer for a chat that was gone.
 */

let devices: FakeMediaDevices;
let uninstall: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

describe("unmounting while the microphone prompt is open", () => {
  it("stops the stream that arrives after a call was placed", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });

    call.unmount();
    devices.userMedia[0].grant();
    await settle();

    expect(devices.liveTracks()).toEqual([]);
  });

  it("opens no connection and publishes no offer for a call placed before the unmount", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });

    call.unmount();
    devices.userMedia[0].grant();
    await settle();

    expect(FakePeerConnection.instances.filter((pc) => !pc.closed)).toEqual([]);
    expect(call.published).toEqual([]);
  });

  it("stops the stream and publishes no answer for a call being answered", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { void call.result.current.acceptCall(false); });

    call.unmount();
    devices.userMedia[0].grant();
    await settle();

    expect(devices.liveTracks()).toEqual([]);
    expect(call.published).toEqual([]);
  });
});

describe("unmounting while ICE is still gathering", () => {
  it("publishes no offer once gathering finishes", async () => {
    FakePeerConnection.holdGathering = true;
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    devices.userMedia[0].grant();
    await settle();
    const pc = FakePeerConnection.instances[0];

    call.unmount();
    // The connection is closed by the unmount, but the attempt still waits on its gathering.
    expect(pc.close).toHaveBeenCalledOnce();
    act(() => pc.finishGathering());
    await settle();

    expect(call.published).toEqual([]);
  });
});
