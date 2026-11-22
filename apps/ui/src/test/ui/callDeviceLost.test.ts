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

const devices = (cameras: string[], mics: string[]): DeviceList => ({
  audioinput: mics.map((id) => ({ id, label: `Mic ${id}` })),
  videoinput: cameras.map((id) => ({ id, label: `Camera ${id}` })),
  audiooutput: [],
  defaults: {},
  named: true,
});

const track = (id: string, label: string) =>
  ({ readyState: "live", label, enabled: true, getSettings: () => ({ deviceId: id }), addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaStreamTrack & { readyState: string };

/** A call using microphone `m1` and camera `c1`; `noOther`: the default cannot be opened once they go. */
function call(noOther: boolean) {
  const mic = track("m1", "Mic m1");
  const camera = track("c1", "Camera c1");
  const refused = () => Promise.reject(Object.assign(new Error("Requested device not found"), { name: "NotFoundError" }));
  const webrtc = {
    callState: "connected",
    localStream: { getAudioTracks: () => [mic], getVideoTracks: () => [camera] } as unknown as MediaStream,
    isVideoOff: false,
    isScreenSharing: false,
    canSwitchDevices: true,
    switchMicrophone: vi.fn(noOther ? refused : () => Promise.resolve()),
    switchCamera: vi.fn(noOther ? refused : () => Promise.resolve()),
  };
  return { webrtc, mic, camera };
}

/** Renders the call's devices with `before`, then unplugs to `after` and lets the device check run. */
async function unplug(webrtc: ReturnType<typeof call>["webrtc"], before: DeviceList, after: DeviceList) {
  let changed = () => {};
  vi.mocked(watchDevices).mockImplementation((fn) => {
    changed = fn;
    return () => {};
  });
  vi.mocked(listDevices).mockResolvedValue(before);
  const hook = renderHook(() => useCallDevices(webrtc));
  await act(async () => {});
  vi.mocked(listDevices).mockResolvedValue(after);
  await act(async () => changed());
  await act(async () => {});
  return hook;
}

describe("a call's device unplugged mid-call", () => {
  afterEach(() => vi.clearAllMocks());

  it("says the default took over when it did", async () => {
    const { webrtc, camera } = call(false);
    camera.readyState = "ended";
    const { result } = await unplug(webrtc, devices(["c1", "c2"], ["m1"]), devices(["c2"], ["m1"]));
    expect(webrtc.switchCamera).toHaveBeenCalledWith(null);
    expect(result.current?.notice).toMatchObject({ kind: "videoinput", type: "lost", name: "Camera c1" });
  });

  it("does not say the default took over when the only camera went", async () => {
    const { webrtc, camera } = call(true);
    camera.readyState = "ended";
    const { result } = await unplug(webrtc, devices(["c1"], ["m1"]), devices([], ["m1"]));
    expect(webrtc.switchCamera).toHaveBeenCalledWith(null);
    expect(result.current?.notice).toMatchObject({ kind: "videoinput", type: "gone", name: "Camera c1" });
  });

  it("falls back from the camera and the microphone of one webcam that went together", async () => {
    const { webrtc, mic, camera } = call(false);
    mic.readyState = "ended";
    camera.readyState = "ended";
    const { result } = await unplug(webrtc, devices(["c1", "c2"], ["m1", "m2"]), devices(["c2"], ["m2"]));
    expect(webrtc.switchMicrophone).toHaveBeenCalledWith(null);
    expect(webrtc.switchCamera).toHaveBeenCalledWith(null);
    expect(result.current?.notice).toMatchObject({ kind: "audioinput", type: "lost", name: "Mic m1" });
  });

  it("plays on the default when a headset's microphone and speaker went together", async () => {
    localStorage.setItem("ghostly_media_devices", JSON.stringify({ audiooutput: { id: "s1", label: "Headset" } }));
    // An engine that can pick a speaker (Chromium).
    const proto = HTMLMediaElement.prototype as { setSinkId?: unknown };
    const had = Object.prototype.hasOwnProperty.call(proto, "setSinkId");
    if (!had) proto.setSinkId = () => Promise.resolve();
    try {
      const { webrtc, mic } = call(false);
      mic.readyState = "ended";
      const withSpeakers = (list: DeviceList, speakers: string[]): DeviceList => ({ ...list, audiooutput: speakers.map((id) => ({ id, label: id === "s1" ? "Headset" : `Speaker ${id}` })) });
      const { result } = await unplug(webrtc, withSpeakers(devices(["c1"], ["m1", "m2"]), ["s1", "s2"]), withSpeakers(devices(["c1"], ["m2"]), ["s2"]));
      expect(webrtc.switchMicrophone).toHaveBeenCalledWith(null);
      expect(result.current?.speaker).toBeUndefined();
      expect(result.current?.notice).toMatchObject({ kind: "audioinput", type: "lost", name: "Mic m1" });
    } finally {
      if (!had) delete proto.setSinkId;
      localStorage.clear();
    }
  });

  it("does not say the default took over when the only microphone went", async () => {
    const { webrtc, mic } = call(true);
    mic.readyState = "ended";
    const { result } = await unplug(webrtc, devices(["c1"], ["m1"]), devices(["c1"], []));
    expect(webrtc.switchMicrophone).toHaveBeenCalledWith(null);
    expect(result.current?.notice).toMatchObject({ kind: "audioinput", type: "gone", name: "Mic m1" });
  });
});
