import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallOverlay } from "../../components/CallOverlay";
import { DEVICE_NOTICE_MS, useCallDevices } from "../../hooks/useCallDevices";
import { chooseDevice, listDevices, watchDevices, type DeviceList } from "../../lib/mediaDevices";
import { AppProviders } from "../render";

// covers: calls.devices

/**
 * The call's "… is back · Switch back" notice is the one offer to go back to the chosen device, and it closed after
 * 10 s on a timer nothing paused: with the keyboard focus on Switch back (a screen reader reaches it by Tab), or the
 * pointer over it, it went mid-way and took the offer with it. Its time stops while the focus or the pointer is on
 * it, and starts again, whole, when they leave.
 */

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

const track = { readyState: "live", label: "Default", enabled: true, getSettings: () => ({ deviceId: "default" }), addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaStreamTrack;
const webrtc = {
  callState: "connected",
  localStream: { getAudioTracks: () => [track], getVideoTracks: () => [] } as unknown as MediaStream,
  isVideoOff: true,
  isScreenSharing: false,
  canSwitchDevices: true,
  switchMicrophone: vi.fn(() => Promise.resolve()),
  switchCamera: vi.fn(() => Promise.resolve()),
};

function Call() {
  const devices = useCallDevices(webrtc);
  return (
    <CallOverlay callState="connected" localStream={null} remoteStream={null} isMuted={false} isVideoOff remoteHasVideo={false}
      callStartedAt={Date.now()} peerName="Ana" onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()} devices={devices} />
  );
}

/** The devices changed (`watchDevices`). */
let changed = () => {};

/** A call that began on the default with the chosen microphone missing, then the chosen one plugged in: "Mic m1 is back". */
async function back() {
  vi.mocked(watchDevices).mockImplementation((fn) => {
    changed = fn;
    return () => {};
  });
  vi.mocked(listDevices).mockResolvedValue(mics("default"));
  render(<AppProviders><Call /></AppProviders>);
  await act(async () => {});
  vi.mocked(listDevices).mockResolvedValue(mics("default", "m1"));
  await act(async () => changed());
  await act(async () => {});
  expect(screen.getByTestId("call-device-notice")).toHaveAttribute("data-type", "back");
}

const pass = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const notice = () => screen.queryByTestId("call-device-notice");

describe("the call's Switch back notice, with the focus or the pointer on it", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    chooseDevice("audioinput", { id: "m1", label: "Mic m1" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
    (track as { readyState: string }).readyState = "live";
  });

  it("still closes by itself when nothing is on it", async () => {
    await back();
    await pass(DEVICE_NOTICE_MS);
    expect(notice()).toBeNull();
  });

  it("stays while the keyboard focus is on Switch back, and runs out a whole time after it leaves", async () => {
    await back();
    await pass(DEVICE_NOTICE_MS - 3_000);
    act(() => screen.getByTestId("call-device-switch-back").focus());
    await pass(DEVICE_NOTICE_MS * 3);
    expect(notice(), "focus on Switch back").not.toBeNull();
    // From Switch back to its close button: still inside.
    act(() => screen.getByRole("button", { name: "Close" }).focus());
    await pass(DEVICE_NOTICE_MS * 3);
    expect(notice(), "focus on its close button").not.toBeNull();
    act(() => screen.getByTestId("call-mute").focus());
    await pass(DEVICE_NOTICE_MS - 1);
    expect(notice()).not.toBeNull();
    await pass(1);
    expect(notice()).toBeNull();
  });

  it("stays while the pointer is over it", async () => {
    await back();
    fireEvent.pointerEnter(notice()!);
    await pass(DEVICE_NOTICE_MS * 3);
    expect(notice()).not.toBeNull();
    fireEvent.pointerLeave(notice()!);
    await pass(DEVICE_NOTICE_MS);
    expect(notice()).toBeNull();
  });

  it("runs out when Switch back leaves under the focus because another notice took its place", async () => {
    await back();
    act(() => screen.getByTestId("call-device-switch-back").focus());
    // The microphone the call now uses goes: "… was disconnected" takes the place of "… is back", with no Switch back,
    // and the focus goes to the call's Devices with no blur from the button that left.
    (track as { readyState: string }).readyState = "ended";
    await act(async () => changed());
    await act(async () => {});
    expect(notice()).toHaveAttribute("data-type", "lost");
    expect(screen.queryByTestId("call-device-switch-back")).toBeNull();
    await pass(DEVICE_NOTICE_MS);
    expect(notice()).toBeNull();
  });

  it("stays while either one is still on it", async () => {
    await back();
    act(() => screen.getByTestId("call-device-switch-back").focus());
    fireEvent.pointerEnter(notice()!);
    fireEvent.pointerLeave(notice()!);
    await pass(DEVICE_NOTICE_MS * 2);
    expect(notice()).not.toBeNull();
  });
});
