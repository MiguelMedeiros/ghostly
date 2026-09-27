import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeMediaStream, FakeTrack } from "../../../packages/react/test/fakes";

// covers: calls.linux-native

/**
 * Ghostly Desktop on Linux calls without WebRTC in its WebView: src/desktop/nativeCalls.ts stands in for
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

const { NativePeerConnection, SCREEN_UNAVAILABLE, bytesOf, connectionStateOf, isJpeg, nativeCallOptions } = await import("../../desktop/nativeCalls");

const commands = () => tauri.invoke.mock.calls.map(([command]) => command);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command) => (command === "native_call_offer" || command === "native_call_answer" ? `sdp of ${command}` : undefined));
  tauri.channels = [];
  vi.stubGlobal("MediaStream", FakeMediaStream);
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
    expect(tauri.invoke).toHaveBeenCalledWith("native_call_offer", { id: pc.id, camera: null });
    await pc.setLocalDescription(offer);
    // Rust gathered before it answered: nothing to wait for.
    expect(pc.iceGatheringState).toBe("complete");

    await pc.setRemoteDescription({ type: "answer", sdp: "their answer" });
    expect(tauri.invoke).toHaveBeenCalledWith("native_call_accept", { id: pc.id, answer: "their answer" });
    expect(pc.getTransceivers().map((t) => [t.mid, t.currentDirection])).toEqual([["0", "sendrecv"], ["1", "sendrecv"]]);
    await Promise.resolve();
    expect(ontrack).toHaveBeenCalledTimes(1);
    expect(ontrack.mock.calls[0][0].track.kind).toBe("video");
  });

  it("answers an offer through Rust, the lanes known as soon as the offer is", async () => {
    const pc = new NativePeerConnection({});
    await pc.setRemoteDescription({ type: "offer", sdp: "their offer" });
    expect(pc.getTransceivers().map((t) => t.mid)).toEqual(["0", "1"]);
    const answer = await pc.createAnswer();
    expect(answer.sdp).toBe("sdp of native_call_answer");
    expect(tauri.invoke).toHaveBeenCalledWith("native_call_answer", { id: pc.id, offer: "their offer", camera: null });
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
      return command === "native_call_offer" ? "sdp" : undefined;
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
