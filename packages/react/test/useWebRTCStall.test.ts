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
    // The hang-up says why, so the caller's side says the same.
    expect(JSON.parse(call.published[0]!)).toMatchObject({ t: "h", r: "u" });
    expect(call.addCallEventMessage).toHaveBeenCalledWith("call_failed", false);
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
    expect(call.addCallEventMessage.mock.calls.map(([type]) => type)).toEqual(["call_started", "call_failed"]);
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
    expect(JSON.parse(call.published[1]!)).toMatchObject({ t: "h", r: "u" });
    // It never connected: no "call ended" line with a length, but one saying it could not connect.
    expect(call.addCallEventMessage).not.toHaveBeenCalledWith("call_ended", expect.anything(), expect.anything());
    expect(call.addCallEventMessage).toHaveBeenLastCalledWith("call_failed", false);
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
    expect(call.addCallEventMessage).toHaveBeenLastCalledWith("call_failed", false);
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

describe("a call that could not connect says so in the chat", () => {
  const unreachable = (ts: number) => JSON.stringify({ t: "h", ts, r: "u" });
  const lines = (call: ReturnType<typeof renderCall>) => call.addCallEventMessage.mock.calls.map(([type]) => type);

  it("a caller whose contact could not connect ends with the same line, and sends nothing back", async () => {
    const call = renderCall();
    await calling(call);
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    expect(call.result.current.callState).toBe("connecting");

    call.receive(unreachable(Date.now() + 2));
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(lines(call)).toEqual(["call_started", "call_failed"]);
    expect(call.publishedKinds()).toEqual(["o", null]);
  });

  it("a caller still ringing whose contact found no candidate for its answer says so too", async () => {
    const call = renderCall();
    await calling(call);
    expect(call.result.current.callState).toBe("offering");

    call.receive(unreachable(Date.now() + 1));
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(lines(call)).toEqual(["call_started", "call_failed"]);
  });

  it("a plain hang-up before the call connected adds no such line", async () => {
    const call = renderCall();
    await answering(call);
    call.receive(remote.hangUp(Date.now() + 1));
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(lines(call)).not.toContain("call_failed");
  });

  it("a call whose connection failed before it ever connected says it could not connect", async () => {
    const call = renderCall();
    await calling(call);
    const pc = FakePeerConnection.instances[0];
    call.receive(remote.answer(Date.now() + 1));
    await settle();

    act(() => pc.setIceState("failed"));

    expect(call.result.current.callState).toBe("idle");
    expect(lines(call)).toEqual(["call_started", "call_failed"]);
  });

  it("a connected call that drops ends as before, with its length and no failure line", async () => {
    const call = renderCall();
    await calling(call);
    const pc = FakePeerConnection.instances[0];
    call.receive(remote.answer(Date.now() + 1));
    await settle();
    act(() => pc.setIceState("connected"));
    call.receive(unreachable(Date.now() + 2));
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(lines(call)).toEqual(["call_started", "call_connected", "call_ended"]);
  });
});
