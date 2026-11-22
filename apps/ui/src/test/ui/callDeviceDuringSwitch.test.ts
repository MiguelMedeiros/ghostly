import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listDevices, watchDevices, type DeviceList } from "../../lib/mediaDevices";
import { useCallDevices } from "../../hooks/useCallDevices";

// covers: calls.devices

vi.mock("../../lib/mediaDevices", async (actual) => ({
  ...(await actual<typeof import("../../lib/mediaDevices")>()),
  listDevices: vi.fn(),
  watchDevices: vi.fn(),
}));

const mics = (...ids: string[]): DeviceList => ({
  audioinput: ids.map((id) => ({ id, label: `Mic ${id}` })),
  videoinput: [],
  audiooutput: [],
  defaults: {},
  named: true,
});

const track = (id: string) =>
  ({ readyState: "live", label: `Mic ${id}`, enabled: true, getSettings: () => ({ deviceId: id }), addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaStreamTrack;

const stream = (id: string) => ({ getAudioTracks: () => [track(id)], getVideoTracks: () => [] }) as unknown as MediaStream;

/** A switch the test lets end: the call's stream changes first (as `useWebRTC` sets it), then the promise settles. */
function pending() {
  let end = () => {};
  const promise = new Promise<void>((resolve) => { end = resolve; });
  return { promise, end: () => end() };
}

/** An audio call on microphone `m0`; its switches wait for `switches`, in turn. */
function audioCall(switches: ReturnType<typeof pending>[]) {
  let devicesChanged = () => {};
  vi.mocked(watchDevices).mockImplementation((fn) => {
    devicesChanged = fn;
    return () => {};
  });
  vi.mocked(listDevices).mockResolvedValue(mics("m0", "m1"));
  const webrtc = {
    callState: "connected",
    localStream: stream("m0"),
    isVideoOff: true,
    isScreenSharing: false,
    canSwitchDevices: true,
    switchMicrophone: vi.fn(() => switches.shift()?.promise ?? Promise.resolve()),
    switchCamera: vi.fn(() => Promise.resolve()),
  };
  const hook = renderHook((props: typeof webrtc) => useCallDevices(props), { initialProps: webrtc });
  /** The page sees the devices change to `list`. */
  const plug = async (list: DeviceList) => {
    vi.mocked(listDevices).mockResolvedValue(list);
    await act(async () => devicesChanged());
  };
  /** The switch under way ends on microphone `id`. */
  const switched = async (id: string, which: ReturnType<typeof pending>) => {
    webrtc.localStream = stream(id);
    hook.rerender({ ...webrtc });
    await act(async () => which.end());
    await act(async () => {});
  };
  return { webrtc, hook, plug, switched };
}

describe("a call's device plugged or unplugged while the call switches microphone", () => {
  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("says the microphone just chosen went, when it went during the switch to it", async () => {
    const toM1 = pending();
    const { webrtc, hook, plug, switched } = audioCall([toM1]);
    await act(async () => {});
    act(() => hook.result.current!.choose("audioinput", "m1"));
    expect(webrtc.switchMicrophone).toHaveBeenCalledWith("m1");

    await plug(mics("m0"));
    await switched("m1", toM1);

    expect(webrtc.switchMicrophone).toHaveBeenLastCalledWith(null);
    expect(hook.result.current?.notice).toMatchObject({ kind: "audioinput", type: "lost", name: "Mic m1" });
  });

  it("offers the chosen microphone back, when it came back during the fall back to the default", async () => {
    const toM1 = pending(), toDefault = pending();
    const { webrtc, hook, plug, switched } = audioCall([toM1, toDefault]);
    await act(async () => {});
    act(() => hook.result.current!.choose("audioinput", "m1"));
    await switched("m1", toM1);

    await plug(mics("m0"));
    expect(webrtc.switchMicrophone).toHaveBeenLastCalledWith(null);
    expect(hook.result.current?.notice).toMatchObject({ type: "lost", name: "Mic m1" });

    await plug(mics("m0", "m1"));
    await switched("m0", toDefault);

    expect(hook.result.current?.notice).toMatchObject({ kind: "audioinput", type: "back", name: "Mic m1", id: "m1" });
  });
});
