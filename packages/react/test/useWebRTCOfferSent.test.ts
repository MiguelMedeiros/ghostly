import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";

// covers: calls.audio, calls.cancel, calls.media-blocked

// The caller's ringback says the contact's device rings. `offering` starts before the microphone or camera prompt,
// which may stay open a minute, and nothing rings there until the offer goes out: `offerSent` is that moment, the same
// one RING_MS counts from, and it is this call's alone.

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

const denied = () => new DOMException("Permission denied", "NotAllowedError");
const theirOffer = (ts: number) => remote.offer(ts);

describe("offerSent: our call rings the contact from its offer", () => {
  it("is false while the microphone prompt is open, and true once the offer is published", async () => {
    const call = renderCall();
    expect(call.result.current.offerSent).toBe(false);

    act(() => { void call.result.current.startCall(false); });
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(call.result.current.callState).toBe("offering");
    expect(call.published).toEqual([]);
    expect(call.result.current.offerSent).toBe(false);

    devices.userMedia[0].grant();
    await settle();
    expect(call.publishedKinds()).toEqual(["o"]);
    expect(call.result.current.callState).toBe("offering");
    expect(call.result.current.offerSent).toBe(true);
  });

  it("stays false for a call hung up while the prompt is open, even when the prompt is allowed after", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    act(() => call.result.current.hangUp());
    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.offerSent).toBe(false);

    devices.userMedia[0].grant();
    await settle();
    expect(call.result.current.offerSent).toBe(false);
  });

  it("stays false for a call whose prompt is denied", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    devices.userMedia[0].deny(denied());
    await settle();
    expect(call.result.current.callState).toBe("idle");
    expect(call.result.current.offerSent).toBe(false);
  });

  it("goes back to false when our call yields a glare to the contact's earlier offer, and for the next call's prompt", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    devices.userMedia[0].grant();
    await settle();
    expect(call.result.current.offerSent).toBe(true);
    const mine = JSON.parse(call.published[0]!) as { ts: number };

    call.receive(theirOffer(mine.ts - 1));
    expect(call.result.current.callState).toBe("incoming");
    expect(call.result.current.offerSent).toBe(false);

    // Declined; our next call waits for its prompt again, and does not ring back yet.
    act(() => call.result.current.rejectCall());
    expect(call.result.current.callState).toBe("idle");
    act(() => { vi.advanceTimersByTime(10_000); });
    act(() => { void call.result.current.startCall(false); });
    expect(call.result.current.callState).toBe("offering");
    expect(call.result.current.offerSent).toBe(false);
  });

  it("goes back to false once the contact answers, and after the call ends", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    devices.userMedia[0].grant();
    await settle();
    const mine = JSON.parse(call.published[0]!) as { ts: number };

    call.receive(remote.answer(mine.ts + 1));
    await settle();
    expect(call.result.current.callState).toBe("connecting");
    expect(call.result.current.offerSent).toBe(false);

    act(() => call.result.current.hangUp());
    expect(call.result.current.offerSent).toBe(false);
  });
});
