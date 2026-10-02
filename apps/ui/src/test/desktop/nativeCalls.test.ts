import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeMediaStream, FakeTrack } from "../../../../../packages/react/test/fakes";

// covers: calls.linux-native, calls.devices-linux

/**
 * Ghostly Desktop on Linux calls without WebRTC in its WebView: apps/ui/src/desktop/nativeCalls.ts stands in for
 * RTCPeerConnection over the Rust commands (`native_call_*`). What the host makes of what Rust says, and what the
 * stand-in does for the call hook: the commands it sends, the lanes it reports, the states it relays.
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => undefined),
  channels: [] as { onmessage: (message: unknown) => void }[],
}));
// The UI tests alias every `@tauri-apps/api/*` to one stand-in (packages/browser/src/platform/tauri.ts): one mock.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
    constructor() { tauri.channels.push(this); }
  },
}));

const { NativePeerConnection, SCREEN_UNAVAILABLE, askedDevice, bytesOf, connectionStateOf, deviceList, deviceName, isJpeg, nativeCallMedia, nativeCallOptions, nativeDevices } = await import("../../desktop/nativeCalls");
const { chooseDevice } = await import("../../lib/mediaDevices");

const commands = () => tauri.invoke.mock.calls.map(([command]) => command);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command) => (command === "native_call_offer" || command === "native_call_answer" ? { sdp: `sdp of ${command}`, microphone: null } : undefined));
  tauri.channels = [];
  localStorage.clear();
  vi.stubGlobal("MediaStream", FakeMediaStream);
  // The microphone's stand-in is a silent AudioContext track whose `enabled` is the browser's own.
  vi.stubGlobal("MediaStreamTrack", class { get enabled() { return (this as { on?: boolean }).on ?? true; } set enabled(on: boolean) { (this as { on?: boolean }).on = on; } });
  vi.stubGlobal("AudioContext", class {
    createMediaStreamDestination() { return { stream: new FakeMediaStream([new FakeTrack("audio")]) }; }
    close() { return Promise.resolve(); }
  });
  // The pictures are canvases filmed by captureStream(), which happy-dom does not have.
  HTMLCanvasElement.prototype.captureStream = function () { return new FakeMediaStream([new FakeTrack("video")]) as unknown as MediaStream; };
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLCanvasElement.prototype as Partial<HTMLCanvasElement>).captureStream;
});

describe("what the host makes of what Rust says about calls", () => {
  it("leaves the WebView's WebRTC alone where calls are not native, or Rust could not say", () => {
    expect(nativeCallOptions(null)).toEqual({ node: {} });
    expect(nativeCallOptions({ native: false, missing: null })).toEqual({ node: {} });
  });

  it("on Linux, offers calls with the native media", () => {
    const { node, callMedia } = nativeCallOptions({ native: true, missing: null });
    expect(node).toEqual({ callsSupport: true });
    expect(callMedia?.screenUnavailable).toBe(SCREEN_UNAVAILABLE);
    expect(callMedia?.getDisplayMedia).toBeUndefined();
  });

  it("on Linux without the GStreamer plugins, offers no calls and says what to install", () => {
    const missing = "Calls need GStreamer plugins: install gstreamer1.0-plugins-good";
    expect(nativeCallOptions({ native: true, missing })).toEqual({ node: { callsSupport: false, callsUnavailable: missing } });
  });
});

describe("the channel's messages", () => {
  it("reads bytes however Tauri sent them, and tells a picture from an event", () => {
    expect([...bytesOf(new Uint8Array([1, 2]).buffer)]).toEqual([1, 2]);
    expect([...bytesOf([3, 4])]).toEqual([3, 4]);
    expect([...bytesOf(new Uint8Array([5]))]).toEqual([5]);
    expect(bytesOf("nothing").length).toBe(0);
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(true);
    expect(isJpeg(new TextEncoder().encode('{"ice":"new"}'))).toBe(false);
  });

  it("maps Rust's ICE states onto the browser's two", () => {
    expect(connectionStateOf("checking")).toEqual({ ice: "checking", connection: "connecting" });
    expect(connectionStateOf("completed")).toEqual({ ice: "completed", connection: "connected" });
    expect(connectionStateOf("failed")).toEqual({ ice: "failed", connection: "failed" });
    expect(connectionStateOf("unspecified")).toEqual({ ice: "new", connection: "new" });
  });
});

describe("the RTCPeerConnection stand-in", () => {
  it("offers through Rust with the camera it was given, and opens its lanes on the answer", async () => {
    const pc = new NativePeerConnection({});
    const ontrack = vi.fn();
    pc.ontrack = ontrack;
    const microphone = new FakeTrack("audio") as unknown as MediaStreamTrack;
    pc.addTrack(microphone);
    pc.addTransceiver();
    expect(pc.getTransceivers().map((t) => [t.receiver.track.kind, t.mid])).toEqual([["audio", null], ["video", null]]);

    const offer = await pc.createOffer();
    expect(offer).toEqual({ type: "offer", sdp: "sdp of native_call_offer" });
    expect(tauri.invoke).toHaveBeenCalledWith("native_call_offer", { id: pc.id, camera: null, microphone: null, speaker: null });
    await pc.setLocalDescription(offer);
    // Rust gathered before it answered: nothing to wait for.
    expect(pc.iceGatheringState).toBe("complete");

    await pc.setRemoteDescription({ type: "answer", sdp: "their answer" });
    expect(tauri.invoke).toHaveBeenCalledWith("native_call_accept", { id: pc.id, answer: "their answer" });
    expect(pc.getTransceivers().map((t) => [t.mid, t.currentDirection])).toEqual([["0", "sendrecv"], ["1", "sendrecv"]]);
  });

  it("hands the peer's picture over with its first frame, not before: no frame, no black screen in place of the name", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 640, height: 480, close() {} }));
    const pc = new NativePeerConnection({});
    const ontrack = vi.fn();
    pc.ontrack = ontrack;
    await pc.createOffer();
    await pc.setRemoteDescription({ type: "answer", sdp: "their answer" });
    tauri.channels[0].onmessage(json({ ice: "connected" }));
    await new Promise((done) => setTimeout(done, 10));
    // Connected, the peer's camera said on, but nothing drawn: the call window keeps the peer's name.
    expect(ontrack).not.toHaveBeenCalled();

    tauri.channels[0].onmessage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer);
    await vi.waitFor(() => expect(ontrack).toHaveBeenCalledTimes(1));
    expect(ontrack.mock.calls[0][0].track.kind).toBe("video");
    tauri.channels[0].onmessage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer);
    await new Promise((done) => setTimeout(done, 10));
    expect(ontrack).toHaveBeenCalledTimes(1);
  });

  it("hands the picture over at once when a frame was drawn before the answer was taken", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 640, height: 480, close() {} }));
    const pc = new NativePeerConnection({});
    const ontrack = vi.fn();
    pc.ontrack = ontrack;
    await pc.createOffer();
    tauri.channels[0].onmessage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer);
    await new Promise((done) => setTimeout(done, 10));
    await pc.setRemoteDescription({ type: "answer", sdp: "their answer" });
    await vi.waitFor(() => expect(ontrack).toHaveBeenCalledTimes(1));
  });

  it("answers an offer through Rust, the lanes known as soon as the offer is", async () => {
    const pc = new NativePeerConnection({});
    await pc.setRemoteDescription({ type: "offer", sdp: "their offer" });
    expect(pc.getTransceivers().map((t) => t.mid)).toEqual(["0", "1"]);
    const answer = await pc.createAnswer();
    expect(answer.sdp).toBe("sdp of native_call_answer");
    expect(tauri.invoke).toHaveBeenCalledWith("native_call_answer", { id: pc.id, offer: "their offer", camera: null, microphone: null, speaker: null });
  });

  it("relays Rust's ICE states as the browser's events, and ignores pictures for them", () => {
    const pc = new NativePeerConnection({});
    const ice = vi.fn();
    const connection = vi.fn();
    pc.oniceconnectionstatechange = ice;
    pc.onconnectionstatechange = connection;
    const events = tauri.channels[0];
    events.onmessage(json({ ice: "checking" }));
    events.onmessage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer);
    events.onmessage(json({ ice: "connected" }));
    expect([pc.iceConnectionState, pc.connectionState]).toEqual(["connected", "connected"]);
    expect(ice).toHaveBeenCalledTimes(2);
    expect(connection).toHaveBeenCalledTimes(2);
  });

  it("holds a state heard while Rust takes the answer until the caller has seen it taken", async () => {
    // On one machine Rust connects before the answer's invoke returns; the call hook sets "connecting" when it
    // returns, so a "connected" relayed before that would be written over and the call would never connect.
    let accepted!: () => void;
    tauri.invoke.mockImplementation(async (command) => {
      if (command === "native_call_accept") await new Promise<void>((done) => { accepted = done; });
      return command === "native_call_offer" ? { sdp: "sdp", microphone: null } : undefined;
    });
    const pc = new NativePeerConnection({});
    const seen: string[] = [];
    pc.oniceconnectionstatechange = () => seen.push(`ice ${pc.iceConnectionState}`);
    await pc.createOffer();
    const answering = pc.setRemoteDescription({ type: "answer", sdp: "their answer" }).then(() => seen.push("answer taken"));
    await vi.waitFor(() => expect(accepted).toBeTypeOf("function"));
    tauri.channels[0].onmessage(json({ ice: "checking" }));
    tauri.channels[0].onmessage(json({ ice: "connected" }));
    expect(seen).toEqual([]);
    accepted();
    await answering;
    await vi.waitFor(() => expect(seen).toEqual(["answer taken", "ice connected"]));
  });

  it("mutes the microphone in Rust once the call has started", async () => {
    const pc = new NativePeerConnection({});
    await pc.mute(true);
    expect(commands()).not.toContain("native_call_mute");
    await pc.createOffer();
    await pc.mute(true);
    expect(tauri.invoke).toHaveBeenCalledWith("native_call_mute", { id: pc.id, muted: true });
  });

  it("closes the call in Rust, once, and relays nothing after", async () => {
    const pc = new NativePeerConnection({});
    const ice = vi.fn();
    pc.oniceconnectionstatechange = ice;
    pc.close();
    pc.close();
    await vi.waitFor(() => expect(commands().filter((c) => c === "native_call_close")).toHaveLength(1));
    tauri.channels[0].onmessage(json({ ice: "connected" }));
    expect(ice).not.toHaveBeenCalled();
    expect(pc.connectionState).toBe("closed");
  });
});

describe("the devices, which are GStreamer's and known by name", () => {
  it("lists what Rust lists, each device's id its name", () => {
    expect(deviceList([
      { kind: "audioinput", label: "Built-in Audio" },
      { kind: "videoinput", label: "Webcam (2)" },
      { kind: "audiooutput", label: "Headphones" },
      { kind: "other", label: "?" },
    ])).toEqual({
      audioinput: [{ id: "Built-in Audio", label: "Built-in Audio" }],
      videoinput: [{ id: "Webcam (2)", label: "Webcam (2)" }],
      audiooutput: [{ id: "Headphones", label: "Headphones" }],
      defaults: {},
      named: true,
    });
  });

  it("reads the device a constraint asks for, and names it as Rust knows it", () => {
    expect(askedDevice(true)).toBeNull();
    expect(askedDevice(undefined)).toBeNull();
    expect(askedDevice({ deviceId: "Mic" })).toBe("Mic");
    expect(askedDevice({ deviceId: { ideal: "Mic" } })).toBe("Mic");
    expect(askedDevice({ deviceId: { exact: ["Mic", "Other"] } })).toBe("Mic");
    // A choice kept from the WebView's own list is found by the name kept beside its id.
    chooseDevice("audioinput", { id: "a1b2c3", label: "USB Microphone" });
    expect(deviceName("audioinput", "a1b2c3")).toBe("USB Microphone");
    expect(deviceName("audioinput", "Built-in Audio")).toBe("Built-in Audio");
    expect(deviceName("audioinput", "default")).toBeNull();
    expect(deviceName("audioinput", undefined)).toBeNull();
  });

  it("follows plugging in and out through one watch in Rust", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stop = nativeDevices.watch(first);
    nativeDevices.watch(second);
    expect(commands().filter((c) => c === "native_call_devices_watch")).toHaveLength(1);
    tauri.channels[0].onmessage(json({ devices: "changed" }));
    stop();
    tauri.channels[0].onmessage(json({ devices: "changed" }));
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 2]);
  });

  it("captures from the devices asked for, starts the call with them, and says which ones Rust used", async () => {
    tauri.invoke.mockImplementation(async (command, args) => {
      if (command === "native_camera_open") return { camera: 7, device: args?.device ?? null };
      // Rust has no microphone by that name: the call sends the default one.
      if (command === "native_call_offer") return { sdp: "sdp", microphone: null };
      return undefined;
    });
    chooseDevice("audioinput", { id: "a1b2c3", label: "USB Microphone" });
    chooseDevice("audiooutput", { id: "Headphones", label: "Headphones" });
    const media = nativeCallMedia();
    expect(media.choosesDevices).toBe(true);
    const stream = await media.getUserMedia({ audio: { deviceId: { ideal: "a1b2c3" } }, video: { deviceId: { ideal: "Test bars" } } });
    expect(tauri.invoke).toHaveBeenCalledWith("native_camera_open", expect.objectContaining({ device: "Test bars" }));
    const [microphone] = stream.getAudioTracks();
    const [camera] = stream.getVideoTracks();
    expect(camera.getSettings().deviceId).toBe("Test bars");
    expect(microphone.getSettings().deviceId).toBe("USB Microphone");
    // Named as a browser's track is: the call's notices say which device went.
    expect(microphone.label).toBe("USB Microphone");

    const pc = new NativePeerConnection({});
    pc.addTrack(microphone);
    pc.addTrack(camera);
    await pc.createOffer();
    expect(tauri.invoke).toHaveBeenCalledWith("native_call_offer", { id: pc.id, camera: 7, microphone: "USB Microphone", speaker: "Headphones" });
    expect(microphone.getSettings().deviceId).toBe("default");
    expect(microphone.label).toBe("");
  });

  it("switches the microphone in Rust when the call's audio sender gets another one, muted if it was", async () => {
    tauri.invoke.mockImplementation(async (command, args) => {
      if (command === "native_call_offer") return { sdp: "sdp", microphone: null };
      if (command === "native_call_microphone") return args?.device ?? null;
      return undefined;
    });
    const media = nativeCallMedia();
    const pc = new NativePeerConnection({});
    const [audio] = pc.getTransceivers();
    // Before the call starts there is nothing in Rust to switch: the next offer takes it.
    const early = (await media.getUserMedia({ audio: { deviceId: { exact: "Mic A" } } })).getAudioTracks()[0];
    await audio.sender.replaceTrack(early);
    expect(commands()).not.toContain("native_call_microphone");
    await pc.createOffer();
    expect(tauri.invoke).toHaveBeenCalledWith("native_call_offer", expect.objectContaining({ microphone: "Mic A" }));

    const next = (await media.getUserMedia({ audio: { deviceId: { exact: "Mic B" } } })).getAudioTracks()[0];
    next.enabled = false;
    await audio.sender.replaceTrack(next);
    expect(tauri.invoke).toHaveBeenCalledWith("native_call_microphone", { id: pc.id, device: "Mic B" });
    expect(next.getSettings().deviceId).toBe("Mic B");
    // The new track mutes this call.
    next.enabled = true;
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("native_call_mute", { id: pc.id, muted: false }));
  });

  it("meters a microphone in Rust for Settings, by name, until stopped", async () => {
    tauri.invoke.mockImplementation(async (command) => (command === "native_microphone_meter" ? { meter: 7, device: "Mic A" } : undefined));
    const heard: number[] = [];
    const stop = await nativeDevices.meter!("Mic A", (level) => heard.push(level));
    expect(tauri.invoke).toHaveBeenCalledWith("native_microphone_meter", { levels: tauri.channels[0], device: "Mic A" });
    tauri.channels[0].onmessage(json({ level: 0.5 }));
    tauri.channels[0].onmessage(json({ level: 3 }));
    tauri.channels[0].onmessage(json({ ice: "new" }));
    tauri.channels[0].onmessage(new TextEncoder().encode("not json").buffer);
    expect(heard).toEqual([0.5, 1]);
    stop();
    stop();
    tauri.channels[0].onmessage(json({ level: 0.2 }));
    expect(heard).toHaveLength(2);
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "native_microphone_meter_close")).toEqual([["native_microphone_meter_close", { meter: 7 }]]);

    await nativeDevices.meter!(undefined, () => {});
    expect(tauri.invoke).toHaveBeenLastCalledWith("native_microphone_meter", expect.objectContaining({ device: null }));
    tauri.invoke.mockRejectedValueOnce("The microphone could not start");
    await expect(nativeDevices.meter!("Mic B", () => {})).rejects.toBe("The microphone could not start");
  });

  it("plays the speakers' test in Rust, on the speaker by name", async () => {
    await nativeDevices.testSpeaker!("Headphones");
    await nativeDevices.testSpeaker!(undefined);
    expect(tauri.invoke.mock.calls).toEqual([["native_speaker_test", { device: "Headphones" }], ["native_speaker_test", { device: null }]]);
  });

  it("plays the call on another speaker, in Rust, once the call has started", async () => {
    const pc = new NativePeerConnection({});
    const told = () => tauri.invoke.mock.calls.filter(([command, args]) => command === "native_call_speaker" && args?.id === pc.id).map(([, args]) => args?.device);
    nativeDevices.playCallOn("Headphones");
    expect(told()).toEqual([]);
    await pc.createOffer();
    nativeDevices.playCallOn("Headphones");
    nativeDevices.playCallOn(undefined);
    pc.close();
    nativeDevices.playCallOn("Headphones");
    expect(told()).toEqual(["Headphones", null]);
  });
});
