import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";
import { CONNECT_TIMEOUT_MS, GATHER_ATTEMPTS, GATHER_STALL_MS } from "../src/useWebRTC";

// covers: calls.no-path

/**
 * Behind a VPN that blocks UDP (or lets only TCP 443 out), a call's ICE finds no pair: it fails, or never connects.
 * The call then says why it could not connect (`noPath`), where a TURN server can be set; a call that connected, a
 * plain hang-up and a network with no candidates at all say nothing of the kind.
 */

let devices: FakeMediaDevices;
let uninstall: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T20:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

async function calling(call: ReturnType<typeof renderCall>) {
  act(() => { void call.result.current.startCall(false); });
  devices.userMedia[devices.userMedia.length - 1].grant();
  await settle();
}

async function answered(call: ReturnType<typeof renderCall>) {
  await calling(call);
  call.receive(remote.answer(Date.now() + 1));
  await settle();
  return FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
}

describe("a call that found no path to its contact", () => {
  it("whose ICE failed before it ever connected says so", async () => {
    const call = renderCall();
    const pc = await answered(call);
    expect(call.result.current.noPath).toBe(false);

    act(() => pc.setIceState("failed"));

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.noPath).toBe(true);
  });

  it("that neither connected nor failed in CONNECT_TIMEOUT_MS says so", async () => {
    const call = renderCall();
    await answered(call);

    act(() => { vi.advanceTimersByTime(CONNECT_TIMEOUT_MS); });

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.noPath).toBe(true);
  });

  it("whose contact's side could not connect says so", async () => {
    const call = renderCall();
    await answered(call);

    call.receive(JSON.stringify({ t: "h", ts: Date.now() + 2, r: "u" }));
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.noPath).toBe(true);
  });

  it("goes away when dismissed, and when the next call starts", async () => {
    const call = renderCall();
    const pc = await answered(call);
    act(() => pc.setIceState("failed"));
    expect(call.result.current.noPath).toBe(true);

    act(() => call.result.current.dismissNoPath());
    expect(call.result.current.noPath).toBe(false);

    const next = await answered(call);
    act(() => next.setIceState("failed"));
    expect(call.result.current.noPath).toBe(true);
    act(() => { void call.result.current.startCall(false); });
    expect(call.result.current.noPath).toBe(false);
  });
});

describe("a call that says nothing of a blocked path", () => {
  it("a connected call that drops", async () => {
    const call = renderCall();
    const pc = await answered(call);
    act(() => pc.setIceState("connected"));

    call.receive(JSON.stringify({ t: "h", ts: Date.now() + 2, r: "u" }));
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.noPath).toBe(false);
  });

  it("a plain hang-up before it connected", async () => {
    const call = renderCall();
    await answered(call);

    call.receive(remote.hangUp(Date.now() + 2));
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.noPath).toBe(false);
  });

  it("a caller whose contact hung up as unreachable before answering (its microphone refused, say)", async () => {
    const call = renderCall();
    await calling(call);
    expect(call.result.current.callState).toBe("offering");

    call.receive(JSON.stringify({ t: "h", ts: Date.now() + 1, r: "u" }));
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.noPath).toBe(false);
  });

  it("an answerer whose microphone was refused", async () => {
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { void call.result.current.acceptCall(false); });
    devices.userMedia[0].deny(new DOMException("Permission denied", "NotAllowedError"));
    await settle();

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.mediaProblem).toBe("denied");
    expect(call.result.current.noPath).toBe(false);
  });
});

describe("a call whose connections found no candidate at all", () => {
  // WebRTC gets nothing out of this network (a browser policy allowing proxied UDP only), though the chat is live.
  async function stalls() {
    for (let i = 0; i < GATHER_ATTEMPTS; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(GATHER_STALL_MS); });
      await settle();
    }
  }

  it("the caller says so", async () => {
    FakePeerConnection.stallGathering = GATHER_ATTEMPTS;
    const call = renderCall();
    await calling(call);
    await stalls();

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.noPath).toBe(true);
  });

  it("the answerer says so", async () => {
    FakePeerConnection.stallGathering = GATHER_ATTEMPTS;
    const call = renderCall();
    call.receive(remote.offer(Date.now()));
    act(() => { void call.result.current.acceptCall(false); });
    devices.userMedia[0].grant();
    await settle();
    await stalls();

    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.noPath).toBe(true);
  });
});
