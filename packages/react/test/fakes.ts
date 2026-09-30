import { vi } from "vitest";

/**
 * Stand-ins for the browser's media and WebRTC APIs, which happy-dom does not have. They do what the hook
 * relies on and nothing more, and they let a test decide when the camera prompt answers and when ICE is done.
 */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let trackIds = 0;

export class FakeTrack extends EventTarget {
  readonly id = `track-${++trackIds}`;
  enabled = true;
  readyState: "live" | "ended" = "live";
  contentHint = "";
  onended: (() => void) | null = null;
  readonly stop = vi.fn(() => {
    this.readyState = "ended";
  });

  /** `deviceId`: the device it captures from ("default" when nothing asked for one); `label` its name. */
  constructor(readonly kind: "audio" | "video", readonly deviceId = "default", readonly label = "") {
    super();
  }

  getSettings() { return { deviceId: this.deviceId }; }

  /** The device was unplugged: the track ends, as browsers end it. */
  unplug() {
    this.readyState = "ended";
    this.onended?.();
    this.dispatchEvent(new Event("ended"));
  }
}

/** A device the fake `enumerateDevices` lists. */
export function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

export class FakeMediaStream {
  private readonly tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }

  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
  addTrack(track: FakeTrack) { this.tracks.push(track); }
}

/** A request the page made for the camera, microphone or screen, still waiting for the person to answer. */
export interface MediaRequest {
  constraints: MediaStreamConstraints;
  /** Answers it with a stream of what it asked for, and returns that stream. */
  grant(): FakeMediaStream;
  /** Answers it with an error, as a denied prompt or a missing device does. */
  deny(error: unknown): void;
}

export class FakeMediaDevices extends EventTarget {
  /** What `enumerateDevices` lists; `plug` and `unplug` change it and fire `devicechange`. */
  devices: MediaDeviceInfo[] = [];
  readonly enumerateDevices = vi.fn(async () => [...this.devices]);
  readonly userMedia: MediaRequest[] = [];
  readonly displayMedia: MediaRequest[] = [];
  /** Every stream handed out, so a test can check none is left running. */
  readonly streams: FakeMediaStream[] = [];

  readonly getUserMedia = vi.fn((constraints: MediaStreamConstraints) => this.request(this.userMedia, constraints));
  readonly getDisplayMedia = vi.fn((constraints: MediaStreamConstraints) => this.request(this.displayMedia, constraints));

  plug(info: MediaDeviceInfo) {
    this.devices.push(info);
    this.dispatchEvent(new Event("devicechange"));
  }

  unplug(deviceId: string) {
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
    this.dispatchEvent(new Event("devicechange"));
  }

  /** The device a request for `kind` gets: the one asked for (exactly, or ideally when it is there), else the default. */
  private pick(kind: "audio" | "video", constraint: boolean | MediaTrackConstraints | undefined): { id: string; label: string } {
    const wanted = typeof constraint === "object" ? constraint.deviceId : undefined;
    const exact = typeof wanted === "object" && !Array.isArray(wanted) ? (wanted as ConstrainDOMStringParameters).exact : undefined;
    const ideal = typeof wanted === "string" ? wanted : typeof wanted === "object" && !Array.isArray(wanted) ? (wanted as ConstrainDOMStringParameters).ideal : undefined;
    const id = (exact ?? ideal) as string | undefined;
    const listed = this.devices.find((d) => d.kind === `${kind}input` && d.deviceId === id);
    if (exact && !listed) throw new DOMException("No such device", "OverconstrainedError");
    return listed ? { id: listed.deviceId, label: listed.label } : { id: "default", label: `Default ${kind}` };
  }

  /** Every track handed out that nobody stopped. */
  liveTracks(): FakeTrack[] {
    return this.streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live");
  }

  private request(queue: MediaRequest[], constraints: MediaStreamConstraints): Promise<FakeMediaStream> {
    const answer = deferred<FakeMediaStream>();
    queue.push({
      constraints,
      grant: () => {
        const tracks: FakeTrack[] = [];
        try {
          for (const kind of ["audio", "video"] as const) {
            if (!constraints[kind]) continue;
            const { id, label } = this.pick(kind, constraints[kind]);
            tracks.push(new FakeTrack(kind, id, label));
          }
        } catch (error) {
          // A device asked for exactly that is not there: the request fails, as in browsers.
          answer.reject(error);
          return new FakeMediaStream();
        }
        const stream = new FakeMediaStream(tracks);
        this.streams.push(stream);
        answer.resolve(stream);
        return stream;
      },
      deny: (error) => answer.reject(error),
    });
    return answer.promise;
  }
}

class FakeSender {
  constructor(
    private readonly pc: FakePeerConnection,
    public track: FakeTrack | null,
  ) {}

  readonly replaceTrack = vi.fn(async (track: FakeTrack | null) => {
    // As in browsers: a closed connection's transceivers are stopped and refuse a new track.
    if (this.pc.closed) throw new DOMException("The RTCPeerConnection is closed", "InvalidStateError");
    this.track = track;
  });
}

export class FakeTransceiver {
  mid: string | null = null;
  currentDirection: RTCRtpTransceiverDirection | null = null;
  readonly receiver: { track: { kind: string } };
  readonly sender: FakeSender;

  constructor(
    pc: FakePeerConnection,
    kind: "audio" | "video",
    public direction: RTCRtpTransceiverDirection,
    track: FakeTrack | null = null,
  ) {
    this.receiver = { track: { kind } };
    this.sender = new FakeSender(pc, track);
  }
}

/** An SDP with what `extractParamsFromSdp` reads: ICE credentials, a fingerprint, a setup role and a host and srflx candidate. */
function fakeSdp(setup: string, kinds: string[]): string {
  const lines = ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0"];
  for (const kind of kinds) {
    lines.push(
      `m=${kind} 9 UDP/TLS/RTP/SAVPF 111`,
      "a=candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host generation 0",
      "a=candidate:2 1 udp 1686052607 203.0.113.9 50000 typ srflx raddr 192.168.1.2 rport 50000 generation 0",
      "a=ice-ufrag:fake",
      "a=ice-pwd:fakefakefakefakefakefake",
      `a=fingerprint:sha-256 ${Array(32).fill("AB").join(":")}`,
      `a=setup:${setup}`,
      `a=ssrc:${kind === "audio" ? 1111 : 2222} cname:fake`,
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * An RTCPeerConnection that records what the hook asks of it. `close()` fires no events, as in browsers.
 * ICE gathering finishes as soon as the local description is set, unless `FakePeerConnection.holdGathering`
 * is on; then a test finishes it with `finishGathering()`.
 */
export class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  static holdGathering = false;
  /** How many of the next connections stall: they gather for ever and find no candidate (Chromium, rarely). */
  static stallGathering = 0;
  private readonly stalls: boolean;

  closed = false;
  iceConnectionState: RTCIceConnectionState = "new";
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly transceivers: FakeTransceiver[] = [];

  ontrack: ((event: unknown) => void) | null = null;
  onicecandidate: ((event: unknown) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;

  readonly close = vi.fn(() => {
    this.closed = true;
    this.iceConnectionState = "closed";
    this.connectionState = "closed";
  });

  constructor(readonly config: RTCConfiguration) {
    super();
    FakePeerConnection.instances.push(this);
    this.stalls = FakePeerConnection.stallGathering > 0;
    if (this.stalls) FakePeerConnection.stallGathering--;
  }

  getConfiguration() { return this.config; }
  getTransceivers() { return [...this.transceivers]; }

  addTrack(track: FakeTrack) {
    this.assertOpen();
    this.transceivers.push(new FakeTransceiver(this, track.kind, "sendrecv", track));
  }

  addTransceiver(kind: "audio" | "video", init: RTCRtpTransceiverInit = {}) {
    this.assertOpen();
    this.transceivers.push(new FakeTransceiver(this, kind, init.direction ?? "sendrecv"));
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.assertOpen();
    return { type: "offer", sdp: fakeSdp("actpass", this.transceivers.map((t) => t.receiver.track.kind)) };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    this.assertOpen();
    return { type: "answer", sdp: fakeSdp("active", this.transceivers.filter((t) => t.mid !== null).map((t) => t.receiver.track.kind)) };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.assertOpen();
    this.localDescription = this.stalls ? { ...description, sdp: description.sdp?.replace(/^a=candidate:.*\r\n/gm, "") } : description;
    this.assignMids();
    if (description.type === "answer") this.settleDirections();
    this.iceGatheringState = FakePeerConnection.holdGathering || this.stalls ? "gathering" : "complete";
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.assertOpen();
    this.remoteDescription = description;
    if (description.type === "offer") {
      // A section the offer has and we added nothing for gets a receive-only transceiver, as in browsers.
      for (const kind of ["audio", "video"] as const) {
        const offered = description.sdp?.includes(`m=${kind}`);
        if (offered && !this.transceivers.some((t) => t.receiver.track.kind === kind)) {
          this.transceivers.push(new FakeTransceiver(this, kind, "recvonly"));
        }
      }
      this.assignMids();
    } else {
      this.settleDirections();
    }
  }

  /** ICE found what the hook waits for. */
  finishGathering() {
    this.iceGatheringState = "complete";
    this.dispatchEvent(new Event("icegatheringstatechange"));
  }

  /** The media path came up, or went down. */
  setIceState(state: RTCIceConnectionState) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }

  /** The whole connection (ICE and DTLS) came up, or failed. */
  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  private assignMids() {
    this.transceivers.forEach((t, i) => {
      t.mid ??= String(i);
    });
  }

  private settleDirections() {
    for (const t of this.transceivers) if (t.mid !== null) t.currentDirection = t.direction;
  }

  private assertOpen() {
    if (this.closed) throw new DOMException("The RTCPeerConnection is closed", "InvalidStateError");
  }
}

/** Puts the fakes where the hook looks for them. Returns the media devices, and a function that takes it all back. */
export function installWebRTCFakes() {
  const devices = new FakeMediaDevices();
  FakePeerConnection.instances = [];
  FakePeerConnection.holdGathering = false;
  FakePeerConnection.stallGathering = 0;
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  const previous = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
  const uninstall = () => {
    vi.unstubAllGlobals();
    if (previous) Object.defineProperty(navigator, "mediaDevices", previous);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  };
  return { devices, uninstall };
}

/** What the other side publishes, as the `_call` record carries it. */
export const remote = {
  offer(ts: number, video = false): string {
    return JSON.stringify({ t: "o", ts, u: "peer", p: "peerpeerpeerpeerpeerpeer", f: "cd".repeat(32), s: "actpass", m: ["a", "v"], c: [], ss: [1, 2], v: video ? 1 : 0 });
  },
  answer(ts: number, video = false): string {
    return JSON.stringify({ t: "a", ts, u: "peer", p: "peerpeerpeerpeerpeerpeer", f: "cd".repeat(32), s: "active", m: ["a", "v"], c: [], ss: [1, 2], v: video ? 1 : 0 });
  },
  hangUp(ts: number): string {
    return JSON.stringify({ t: "h", ts });
  },
};
