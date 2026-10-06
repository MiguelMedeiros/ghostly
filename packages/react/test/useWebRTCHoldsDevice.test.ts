import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";
import { anyCallOn, callHoldsDevice } from "../src/callRegistry";
import { RING_MS } from "../src/useWebRTC";

// covers: devices.handoff, calls.end-and-answer

/*
 * A handoff waits while a call is on or rings in (WISP 06 § States and events). A call that rings in is not "on" for
 * the app's one call at a time (WISP 601, "On a call already"), but moving the profile while it rings would lose it:
 * the ring stops here, the caller rings on to its timeout and the new device only shows a missed call. So the device
 * is held from the ring until the ring ends, by any of its ends, and the calls on stay as they were.
 */

let devices: FakeMediaDevices;
let uninstall: () => void;
const rendered: ReturnType<typeof renderCall>[] = [];

/** A chat, unmounted after the test so the app-wide registry starts empty for the next one. */
function chat() {
  const call = renderCall();
  rendered.push(call);
  return call;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
});

afterEach(() => {
  for (const call of rendered.splice(0)) call.unmount();
  uninstall();
  vi.useRealTimers();
});

describe("a call ringing in holds the device for a handoff", () => {
  it("from the ring, and no longer once it is declined", () => {
    const call = chat();
    expect(callHoldsDevice()).toBe(false);
    call.receive(remote.offer(Date.now()));
    expect(call.result.current.callState).toBe("incoming");
    expect(callHoldsDevice()).toBe(true);
    act(() => call.result.current.rejectCall());
    expect(callHoldsDevice()).toBe(false);
  });

  it("no longer once it rings out (RING_MS)", () => {
    const call = chat();
    call.receive(remote.offer(Date.now()));
    act(() => { vi.advanceTimersByTime(RING_MS - 1); });
    expect(callHoldsDevice()).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(call.result.current.callState).toBe("idle");
    expect(callHoldsDevice()).toBe(false);
  });

  it("no longer once the caller hangs up", () => {
    const call = chat();
    call.receive(remote.offer(Date.now()));
    call.receive(remote.hangUp(Date.now() + 1));
    expect(call.result.current.callState).toBe("idle");
    expect(callHoldsDevice()).toBe(false);
  });

  it("no longer once the chat that rang goes away", () => {
    const call = chat();
    call.receive(remote.offer(Date.now()));
    call.unmount();
    rendered.splice(rendered.indexOf(call), 1);
    expect(callHoldsDevice()).toBe(false);
  });

  it("answered, it holds the device as a call on, until it ends", async () => {
    const call = chat();
    call.receive(remote.offer(Date.now()));
    act(() => { void call.result.current.acceptCall(false); });
    expect(callHoldsDevice()).toBe(true);
    devices.userMedia[0].grant();
    await settle();
    act(() => { FakePeerConnection.instances[0].setIceState("connected"); });
    expect(call.result.current.callState).toBe("connected");
    expect(callHoldsDevice()).toBe(true);
    act(() => call.result.current.hangUp());
    expect(call.result.current.callState).toBe("idle");
    expect(callHoldsDevice()).toBe(false);
  });
});

describe("a call ringing in is still not a call on", () => {
  it("another chat may place a call, sees no call on, and answering it sends the ringing caller nothing", async () => {
    const ringing = chat();
    const other = chat();
    ringing.receive(remote.offer(Date.now()));
    expect(anyCallOn()).toBe(false);
    expect(other.result.current.otherCallOn).toBe(false);
    expect(ringing.result.current.otherCallOn).toBe(false);

    // A second call rings in the other chat and is answered: the first keeps ringing, with nothing sent to its caller.
    other.receive(remote.offer(Date.now() + 1));
    act(() => { void other.result.current.acceptCall(false); });
    devices.userMedia[0].grant();
    await settle();
    expect(ringing.result.current.callState).toBe("incoming");
    expect(ringing.publishedKinds()).toEqual([]);
    expect(ringing.result.current.otherCallOn).toBe(true);
    expect(callHoldsDevice()).toBe(true);
  });
});
