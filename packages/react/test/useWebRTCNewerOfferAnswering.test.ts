import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";

// covers: calls.audio, calls.video

// The contact's app died or reloaded as its call rang here and it calls again (WISP 601, "Ringing"), while Answer
// already waits on this side's microphone, or gathers: the answer that goes out answers their newer offer, the one
// their app has (one to the older offer rings out there to "No answer" and never connects here).

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

/** The answers `call` published, in order: the offer each answers. */
const answered = (call: ReturnType<typeof renderCall>) =>
  call.published
    .filter((signal): signal is string => signal !== null)
    .map((s) => JSON.parse(s) as { t: string; o?: number })
    .filter((signal) => signal.t === "a")
    .map((signal) => signal.o);

/** A call ringing in `call` since `first`, answered: Answer waits on the microphone. */
function ringAndAnswer(call: ReturnType<typeof renderCall>, first: number) {
  call.receive(remote.offer(first));
  act(() => { vi.advanceTimersByTime(5000); });
  act(() => { void call.result.current.acceptCall(false); });
  expect(call.result.current.callState).toBe("answering");
  act(() => { vi.advanceTimersByTime(2000); });
}

describe("a newer offer from the contact once Answer was pressed", () => {
  it("while the microphone is asked for: the answer answers it, under its own Incoming line", async () => {
    const call = renderCall();
    const first = Date.now();
    ringAndAnswer(call, first);
    const firstLine = call.addCallEventMessage.mock.results[0]!.value as string;
    const second = Date.now();
    call.receive(remote.offer(second, true));
    devices.userMedia[devices.userMedia.length - 1].grant();
    await settle();

    expect(answered(call)).toEqual([second]);
    expect(call.result.current.callState).toBe("connecting");
    expect(call.removeCallEventMessage).toHaveBeenCalledExactlyOnceWith(firstLine);
    expect(call.addCallEventMessage.mock.calls).toEqual([
      ["call_received", false, undefined, first],
      ["call_received", true, undefined, second],
    ]);
    // The newer offer's picture is the call's.
    expect(call.result.current.remoteHasVideo).toBe(true);
  });

  it("while the answer gathers: it is answered again, on a new connection", async () => {
    const call = renderCall();
    FakePeerConnection.holdGathering = true;
    ringAndAnswer(call, Date.now());
    devices.userMedia[devices.userMedia.length - 1].grant();
    await settle();
    expect(call.result.current.callState).toBe("answering");
    const second = Date.now();
    call.receive(remote.offer(second));
    FakePeerConnection.holdGathering = false;
    act(() => { FakePeerConnection.instances[0]!.finishGathering(); });
    await settle();

    const answers = answered(call);
    expect(answers[answers.length - 1]).toBe(second);
    expect(FakePeerConnection.instances[0]!.closed).toBe(true);
    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(FakePeerConnection.instances[1]!.remoteDescription).not.toBeNull();
    expect(call.result.current.callState).toBe("connecting");
  });

  it("an offer no newer than the one ringing changes nothing", async () => {
    const call = renderCall();
    const first = Date.now();
    ringAndAnswer(call, first);
    call.receive(JSON.stringify({ ...JSON.parse(remote.offer(first)), at: Date.now() }));
    devices.userMedia[devices.userMedia.length - 1].grant();
    await settle();

    expect(answered(call)).toEqual([first]);
    expect(call.removeCallEventMessage).not.toHaveBeenCalled();
  });
});
