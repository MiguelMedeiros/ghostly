import { Channel, invoke } from "@tauri-apps/api/core";
import type { CallMedia } from "@ghostly/core";

/**
 * Calls on Ghostly Desktop for Linux. WebKitGTK is built without WebRTC by Ubuntu, Debian and Fedora alike, so
 * the page has no RTCPeerConnection and no camera; Rust does the call instead (src-tauri/src/native_call):
 * webrtc-rs for WebRTC, GStreamer for the camera, the microphone and the codecs. This file gives the call hook (`useWebRTC`) what it expects: a peer connection
 * and capture with the browser's shape, backed by those commands. What the hook shows is real: the pictures
 * arrive as JPEG frames, drawn on canvases whose `captureStream()` tracks go in the call window's <video>s.
 * The sound stays in Rust, from the microphone to the speakers; the page's audio track is a silent stand-in
 * whose `enabled` mutes the microphone.
 */

/** What Rust says about calls on this machine. */
export interface NativeCallSupport {
  /** Calls here are native (Linux); false where the WebView has WebRTC (macOS, Windows). */
  native: boolean;
  /** What to install, when this machine cannot call. */
  missing: string | null;
}

export async function nativeCallSupport(): Promise<NativeCallSupport | null> {
  try {
    return await invoke<NativeCallSupport>("native_call_support");
  } catch {
    return null;
  }
}

export const SCREEN_UNAVAILABLE = "Screen sharing is not available on Linux yet";

/** A channel's bytes, however Tauri sent them (an ArrayBuffer, or numbers for a small one). */
export function bytesOf(message: unknown): Uint8Array {
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  if (Array.isArray(message)) return Uint8Array.from(message as number[]);
  return new Uint8Array();
}

/** A JPEG starts FF D8; anything else from a call is a JSON event. */
export const isJpeg = (bytes: Uint8Array) => bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;

/** How a native ICE state reads as the browser's two. */
export function connectionStateOf(ice: string): { ice: RTCIceConnectionState; connection: RTCPeerConnectionState } {
  switch (ice) {
    case "checking": return { ice: "checking", connection: "connecting" };
    case "connected": return { ice: "connected", connection: "connected" };
    case "completed": return { ice: "completed", connection: "connected" };
    case "failed": return { ice: "failed", connection: "failed" };
    case "disconnected": return { ice: "disconnected", connection: "disconnected" };
    case "closed": return { ice: "closed", connection: "closed" };
    default: return { ice: "new", connection: "new" };
  }
}

/** A canvas showing the last JPEG that came, and the video track that films it. */
class Picture {
  private readonly canvas = document.createElement("canvas");
  readonly track: MediaStreamTrack;
  private drawing = false;
  private waiting: Uint8Array | null = null;

  constructor() {
    this.canvas.width = 640;
    this.canvas.height = 480;
    this.track = this.canvas.captureStream(15).getVideoTracks()[0];
  }

  /** Frames that come while one is being decoded replace each other: only the newest is drawn. */
  show(jpeg: Uint8Array): void {
    if (this.drawing) {
      this.waiting = jpeg;
      return;
    }
    this.drawing = true;
    void createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }))
      .then((bitmap) => {
        if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
          this.canvas.width = bitmap.width;
          this.canvas.height = bitmap.height;
        }
        this.canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      })
      .catch(() => {})
      .finally(() => {
        this.drawing = false;
        const next = this.waiting;
        this.waiting = null;
        if (next) this.show(next);
      });
  }
}

/** The camera behind each camera track this file made. */
const cameraOf = new WeakMap<MediaStreamTrack, number>();
/** The call a microphone track mutes. */
const callOf = new WeakMap<MediaStreamTrack, NativePeerConnection>();

function named(error: unknown, name: string): Error {
  return Object.assign(new Error(error instanceof Error ? error.message : String(error)), { name });
}

async function openCamera(): Promise<MediaStreamTrack> {
  const picture = new Picture();
  const frames = new Channel<unknown>();
  frames.onmessage = (message) => picture.show(bytesOf(message));
  let camera: number;
  try {
    camera = await invoke<number>("native_camera_open", { frames });
  } catch (error) {
    picture.track.stop();
    throw named(error, "NotFoundError");
  }
  const track = picture.track;
  cameraOf.set(track, camera);
  const stop = track.stop.bind(track);
  track.stop = () => {
    if (cameraOf.delete(track)) void invoke("native_camera_close", { camera }).catch(() => {});
    stop();
  };
  return track;
}

/** A silent track standing for the microphone, which Rust opens with the call; turning it off mutes it. */
function microphone(): MediaStreamTrack {
  const context = new AudioContext();
  const track = context.createMediaStreamDestination().stream.getAudioTracks()[0];
  const enabled = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, "enabled")!;
  Object.defineProperty(track, "enabled", {
    configurable: true,
    get() { return enabled.get!.call(this); },
    set(value: boolean) {
      enabled.set!.call(this, value);
      callOf.get(track)?.mute(!value);
    },
  });
  const stop = track.stop.bind(track);
  track.stop = () => {
    stop();
    void context.close().catch(() => {});
  };
  return track;
}

type Handler<E extends Event = Event> = ((event: E) => void) | null;

interface Lane {
  mid: string | null;
  direction: RTCRtpTransceiverDirection;
  currentDirection: RTCRtpTransceiverDirection | null;
  receiver: { track: { kind: "audio" | "video" } };
  sender: { track: MediaStreamTrack | null; replaceTrack(track: MediaStreamTrack | null): Promise<void> };
}

/**
 * Enough of RTCPeerConnection for `useWebRTC`: two lanes, audio and video, always open both ways; the offer
 * and the answer come back with their candidates already gathered, as `waitForIceGathering` wants them. What
 * happens is told through the `on…` handlers only, the ones the hook sets: no events are dispatched as well
 * (some EventTargets call `on…` for a dispatched event too, and the hook would hear it twice).
 */
export class NativePeerConnection extends EventTarget {
  readonly id = crypto.randomUUID();
  iceConnectionState: RTCIceConnectionState = "new";
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  ontrack: Handler<RTCTrackEvent> = null;
  onicecandidate: Handler<RTCPeerConnectionIceEvent> = null;
  oniceconnectionstatechange: Handler = null;
  onconnectionstatechange: Handler = null;
  onsignalingstatechange: Handler = null;

  private readonly remote = new Picture();
  private readonly remoteStream = new MediaStream([this.remote.track]);
  private readonly opened: Promise<void>;
  private started = false;
  private closed = false;
  private muted = false;
  private offer: string | null = null;
  private readonly audio: Lane;
  private readonly video: Lane;

  constructor(private readonly config: RTCConfiguration) {
    super();
    const events = new Channel<unknown>();
    events.onmessage = (message) => this.heard(bytesOf(message));
    this.opened = invoke("native_call_open", { id: this.id, events });
    const lane = (kind: "audio" | "video"): Lane => ({
      mid: null,
      direction: "sendrecv",
      currentDirection: null,
      receiver: { track: { kind } },
      sender: { track: null, replaceTrack: async (track) => { if (kind === "video") await this.send(track); } },
    });
    this.audio = lane("audio");
    this.video = lane("video");
  }

  getConfiguration(): RTCConfiguration {
    return this.config;
  }

  getTransceivers(): Lane[] {
    return [this.audio, this.video];
  }

  addTrack(track: MediaStreamTrack): Lane["sender"] {
    if (track.kind === "audio") {
      callOf.set(track, this);
      this.muted = !track.enabled;
      this.audio.sender.track = track;
      return this.audio.sender;
    }
    this.video.sender.track = track;
    return this.video.sender;
  }

  /** The video lane is always there: a voice call can show a picture later without a new offer. */
  addTransceiver(): Lane {
    return this.video;
  }

  private camera(): number | null {
    const track = this.video.sender.track;
    return track ? cameraOf.get(track) ?? null : null;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    await this.opened;
    this.started = true;
    const sdp = await invoke<string>("native_call_offer", { id: this.id, camera: this.camera() });
    if (this.muted) await this.mute(true);
    return { type: "offer", sdp };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (!this.offer) throw named("There is no offer to answer", "InvalidStateError");
    await this.opened;
    this.started = true;
    const sdp = await invoke<string>("native_call_answer", { id: this.id, offer: this.offer, camera: this.camera() });
    if (this.muted) await this.mute(true);
    this.negotiated();
    return { type: "answer", sdp };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    // Rust gathered before it answered.
    this.iceGatheringState = "complete";
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    if (description.type === "offer") {
      this.offer = description.sdp ?? null;
      this.lanes();
      return;
    }
    await invoke("native_call_accept", { id: this.id, answer: description.sdp ?? "" });
    this.negotiated();
  }

  /** The lanes have ids once both sides have described them; the peer's picture arrives on the video one. */
  private lanes(): void {
    if (this.audio.mid !== null) return;
    this.audio.mid = "0";
    this.video.mid = "1";
    const event = Object.assign(new Event("track"), {
      track: this.remote.track, streams: [this.remoteStream], receiver: this.video.receiver, transceiver: this.video,
    }) as unknown as RTCTrackEvent;
    queueMicrotask(() => {
      if (!this.closed) this.ontrack?.(event);
    });
  }

  private negotiated(): void {
    this.lanes();
    this.audio.currentDirection = "sendrecv";
    this.video.currentDirection = "sendrecv";
  }

  /** Sends this camera's picture, or none. */
  private async send(track: MediaStreamTrack | null): Promise<void> {
    this.video.sender.track = track;
    if (this.started && !this.closed) await invoke("native_call_camera", { id: this.id, camera: this.camera() });
  }

  async mute(muted: boolean): Promise<void> {
    this.muted = muted;
    if (this.started && !this.closed) await invoke("native_call_mute", { id: this.id, muted }).catch(() => {});
  }

  private heard(bytes: Uint8Array): void {
    if (this.closed) return;
    if (isJpeg(bytes)) {
      this.remote.show(bytes);
      return;
    }
    let ice: unknown;
    try {
      ice = (JSON.parse(new TextDecoder().decode(bytes)) as { ice?: unknown }).ice;
    } catch {
      return;
    }
    if (typeof ice !== "string") return;
    const next = connectionStateOf(ice);
    if (next.ice !== this.iceConnectionState) {
      this.iceConnectionState = next.ice;
      this.oniceconnectionstatechange?.(new Event("iceconnectionstatechange"));
    }
    if (next.connection !== this.connectionState) {
      this.connectionState = next.connection;
      this.onconnectionstatechange?.(new Event("connectionstatechange"));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.iceConnectionState = "closed";
    this.connectionState = "closed";
    this.signalingState = "closed";
    this.remote.track.stop();
    void this.opened.then(() => invoke("native_call_close", { id: this.id })).catch(() => {});
  }
}

/** The call media of Ghostly Desktop on Linux. No screen yet: capturing one needs the desktop portal. */
export function nativeCallMedia(): CallMedia {
  return {
    createPeerConnection: (config) => new NativePeerConnection(config) as unknown as RTCPeerConnection,
    async getUserMedia(constraints) {
      const tracks: MediaStreamTrack[] = [];
      try {
        if (constraints.video) tracks.push(await openCamera());
        if (constraints.audio) tracks.push(microphone());
      } catch (error) {
        tracks.forEach((t) => t.stop());
        throw error;
      }
      return new MediaStream(tracks);
    },
    screenUnavailable: SCREEN_UNAVAILABLE,
  };
}

/**
 * What the engine and the call hook get from what Rust said. On Linux (`native`) the WebView has no WebRTC and
 * GStreamer runs calls: `calls/1` is offered and the media is this file's; when plugins are missing, calls/1 is
 * not offered (a contact is told this app cannot take calls) and the call buttons say what to install.
 * Elsewhere, or when Rust could not say, it is the WebView's own WebRTC: nothing to change.
 */
export function nativeCallOptions(calls: NativeCallSupport | null): {
  node: { callsSupport?: boolean; callsUnavailable?: string };
  callMedia?: CallMedia;
} {
  if (!calls?.native) return { node: {} };
  if (calls.missing) return { node: { callsSupport: false, callsUnavailable: calls.missing } };
  return { node: { callsSupport: true }, callMedia: nativeCallMedia() };
}
