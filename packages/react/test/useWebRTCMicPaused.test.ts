import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePeerConnection, installWebRTCFakes, remote, type FakeMediaDevices, type FakeTrack } from "./fakes";
import { renderCall, settle } from "./harness";

// covers: calls.audio

/**
 * An iPhone mutes the microphone of a Home Screen web app while its screen is locked: the call stays up and the
 * contact hears silence. Miguel locked his phone in a call and "could not be heard any more", with nothing on either
 * side to say why. The call window says so (`micPaused`), the log has it, and hiding the page never ends the call.
 */

let devices: FakeMediaDevices;
let uninstall: () => void;
let traced: Record<string, unknown>[];
let visibility: DocumentVisibilityState;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
  traced = [];
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace = true;
  vi.spyOn(console, "debug").mockImplementation((line: unknown) => {
    const text = String(line);
    if (text.startsWith("[ghostly:link] ")) traced.push(JSON.parse(text.slice("[ghostly:link] ".length)) as Record<string, unknown>);
  });
});

afterEach(() => {
  delete (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace;
  vi.restoreAllMocks();
  uninstall();
  vi.useRealTimers();
});

const steps = (step: string) => traced.filter((line) => line.step === step).map(({ mic, page }) => ({ mic, page }));

/** Locks or unlocks the phone: the page goes out of sight or comes back. */
function show(state: DocumentVisibilityState) {
  visibility = state;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

/** A call we placed, answered and connected, and its microphone's track. */
async function connected() {
  const call = renderCall();
  act(() => { void call.result.current.startCall(false); });
  const stream = devices.userMedia[0].grant();
  await settle();
  const pc = FakePeerConnection.instances[0];
  call.receive(remote.answer(Date.now() + 1));
  await settle();
  act(() => pc.setIceState("connected"));
  return { call, mic: stream.getAudioTracks()[0] as FakeTrack };
}

describe("the system pauses the microphone in a call", () => {
  it("the call says so while it lasts, and stays on", async () => {
    const { call, mic } = await connected();
    expect(call.result.current.micPaused).toBe(false);

    show("hidden");
    act(() => mic.pause());
    expect(call.result.current.micPaused).toBe(true);
    expect(call.result.current.callState).toBe("connected");

    act(() => mic.resume());
    show("visible");
    expect(call.result.current.micPaused).toBe(false);
    expect(call.result.current.callState).toBe("connected");
    // Nothing was said to the contact: no hang-up.
    expect(call.publishedKinds()).not.toContain("h");
    expect(traced.filter((line) => line.step === "call-end")).toEqual([]);
  });

  it("the log has the page going out of sight and the microphone paused and back", async () => {
    const { mic } = await connected();
    show("hidden");
    act(() => mic.pause());
    act(() => mic.resume());
    show("visible");
    expect(steps("call-page")).toEqual([{ mic: "live", page: "hidden" }, { mic: "live", page: "visible" }]);
    expect(steps("call-mic")).toEqual([{ mic: "paused", page: "hidden" }, { mic: "resumed", page: "hidden" }]);
  });

  it("a microphone already paused when it was captured counts from the start", async () => {
    const call = renderCall();
    act(() => { void call.result.current.startCall(false); });
    const request = devices.userMedia[0];
    const stream = request.grant();
    (stream.getAudioTracks()[0] as FakeTrack).muted = true;
    await settle();
    expect(call.result.current.micPaused).toBe(true);
  });

  it("the person's own mute is not a pause", async () => {
    const { call } = await connected();
    act(() => call.result.current.toggleMute());
    expect(call.result.current.isMuted).toBe(true);
    expect(call.result.current.micPaused).toBe(false);
  });

  it("ends with the call, and a later call starts unpaused", async () => {
    const { call, mic } = await connected();
    act(() => mic.pause());
    expect(call.result.current.micPaused).toBe(true);
    act(() => call.result.current.hangUp());
    expect(call.result.current.micPaused).toBe(false);
    // Out of a call, the page going out of sight is not logged as a call's.
    show("hidden");
    expect(steps("call-page")).toEqual([]);
  });
});
