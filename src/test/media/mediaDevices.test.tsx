import { act, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebRTC } from "@ghostly/react";
import { FakePeerConnection, device, installWebRTCFakes, remote, type FakeMediaDevices, type FakeTrack } from "../../../packages/react/test/fakes";
import { CallOverlay } from "../../components/CallOverlay";
import { MediaSettings } from "../../components/MediaSettings";
import { CameraCapture } from "../../components/composer/CameraCapture";
import { useCallDevices } from "../../hooks/useCallDevices";
import { chooseDevice, groupDevices, loadDeviceChoices, preferredDevice, resolveDevice } from "../../lib/mediaDevices";
import { setStorageProfile } from "../../lib/storage";
import { renderApp } from "../render";
import { choose, optionsOf } from "../select";

// covers: settings.media, calls.devices

let devices: FakeMediaDevices;
let uninstall: () => void;
const srcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");

const BUILT_IN = device("audioinput", "mic-builtin", "MacBook Pro Microphone");
const HEADSET = device("audioinput", "mic-headset", "AirPods");
const CAMERA = device("videoinput", "cam-builtin", "FaceTime HD Camera");
const USB_CAMERA = device("videoinput", "cam-usb", "Logitech C920");
const SPEAKERS = device("audiooutput", "out-builtin", "MacBook Pro Speakers");
const HEADPHONES = device("audiooutput", "out-headset", "AirPods");

/** Engines that can send sound to a chosen speaker have `setSinkId`; happy-dom has none. */
function speakerChoice() {
  const sinks: [HTMLMediaElement, string][] = [];
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
    configurable: true,
    value: vi.fn(async function (this: HTMLMediaElement, id: string) {
      sinks.push([this, id]);
      Object.defineProperty(this, "sinkId", { configurable: true, value: id });
    }),
  });
  return sinks;
}

beforeEach(() => {
  ({ devices, uninstall } = installWebRTCFakes());
  // happy-dom takes only its own MediaStream there; the fakes are not one.
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, get() { return this._src ?? null; }, set(value) { this._src = value; } });
  devices.devices = [device("audioinput", "default", "Default - MacBook Pro Microphone"), BUILT_IN, HEADSET, CAMERA, USB_CAMERA, SPEAKERS, HEADPHONES];
});

afterEach(() => {
  uninstall();
  delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", srcObject!);
  setStorageProfile("");
});

describe("the choices", () => {
  it("are this profile's: another profile keeps its own", () => {
    chooseDevice("audioinput", { id: "mic-headset", label: "AirPods" });
    setStorageProfile("work");
    expect(loadDeviceChoices()).toEqual({});
    chooseDevice("audioinput", { id: "mic-builtin", label: "MacBook Pro Microphone" });
    setStorageProfile("");
    expect(loadDeviceChoices().audioinput).toEqual({ id: "mic-headset", label: "AirPods" });
    expect(preferredDevice("audioinput")).toEqual({ ideal: "mic-headset" });
  });

  it("the default is no choice at all", () => {
    chooseDevice("audioinput", { id: "mic-headset", label: "AirPods" });
    chooseDevice("audioinput", null);
    expect(loadDeviceChoices()).toEqual({});
    expect(preferredDevice("audioinput")).toBeUndefined();
  });

  it("a device that is gone falls back to the default, and says which one", () => {
    const list = groupDevices([BUILT_IN, CAMERA]);
    expect(resolveDevice("audioinput", list, { audioinput: { id: "mic-headset", label: "AirPods" } })).toEqual({ missing: "AirPods" });
    expect(resolveDevice("audioinput", list, {})).toEqual({});
  });

  it("a device the browser gave a new id is found again by its name", () => {
    const list = groupDevices([device("audioinput", "new-id", "AirPods")]);
    expect(resolveDevice("audioinput", list, { audioinput: { id: "old-id", label: "AirPods" } })).toEqual({ id: "new-id" });
  });

  it("before the browser names its devices, the choice is kept as it is", () => {
    const list = groupDevices([device("audioinput", "", ""), device("videoinput", "", "")]);
    expect(list.named).toBe(false);
    expect(list.audioinput).toEqual([]);
    expect(resolveDevice("audioinput", list, { audioinput: { id: "mic-headset", label: "AirPods" } })).toEqual({ id: "mic-headset" });
  });

  it("the browser's own default entries are the default option, not devices of their own", () => {
    const list = groupDevices([device("audioinput", "default", "Default - AirPods"), device("audioinput", "communications", "Communications - AirPods"), HEADSET]);
    expect(list.audioinput).toEqual([{ id: "mic-headset", label: "AirPods" }]);
    expect(list.defaults.audioinput).toBe("Default - AirPods");
  });
});

describe("Settings → Audio & video", () => {
  it("lists the microphones, cameras and speakers, the default first", async () => {
    speakerChoice();
    const { user } = renderApp(<MediaSettings />);

    const mic = await screen.findByTestId("settings-microphone");
    await waitFor(async () => expect((await optionsOf(user, mic)).length).toBe(3));
    expect((await optionsOf(user, mic)).map((o) => [o.value, o.label, o.description])).toEqual([
      ["", "System default", "Default - MacBook Pro Microphone"],
      ["mic-builtin", "MacBook Pro Microphone", undefined],
      ["mic-headset", "AirPods", undefined],
    ]);
    expect((await optionsOf(user, screen.getByTestId("settings-camera"))).map((o) => o.label)).toEqual(["System default", "FaceTime HD Camera", "Logitech C920"]);
    expect((await optionsOf(user, screen.getByTestId("settings-speaker"))).map((o) => o.label)).toEqual(["System default", "MacBook Pro Speakers", "AirPods"]);
    expect(screen.queryByTestId("settings-media-allow")).toBeNull();
  });

  it("remembers the choice, by id and name", async () => {
    const { user } = renderApp(<MediaSettings />);
    const mic = await screen.findByTestId("settings-microphone");
    await waitFor(() => expect(devices.enumerateDevices).toHaveBeenCalled());

    await choose(user, mic, "mic-headset");
    expect(loadDeviceChoices().audioinput).toEqual({ id: "mic-headset", label: "AirPods" });
    expect(mic).toHaveAttribute("data-value", "mic-headset");

    await choose(user, mic, "");
    expect(loadDeviceChoices().audioinput).toBeUndefined();
  });

  it("says when the chosen one is not connected, and shows the default", async () => {
    chooseDevice("audioinput", { id: "mic-usb", label: "Blue Yeti" });
    renderApp(<MediaSettings />);
    expect(await screen.findByTestId("settings-microphone-missing")).toHaveTextContent("Blue Yeti is not connected. Using the default.");
    expect(screen.getByTestId("settings-microphone")).toHaveAttribute("data-value", "");
  });

  it("follows a headset plugged in", async () => {
    chooseDevice("audioinput", { id: "mic-usb", label: "Blue Yeti" });
    renderApp(<MediaSettings />);
    await screen.findByTestId("settings-microphone-missing");

    act(() => devices.plug(device("audioinput", "mic-usb", "Blue Yeti")));
    await waitFor(() => expect(screen.queryByTestId("settings-microphone-missing")).toBeNull());
    expect(screen.getByTestId("settings-microphone")).toHaveAttribute("data-value", "mic-usb");
  });

  it("asks for nothing until a button is pressed; names come with Allow", async () => {
    devices.devices = [device("audioinput", "", ""), device("videoinput", "", "")];
    const { user } = renderApp(<MediaSettings />);
    const allow = await screen.findByTestId("settings-media-allow");
    expect(devices.getUserMedia).not.toHaveBeenCalled();

    const named = [BUILT_IN, HEADSET, CAMERA];
    devices.enumerateDevices.mockImplementation(async () => named);
    await user.click(allow);
    devices.userMedia[0].grant();
    await waitFor(() => expect(screen.queryByTestId("settings-media-allow")).toBeNull());
    expect(devices.userMedia[0].constraints).toEqual({ audio: true, video: true });
    expect(devices.liveTracks(), "the microphone and camera are let go at once").toEqual([]);
  });

  it("tests the chosen microphone with a level meter, and lets it go on Stop", async () => {
    chooseDevice("audioinput", { id: "mic-headset", label: "AirPods" });
    const { user } = renderApp(<MediaSettings />);
    await user.click(await screen.findByTestId("settings-microphone-test"));
    expect(devices.userMedia[0].constraints).toEqual({ audio: { deviceId: { exact: "mic-headset" } } });
    devices.userMedia[0].grant();
    expect(await screen.findByTestId("settings-microphone-level")).toHaveAttribute("role", "meter");

    await user.click(screen.getByTestId("settings-microphone-test"));
    expect(screen.queryByTestId("settings-microphone-level")).toBeNull();
    expect(devices.liveTracks()).toEqual([]);
  });

  it("previews the chosen camera", async () => {
    chooseDevice("videoinput", { id: "cam-usb", label: "Logitech C920" });
    const { user } = renderApp(<MediaSettings />);
    await user.click(await screen.findByTestId("settings-camera-preview"));
    expect(devices.userMedia[0].constraints).toEqual({ video: { deviceId: { exact: "cam-usb" } }, audio: false });
    devices.userMedia[0].grant();
    expect(await screen.findByTestId("settings-camera-video")).toBeInTheDocument();
  });

  it("says so when the device cannot be opened", async () => {
    const { user } = renderApp(<MediaSettings />);
    await user.click(await screen.findByTestId("settings-camera-preview"));
    devices.userMedia[0].deny(new DOMException("denied", "NotAllowedError"));
    expect(await screen.findByTestId("settings-camera-failed")).toBeInTheDocument();
  });

  it("plays the test sound on the chosen speaker", async () => {
    const sinks = speakerChoice();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    chooseDevice("audiooutput", { id: "out-headset", label: "AirPods" });
    const { user } = renderApp(<MediaSettings />);
    await user.click(await screen.findByTestId("settings-speaker-test"));
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(screen.queryByTestId("settings-speaker-failed")).toBeNull();
    expect(sinks.map(([, id]) => id)).toEqual(["out-headset"]);
  });

  it("has no speaker row where the engine cannot choose one (Safari)", async () => {
    renderApp(<MediaSettings />);
    await screen.findByTestId("settings-microphone");
    await waitFor(() => expect(devices.enumerateDevices).toHaveBeenCalled());
    expect(screen.queryByTestId("settings-speaker")).toBeNull();
  });

  it("is not there where the browser has no devices API", () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    renderApp(<MediaSettings />);
    expect(screen.queryByTestId("settings-media")).toBeNull();
  });
});

/** A connected call placed with the chosen devices, with the call window's device controls. */
async function callWithDevices() {
  let signal: string | null = null;
  const hook = renderHook(() => {
    const webrtc = useWebRTC({
      incomingCallSignal: signal,
      publishCallSignal: () => {},
      setFastPoll: () => {},
      devices: () => ({ audio: preferredDevice("audioinput"), video: preferredDevice("videoinput") }),
    });
    return { webrtc, devices: useCallDevices(webrtc) };
  });
  act(() => { void hook.result.current.webrtc.startCall(false); });
  devices.userMedia[0].grant();
  await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
  const pc = FakePeerConnection.instances[0];
  await waitFor(() => expect(pc.localDescription).not.toBeNull());
  signal = remote.answer(Date.now() + 1);
  hook.rerender();
  await waitFor(() => expect(pc.remoteDescription).not.toBeNull());
  act(() => pc.setIceState("connected"));
  const audio = pc.getTransceivers().find((t) => t.receiver.track.kind === "audio")!.sender;
  await waitFor(() => expect(hook.result.current.devices?.list.named).toBe(true));
  return { hook, pc, audio };
}

describe("a headset plugged in and out during a call", () => {
  it("unplugged: the call switches to the default microphone with replaceTrack, stays connected, and says so", async () => {
    chooseDevice("audioinput", { id: "mic-headset", label: "AirPods" });
    const { hook, audio } = await callWithDevices();
    expect((audio.track as FakeTrack).deviceId).toBe("mic-headset");
    const requests = devices.userMedia.length;

    act(() => devices.unplug("mic-headset"));
    await waitFor(() => expect(devices.userMedia).toHaveLength(requests + 1));
    expect(devices.userMedia[requests].constraints).toEqual({ audio: true });
    const fallback = devices.userMedia[requests].grant().getAudioTracks()[0];

    await waitFor(() => expect(audio.replaceTrack).toHaveBeenCalledWith(fallback));
    expect(hook.result.current.webrtc.callState).toBe("connected");
    expect(hook.result.current.devices?.notice).toEqual({ kind: "audioinput", type: "lost", name: "AirPods" });
    // The choice stays: it is what comes back.
    expect(loadDeviceChoices().audioinput?.id).toBe("mic-headset");
  });

  it("an unplugged microphone that ends its track before the list changes is caught too", async () => {
    chooseDevice("audioinput", { id: "mic-headset", label: "AirPods" });
    const { audio } = await callWithDevices();
    const requests = devices.userMedia.length;
    act(() => (audio.track as FakeTrack).unplug());
    await waitFor(() => expect(devices.userMedia).toHaveLength(requests + 1));
    expect(devices.userMedia[requests].constraints).toEqual({ audio: true });
  });

  it("plugged back in: offers to switch back, and switching back swaps the track again", async () => {
    chooseDevice("audioinput", { id: "mic-headset", label: "AirPods" });
    const { hook, audio } = await callWithDevices();
    act(() => devices.unplug("mic-headset"));
    await waitFor(() => expect(devices.userMedia).toHaveLength(2));
    devices.userMedia[1].grant();
    await waitFor(() => expect(hook.result.current.devices?.notice?.type).toBe("lost"));

    act(() => devices.plug(HEADSET));
    await waitFor(() => expect(hook.result.current.devices?.notice).toEqual({ kind: "audioinput", type: "back", name: "AirPods", id: "mic-headset" }));

    act(() => hook.result.current.devices!.switchBack());
    await waitFor(() => expect(devices.userMedia).toHaveLength(3));
    expect(devices.userMedia[2].constraints).toEqual({ audio: { deviceId: { exact: "mic-headset" } } });
    const headset = devices.userMedia[2].grant().getAudioTracks()[0];
    await waitFor(() => expect(audio.track).toBe(headset));
    expect(hook.result.current.webrtc.callState).toBe("connected");
  });

  it("a speaker unplugged goes back to the default one", async () => {
    speakerChoice();
    chooseDevice("audiooutput", { id: "out-headset", label: "AirPods" });
    const { hook } = await callWithDevices();
    await waitFor(() => expect(hook.result.current.devices?.speaker).toBe("out-headset"));

    act(() => devices.unplug("out-headset"));
    await waitFor(() => expect(hook.result.current.devices?.speaker).toBeUndefined());
    expect(hook.result.current.devices?.notice).toMatchObject({ kind: "audiooutput", type: "lost" });
  });

  it("choosing in the call switches live and becomes the profile's choice", async () => {
    const { hook, audio } = await callWithDevices();
    act(() => hook.result.current.devices!.choose("audioinput", "mic-builtin"));
    await waitFor(() => expect(devices.userMedia).toHaveLength(2));
    const builtIn = devices.userMedia[1].grant().getAudioTracks()[0];
    await waitFor(() => expect(audio.track).toBe(builtIn));
    expect(loadDeviceChoices().audioinput).toEqual({ id: "mic-builtin", label: "MacBook Pro Microphone" });
    expect(hook.result.current.devices?.current.audioinput).toBe("mic-builtin");
  });
});

describe("the call window's device menu", () => {
  function overlayWith(devicesView: Parameters<typeof CallOverlay>[0]["devices"]) {
    return renderApp(
      <CallOverlay callState="connected" localStream={null} remoteStream={null} isMuted={false} isVideoOff canSendVideo
        remoteHasVideo={false} callStartedAt={Date.now()} peerName="Ana" onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()} devices={devicesView} />,
    );
  }
  const view = (over: Partial<NonNullable<Parameters<typeof CallOverlay>[0]["devices"]>> = {}) => ({
    list: groupDevices(devices.devices),
    current: { audioinput: "mic-headset", videoinput: "", audiooutput: "" },
    speaker: undefined,
    speakers: true,
    choose: vi.fn(),
    notice: null,
    dismiss: vi.fn(),
    switchBack: vi.fn(),
    ...over,
  });

  it("lists every microphone, camera and speaker, the ones in use checked, and switches on a click", async () => {
    const devicesView = view();
    const { user } = overlayWith(devicesView);
    await user.click(screen.getByTestId("call-devices"));
    const menu = screen.getByTestId("call-devices-menu");

    const rows = (kind: string) => within(menu).getAllByTestId(`call-device-${kind}`).map((row) => [row.textContent, row.getAttribute("aria-checked")]);
    expect(rows("audioinput")).toEqual([["System default", "false"], ["MacBook Pro Microphone", "false"], ["AirPods", "true"]]);
    expect(rows("videoinput")).toEqual([["System default", "true"], ["FaceTime HD Camera", "false"], ["Logitech C920", "false"]]);
    expect(rows("audiooutput")).toEqual([["System default", "true"], ["MacBook Pro Speakers", "false"], ["AirPods", "false"]]);

    await user.click(within(menu).getAllByTestId("call-device-audioinput")[1]);
    expect(devicesView.choose).toHaveBeenCalledWith("audioinput", "mic-builtin");
    expect(screen.queryByTestId("call-devices-menu")).toBeNull();
  });

  it("has no speakers where none can be chosen", async () => {
    const { user } = overlayWith(view({ speakers: false }));
    await user.click(screen.getByTestId("call-devices"));
    expect(within(screen.getByTestId("call-devices-menu")).queryAllByTestId("call-device-audiooutput")).toEqual([]);
  });

  it("is not there when the call cannot switch devices", () => {
    overlayWith(null);
    expect(screen.queryByTestId("call-devices")).toBeNull();
  });

  it("tells about a device that went, and offers one that came back", async () => {
    const switchBack = vi.fn();
    const { user, rerender } = overlayWith(view({ notice: { kind: "audioinput", type: "lost", name: "AirPods" } }));
    expect(screen.getByTestId("call-device-notice")).toHaveTextContent("AirPods disconnected. Using the default.");
    expect(screen.queryByTestId("call-device-switch-back")).toBeNull();

    rerender(
      <CallOverlay callState="connected" localStream={null} remoteStream={null} isMuted={false} isVideoOff canSendVideo remoteHasVideo={false}
        callStartedAt={Date.now()} peerName="Ana" onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()}
        devices={view({ notice: { kind: "audioinput", type: "back", name: "AirPods", id: "mic-headset" }, switchBack })} />,
    );
    expect(screen.getByTestId("call-device-notice")).toHaveTextContent("AirPods is back");
    await user.click(screen.getByTestId("call-device-switch-back"));
    expect(switchBack).toHaveBeenCalledOnce();
  });

  it("sends the call's sound to the chosen speaker, on both elements that play it", () => {
    const sinks = speakerChoice();
    overlayWith(view({ speaker: "out-headset" }));
    expect(sinks.map(([element, id]) => [element.tagName, id])).toEqual([["AUDIO", "out-headset"], ["VIDEO", "out-headset"]]);
  });
});

describe("the composer's camera", () => {
  it("takes the photo with the camera chosen in Settings", () => {
    chooseDevice("videoinput", { id: "cam-usb", label: "Logitech C920" });
    renderApp(<CameraCapture onSend={vi.fn()} onClose={vi.fn()} />);
    expect(devices.userMedia[0].constraints).toEqual({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, deviceId: { ideal: "cam-usb" } }, audio: false });
  });
});
