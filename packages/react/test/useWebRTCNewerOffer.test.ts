import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";
import { RING_MS } from "../src/useWebRTC";

// covers: calls.audio, calls.video

// The contact's app died or reloaded while its call rang out here, its hang-up never came, and it calls again within
// the minute (WISP 601, "Ringing"): the newer offer is the call that rings, and the one Answer answers.

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

const lines = (call: ReturnType<typeof renderCall>) => call.addCallEventMessage.mock.calls.map(([type]) => type);

/** Answers the call ringing in `call` with the microphone granted, and returns the answer it published. */
async function answer(call: ReturnType<typeof renderCall>) {
  act(() => { void call.result.current.acceptCall(false); });
  devices.userMedia[devices.userMedia.length - 1].grant();
  await settle();
  const published = call.published.filter((signal): signal is string => signal !== null).map((s) => JSON.parse(s) as { t: string; o?: number });
  return published.find((signal) => signal.t === "a");
}

describe("a newer offer from the contact while their call rings here", () => {
  it("takes the ringing call's place: Answer answers the newer offer", async () => {
    const call = renderCall();
    const first = Date.now();
    call.receive(remote.offer(first));
    act(() => { vi.advanceTimersByTime(5000); });
    const second = Date.now();
    call.receive(remote.offer(second));

    expect(call.result.current.callState).toBe("incoming");
    expect(call.result.current.ringingOffer?.ts).toBe(second);
    expect(await answer(call)).toMatchObject({ t: "a", o: second });
    expect(call.result.current.callState).toBe("connecting");
  });

  it("keeps one Incoming line: the ringing call's line goes, and the newer offer's takes its place", () => {
    const call = renderCall();
    const first = Date.now();
    call.receive(remote.offer(first));
    const firstLine = call.addCallEventMessage.mock.results[0]!.value as string;
    act(() => { vi.advanceTimersByTime(5000); });
    const second = Date.now();
    call.receive(remote.offer(second, true));

    expect(call.removeCallEventMessage).toHaveBeenCalledExactlyOnceWith(firstLine);
    expect(call.addCallEventMessage.mock.calls).toEqual([
      ["call_received", false, undefined, first],
      ["call_received", true, undefined, second],
    ]);
    // The newer offer's picture is the call's: a video call now.
    expect(call.result.current.ringingOffer?.ts).toBe(second);
    // Nothing goes to the contact: their new call rings on there.
    expect(call.published).toEqual([]);
  });

  it("rings its own minute from when it came, and is missed then under the newer offer's line", () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { vi.advanceTimersByTime(40_000); });
    const second = Date.now();
    call.receive(remote.offer(second));

    // The first offer's minute is up: the newer one still rings.
    act(() => { vi.advanceTimersByTime(RING_MS - 40_000); });
    expect(call.result.current.callState).toBe("incoming");
    act(() => { vi.advanceTimersByTime(40_000 - 1); });
    expect(call.result.current.callState).toBe("incoming");
    act(() => { vi.advanceTimersByTime(1); });

    expect(call.result.current.callState).toBe("idle");
    expect(lines(call)).toEqual(["call_received", "call_received", "call_missed"]);
    expect(call.addCallEventMessage).toHaveBeenLastCalledWith("call_missed", false, undefined, second);
    expect(call.publishedKinds()).not.toContain("h");
  });

  it("is missed under the newer offer's line when the contact hangs it up", () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { vi.advanceTimersByTime(5000); });
    const second = Date.now();
    call.receive(remote.offer(second));
    act(() => { vi.advanceTimersByTime(3000); });
    call.receive(remote.hangUp(Date.now()));

    expect(call.result.current.callState).toBe("idle");
    expect(call.addCallEventMessage).toHaveBeenLastCalledWith("call_missed", false, undefined, second);
  });

  it("an offer no newer than the ringing one (one heard again) changes nothing", async () => {
    const call = renderCall();
    const first = Date.now();
    call.receive(remote.offer(first));
    act(() => { vi.advanceTimersByTime(5000); });
    const second = Date.now();
    call.receive(remote.offer(second));

    // The same offer again (the app's next session sends its latest signal while it is fresh), then the older one.
    call.receive(JSON.stringify({ ...JSON.parse(remote.offer(second)), at: Date.now() }));
    call.receive(remote.offer(first));
    call.receive(remote.offer(second - 1));

    expect(call.result.current.ringingOffer?.ts).toBe(second);
    expect(lines(call)).toEqual(["call_received", "call_received"]);
    expect(call.removeCallEventMessage).toHaveBeenCalledOnce();
    expect(await answer(call)).toMatchObject({ t: "a", o: second });
  });

  it("an offer at the ringing one's own millisecond does not replace it", async () => {
    const call = renderCall();
    const first = Date.now();
    call.receive(remote.offer(first));
    call.receive(JSON.stringify({ ...JSON.parse(remote.offer(first)), f: "ab".repeat(32), at: Date.now() }));

    expect(lines(call)).toEqual(["call_received"]);
    expect(call.removeCallEventMessage).not.toHaveBeenCalled();
    expect(await answer(call)).toMatchObject({ t: "a", o: first });
  });

  it("another contact's call is theirs alone: the call ringing in this chat keeps its offer", async () => {
    const mine = renderCall(undefined, undefined, {}, "chat-a");
    const theirs = renderCall(undefined, undefined, {}, "chat-b");
    const first = Date.now();
    mine.receive(remote.offer(first));
    act(() => { vi.advanceTimersByTime(5000); });
    theirs.receive(remote.offer(Date.now()));

    expect(mine.result.current.ringingOffer?.ts).toBe(first);
    expect(theirs.result.current.callState).toBe("incoming");
    expect(mine.removeCallEventMessage).not.toHaveBeenCalled();
    expect(await answer(mine)).toMatchObject({ t: "a", o: first });
  });
});
