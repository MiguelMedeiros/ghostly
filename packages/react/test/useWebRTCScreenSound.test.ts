import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCREEN_WITH_SOUND } from "../src/screenCapture";
import { FakeMediaStream, FakePeerConnection, FakeTrack, installWebRTCFakes, remote, type FakeMediaDevices } from "./fakes";
import { renderCall, settle } from "./harness";

// covers: calls.screen-share

/**
 * A shared screen's sound in a 1:1 call: the call has one audio section, so the screen's sound (a tab's, or the
 * system's) is mixed with the voice through Web Audio and that mix goes on the audio sender in place of the
 * microphone, with no new offer. Stopping the share puts the microphone back. A browser that gives no sound, or a
 * page with no Web Audio, shares the picture alone and says so.
 */

/** A node of the fake Web Audio graph: which track it reads, and whether it is wired to the mix. */
interface FakeSource { track: FakeTrack; connected: boolean }

/** Web Audio's AudioContext, as far as `mixWithWebAudio` uses it: every source it made, and its one destination. */
class FakeAudioContext {
  static contexts: FakeAudioContext[] = [];
  readonly sources: FakeSource[] = [];
  readonly out = new FakeTrack("audio");
  state: "running" | "closed" = "running";
  readonly resume = vi.fn(async () => {});
  readonly close = vi.fn(async () => { this.state = "closed"; });
  constructor() { FakeAudioContext.contexts.push(this); }
  createMediaStreamDestination() { return { stream: new FakeMediaStream([this.out]) }; }
  createMediaStreamSource(stream: FakeMediaStream) {
    const source: FakeSource = { track: stream.getAudioTracks()[0], connected: false };
    this.sources.push(source);
    return { connect: () => { source.connected = true; }, disconnect: () => { source.connected = false; } };
  }
  /** The tracks heard in the mix now. */
  heard() { return this.sources.filter((s) => s.connected).map((s) => s.track); }
}

let devices: FakeMediaDevices;
let uninstall: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
  ({ devices, uninstall } = installWebRTCFakes());
  FakeAudioContext.contexts = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

/** A voice call we placed, answered and connected: its microphone, and the audio section's sender. */
async function connectedCall() {
  const call = renderCall();
  act(() => { void call.result.current.startCall(false); });
  const mic = devices.userMedia[0].grant().getAudioTracks()[0];
  await settle();
  const pc = FakePeerConnection.instances[0];
  call.receive(remote.answer(Date.now() + 1));
  await settle();
  act(() => pc.setIceState("connected"));
  const audio = pc.getTransceivers().find((t) => t.receiver.track.kind === "audio")!.sender;
  return { call, mic, audio };
}

/** Presses the share button and answers the picker with a screen, and its sound when the constraints ask for it. */
async function share(call: ReturnType<typeof renderCall>) {
  act(() => { void call.result.current.toggleScreenShare(); });
  const shared = devices.displayMedia[devices.displayMedia.length - 1].grant();
  await settle();
  return { screen: shared.getVideoTracks()[0], sound: shared.getAudioTracks()[0] };
}

describe("a shared screen's sound in a 1:1 call", () => {
  it("is mixed with the voice on the call's audio section: no new offer, the self-view keeps the microphone", async () => {
    const { call, mic, audio } = await connectedCall();
    const { screen, sound } = await share(call);

    expect(devices.getDisplayMedia).toHaveBeenCalledExactlyOnceWith(SCREEN_WITH_SOUND);
    const [context] = FakeAudioContext.contexts;
    expect(context.heard()).toEqual([mic, sound]);
    expect(audio.replaceTrack).toHaveBeenLastCalledWith(context.out);
    expect(call.result.current).toMatchObject({ isScreenSharing: true, screenSound: true });
    expect(call.result.current.localStream!.getTracks()).toEqual([mic, screen]);
    expect(call.publishedKinds()).toEqual(["o", "v"]);
    expect(FakePeerConnection.instances).toHaveLength(1);

    // Muting silences the microphone in the mix; the screen's sound goes on.
    act(() => call.result.current.toggleMute());
    expect(mic.enabled).toBe(false);
    expect(sound.readyState).toBe("live");
    expect(audio.track).toBe(context.out);
  });

  it.each([
    ["the button", async (call: ReturnType<typeof renderCall>) => { await act(() => call.result.current.toggleScreenShare()); }],
    ["the browser's Stop sharing", async (_: ReturnType<typeof renderCall>, screen: FakeTrack) => { screen.readyState = "ended"; act(() => screen.onended?.()); await settle(); }],
  ] as const)("stopping from %s puts the microphone back and lets the sound and its mix go", async (_, stop) => {
    const { call, mic, audio } = await connectedCall();
    const { screen, sound } = await share(call);
    const [context] = FakeAudioContext.contexts;

    await stop(call, screen);

    expect(audio.replaceTrack).toHaveBeenLastCalledWith(mic);
    expect(sound.readyState).toBe("ended");
    expect(context.out.readyState).toBe("ended");
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.heard()).toEqual([]);
    expect(mic.readyState).toBe("live");
    expect(call.result.current).toMatchObject({ isScreenSharing: false, screenSound: false });
    expect(devices.liveTracks()).toEqual([mic]);
  });

  it("hanging up while sharing lets the sound and its mix go with the rest", async () => {
    const { call } = await connectedCall();
    await share(call);
    const [context] = FakeAudioContext.contexts;

    act(() => call.result.current.hangUp());

    expect(devices.liveTracks()).toEqual([]);
    expect(context.close).toHaveBeenCalledOnce();
    expect(call.result.current.screenSound).toBe(false);
  });

  it("another microphone picked while sharing goes into the mix, which stays on the sender", async () => {
    const { call, mic, audio } = await connectedCall();
    const { sound } = await share(call);
    const [context] = FakeAudioContext.contexts;

    act(() => { void call.result.current.switchMicrophone(null); });
    const next = devices.userMedia[devices.userMedia.length - 1].grant().getAudioTracks()[0];
    await settle();

    expect(context.heard()).toEqual([sound, next]);
    expect(audio.track).toBe(context.out);
    expect(mic.readyState).toBe("ended");
    // and stopping the share puts the new one back
    await act(() => call.result.current.toggleScreenShare());
    expect(audio.replaceTrack).toHaveBeenLastCalledWith(next);
  });

  it("a share the browser gave no sound goes as the picture alone, the microphone untouched, and says so", async () => {
    const { call, mic, audio } = await connectedCall();
    devices.getDisplayMedia.mockImplementationOnce(async () => new FakeMediaStream([new FakeTrack("video")]) as unknown as MediaStream);
    act(() => { void call.result.current.toggleScreenShare(); });
    await settle();

    expect(call.result.current).toMatchObject({ isScreenSharing: true, screenSound: false });
    expect(audio.track).toBe(mic);
    expect(FakeAudioContext.contexts).toEqual([]);
  });

  it("a page with no Web Audio shares the picture alone and lets the sound go", async () => {
    vi.stubGlobal("AudioContext", undefined);
    const { call, mic, audio } = await connectedCall();
    const { sound } = await share(call);

    expect(call.result.current).toMatchObject({ isScreenSharing: true, screenSound: false });
    expect(sound.readyState).toBe("ended");
    expect(audio.track).toBe(mic);
    expect(call.onError).not.toHaveBeenCalled();
  });
});
