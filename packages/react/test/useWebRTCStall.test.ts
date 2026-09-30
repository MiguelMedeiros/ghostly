import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";
import { CallUnreachableError, CONNECT_TIMEOUT_MS, GATHER_ATTEMPTS, GATHER_STALL_MS } from "../src/useWebRTC";

// covers: calls.audio

/**
 * e2e-full 36677963444: the extension answering a call made a connection whose ICE gathering never found a single
 * candidate. Its answer went out with none after the 10 s cap, the caller had nothing to try, the answerer tried
 * nothing, and neither side's ICE could ever fail: both windows said "Connecting..." for good.
 */

let devices: FakeMediaDevices;
let uninstall: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T08:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

const candidates = (signal: string | null) => (JSON.parse(signal!) as { c: string[] }).c;

async function answering(call: ReturnType<typeof renderCall>) {
  call.receive(remote.offer(Date.now()));
  act(() => { void call.result.current.acceptCall(false); });
  const stream = devices.userMedia[0].grant();
  await settle();
  return stream;
}

async function calling(call: ReturnType<typeof renderCall>) {
  act(() => { void call.result.current.startCall(false); });
  const stream = devices.userMedia[0].grant();
  await settle();
  return stream;
}

/** One stalled connection's wait, and what follows it. */
async function stallPasses() {
  await act(async () => { await vi.advanceTimersByTimeAsync(GATHER_STALL_MS); });
  await settle();
}

describe("a connection that finds no candidate", () => {
  it("the answerer makes a new connection in place of the stalled one, and answers with its candidates", async () => {
    FakePeerConnection.stallGathering = 1;
    const call = renderCall();
    await answering(call);
    // Nothing goes out while the first connection gathers in vain.
    expect(call.published).toEqual([]);

    await stallPasses();

    const [stalled, fresh] = FakePeerConnection.instances;
    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(stalled.close).toHaveBeenCalledOnce();
    expect(fresh.closed).toBe(false);
    expect(fresh.remoteDescription?.type).toBe("offer");
    expect(call.publishedKinds()).toEqual(["a"]);
    expect(candidates(call.published[0])).toHaveLength(2);
    expect(call.result.current.callState).toBe("connecting");
    // The closed one says nothing more; the new one connects the call.
    act(() => stalled.setIceState("closed"));
    expect(call.result.current.callState).toBe("connecting");
    act(() => fresh.setIceState("connected"));
    expect(call.result.current.callState).toBe("connected");
  });

  it("the caller does the same before it offers", async () => {
    FakePeerConnection.stallGathering = 1;
    const call = renderCall();
    await calling(call);
    expect(call.published).toEqual([]);

    await stallPasses();

    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(FakePeerConnection.instances[0].close).toHaveBeenCalledOnce();
    expect(call.publishedKinds()).toEqual(["o"]);
    expect(candidates(call.published[0])).toHaveLength(2);
    expect(call.result.current.callState).toBe("offering");
  });

  it("an answerer none of whose connections finds a candidate ends the call and tells the caller", async () => {
    FakePeerConnection.stallGathering = GATHER_ATTEMPTS;
    const call = renderCall();
    const stream = await answering(call);

    for (let i = 0; i < GATHER_ATTEMPTS; i++) await stallPasses();

    expect(FakePeerConnection.instances).toHaveLength(GATHER_ATTEMPTS);
    expect(FakePeerConnection.instances.every((pc) => pc.closed)).toBe(true);
    expect(call.onError).toHaveBeenCalledWith(expect.any(CallUnreachableError));
    expect(call.result.current.callState).toBe("idle");
    expect(call.publishedKinds()).toEqual(["h"]);
    expect(stream.getTracks().every((t) => t.stop.mock.calls.length > 0)).toBe(true);
  });

  it("a caller none of whose connections finds a candidate ends the call without offering", async () => {
    FakePeerConnection.stallGathering = GATHER_ATTEMPTS;
    const call = renderCall();
    await calling(call);

    for (let i = 0; i < GATHER_ATTEMPTS; i++) await stallPasses();

    expect(call.onError).toHaveBeenCalledWith(expect.any(CallUnreachableError));
    expect(call.result.current.callState).toBe("idle");
    expect(call.published).toEqual([]);
  });

  it("a hang-up while a stalled connection gathers makes no new one", async () => {
    FakePeerConnection.stallGathering = 1;
    const call = renderCall();
    await calling(call);
    act(() => call.result.current.hangUp());

    await stallPasses();

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(call.onError).not.toHaveBeenCalled();
    expect(call.result.current.callState).toBe("idle");
  });
});

describe("a call that neither connects nor fails", () => {
  it("the answerer ends it after CONNECT_TIMEOUT_MS and tells the caller", async () => {
    const call = renderCall();
    await answering(call);
    expect(call.result.current.callState).toBe("connecting");

    act(() => { vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1); });
    expect(call.result.current.callState).toBe("connecting");
    act(() => { vi.advanceTimersByTime(1); });

    expect(call.result.current.callState).toBe("idle");
    expect(call.onError).toHaveBeenCalledWith(expect.any(CallUnreachableError));
    expect(call.publishedKinds()).toEqual(["a", "h"]);
    // It never connected: no "call ended" line with a length.
    expect(call.addCallEventMessage).not.toHaveBeenCalledWith("call_ended", expect.anything(), expect.anything());
  });

  it("the caller ends it too, once the answer came", async () => {
    const call = renderCall();
    await calling(call);
    const pc = FakePeerConnection.instances[0];
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    expect(call.result.current.callState).toBe("connecting");

    act(() => { vi.advanceTimersByTime(CONNECT_TIMEOUT_MS); });

    expect(pc.close).toHaveBeenCalled();
    expect(call.result.current.callState).toBe("idle");
    expect(call.publishedKinds()).toEqual(["o", "h"]);
  });

  it("a call that connected in time is left alone", async () => {
    const call = renderCall();
    await calling(call);
    const pc = FakePeerConnection.instances[0];
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => pc.setIceState("connected"));

    act(() => { vi.advanceTimersByTime(CONNECT_TIMEOUT_MS * 2); });

    expect(call.result.current.callState).toBe("connected");
    expect(call.onError).not.toHaveBeenCalled();
  });
});
