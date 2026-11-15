import { act, renderHook, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUP_CALL_MUTED_ABOVE, joinsMuted, NO_CALL_KEY, NO_RELAY, NO_SEALING, useGroupCall, type LivekitModule, type UseGroupCallOptions } from "../../hooks/useGroupCall";
import { chooseDevice } from "../../lib/mediaDevices";
import { FakeTrack } from "../../../../../packages/react/test/fakes";

/**
 * `useGroupCall` over a fake LiveKit room: the test DOM has no WebRTC, so no real media and no network. The fake
 * keeps LiveKit's shape where the hook reads it (participants, publications, active speakers, room events).
 */

const Source = { Microphone: "microphone", Camera: "camera", ScreenShare: "screen_share" } as const;
type SourceName = (typeof Source)[keyof typeof Source];

const RoomEvent = {
  ParticipantConnected: "participantConnected",
  ParticipantDisconnected: "participantDisconnected",
  ParticipantNameChanged: "participantNameChanged",
  TrackPublished: "trackPublished",
  TrackUnpublished: "trackUnpublished",
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  TrackMuted: "trackMuted",
  TrackUnmuted: "trackUnmuted",
  LocalTrackPublished: "localTrackPublished",
  LocalTrackUnpublished: "localTrackUnpublished",
  ActiveSpeakersChanged: "activeSpeakersChanged",
  Reconnected: "reconnected",
  Disconnected: "disconnected",
} as const;

class FakeLocalTrack {
  readonly stop = vi.fn(() => this.mediaStreamTrack.stop());
  constructor(readonly mediaStreamTrack: MediaStreamTrack) {}
}

class FakePublication {
  isMuted = false;
  /** LiveKit's `isEncrypted`: the SFU's word that the sender seals this track (its `encryption` is not NONE). */
  isEncrypted = true;
  /** What this device asked for (`setSubscribed`); undefined: nothing asked, as LiveKit's `isDesired` reads it. */
  private subscribed?: boolean;
  constructor(readonly source: SourceName, public track: FakeLocalTrack | undefined, private readonly kind: "audio" | "video" = "audio") {}
  get isDesired() { return this.subscribed !== false; }
  get isSubscribed() { return this.track !== undefined; }
  /** LiveKit's subscribe switch: the SFU sends the track, or stops. */
  readonly setSubscribed = vi.fn((on: boolean) => {
    this.subscribed = on;
    this.track = on ? (this.track ?? new FakeLocalTrack(new FakeTrack(this.kind) as unknown as MediaStreamTrack)) : undefined;
  });
}

class FakeParticipant {
  name?: string;
  isSpeaking = false;
  readonly trackPublications = new Map<string, FakePublication>();
  constructor(readonly identity: string, name?: string) {
    this.name = name;
  }
  getTrackPublication(source: SourceName) {
    return [...this.trackPublications.values()].find((p) => p.source === source);
  }
  private enabled(source: SourceName) {
    const p = this.getTrackPublication(source);
    return !!p && !p.isMuted;
  }
  get isMicrophoneEnabled() { return this.enabled(Source.Microphone); }
  get isCameraEnabled() { return this.enabled(Source.Camera); }
  get isScreenShareEnabled() { return this.enabled(Source.ScreenShare); }

  /** A remote participant's track: subscribed and sealed unless said otherwise. */
  publish(source: SourceName, kind: "audio" | "video", { subscribed = true, encrypted = true } = {}) {
    const pub = new FakePublication(source, subscribed ? new FakeLocalTrack(new FakeTrack(kind) as unknown as MediaStreamTrack) : undefined, kind);
    pub.isEncrypted = encrypted;
    this.trackPublications.set(source, pub);
    return pub;
  }
}

class FakeLocalParticipant extends FakeParticipant {
  constructor(private readonly room: FakeRoom) {
    super("me", "Me");
  }
  private toggle(source: SourceName, kind: "audio" | "video", on: boolean) {
    let pub = this.getTrackPublication(source);
    if (on && !pub) {
      pub = this.publish(source, kind);
      this.room.emit(RoomEvent.LocalTrackPublished);
    }
    if (pub) {
      pub.isMuted = !on;
      this.room.emit(on ? RoomEvent.TrackUnmuted : RoomEvent.TrackMuted);
    }
    return pub;
  }
  readonly setMicrophoneEnabled = vi.fn(async (on: boolean, _options?: unknown) => {
    steps.push("mic");
    const fails = FakeRoom.micFails;
    FakeRoom.micFails = null;
    if (fails) throw fails;
    return this.toggle(Source.Microphone, "audio", on);
  });
  readonly setCameraEnabled = vi.fn(async (on: boolean, _options?: unknown) => {
    steps.push("camera");
    return this.toggle(Source.Camera, "video", on);
  });
  readonly publishTrack = vi.fn(async (track: MediaStreamTrack, options: { source: SourceName }) => {
    steps.push("publish");
    const pub = new FakePublication(options.source, new FakeLocalTrack(track));
    this.trackPublications.set(`pub-${track.id}`, pub);
    this.room.emit(RoomEvent.LocalTrackPublished);
    return pub;
  });
  readonly unpublishTrack = vi.fn(async (track: MediaStreamTrack, stop?: boolean) => {
    for (const [key, pub] of this.trackPublications) {
      if (pub.track?.mediaStreamTrack !== track) continue;
      this.trackPublications.delete(key);
      if (stop) track.stop();
      this.room.emit(RoomEvent.LocalTrackUnpublished);
      return pub;
    }
    return undefined;
  });
}

class FakeRoom {
  static rooms: FakeRoom[] = [];
  /** Who is already in the room when the next one connects. */
  static waiting: string[] = [];
  /** Why the next room's microphone will not open. */
  static micFails: Error | null = null;
  /** What the room holds when the next one connects, beyond `waiting`'s people. */
  static atJoin: ((room: FakeRoom) => void) | null = null;
  readonly remoteParticipants = new Map<string, FakeParticipant>();
  activeSpeakers: FakeParticipant[] = [];
  readonly localParticipant = new FakeLocalParticipant(this);
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly connect = vi.fn(async (_url: string, _token: string, _opts?: { rtcConfig?: RTCConfiguration; autoSubscribe?: boolean }) => {
    for (const id of FakeRoom.waiting) this.remoteParticipants.set(id, new FakeParticipant(id, id.toUpperCase()));
    FakeRoom.atJoin?.(this);
  });
  // Like LiveKit's, but stops nothing itself: the hook must stop its own tracks.
  readonly disconnect = vi.fn(async (_stopTracks?: boolean) => {
    this.emit(RoomEvent.Disconnected);
  });
  /** LiveKit's E2EE switch: `steps` records it against the connect, as a sealed join must turn it on first. */
  readonly setE2EEEnabled = vi.fn(async (_on: boolean) => { steps.push("e2ee"); });
  constructor(readonly options: { encryption?: { keyProvider: FakeKeyProvider; worker: FakeWorker } } & Record<string, unknown>) {
    FakeRoom.rooms.push(this);
    steps.push("room");
    const connect = this.connect.getMockImplementation()!;
    this.connect.mockImplementation(async (...args) => { steps.push("connect"); return connect(...args); });
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }
  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  join(identity: string, name?: string) {
    const p = new FakeParticipant(identity, name);
    this.remoteParticipants.set(identity, p);
    this.emit(RoomEvent.ParticipantConnected);
    return p;
  }
  part(identity: string) {
    this.remoteParticipants.delete(identity);
    this.emit(RoomEvent.ParticipantDisconnected);
  }
  speakers(...people: FakeParticipant[]) {
    for (const p of [this.localParticipant, ...this.remoteParticipants.values()]) p.isSpeaking = people.includes(p);
    this.activeSpeakers = people;
    this.emit(RoomEvent.ActiveSpeakersChanged);
  }
}

/** The order a join goes in: for a sealed one the key set, the room, E2EE on, the connect, and only then any publish. */
let steps: string[] = [];

/** LiveKit's shared-key provider (`ExternalE2EEKeyProvider`): the raw bytes of every key set in it, in order. */
class FakeKeyProvider {
  static providers: FakeKeyProvider[] = [];
  readonly keys: number[][] = [];
  readonly setKey = vi.fn(async (key: string | ArrayBuffer) => {
    if (typeof key === "string") throw new Error("a passphrase: the call key goes in as raw bytes");
    this.keys.push([...new Uint8Array(key)]);
    steps.push("key");
  });
  constructor() { FakeKeyProvider.providers.push(this); }
}

class FakeWorker {
  static workers: FakeWorker[] = [];
  readonly terminate = vi.fn();
  constructor() { FakeWorker.workers.push(this); }
}

/** Whether the next join's browser can seal media (livekit-client's `isE2EESupported`). */
let sealing = true;

const fakeLivekit = {
  Room: FakeRoom, RoomEvent, Track: { Source }, ExternalE2EEKeyProvider: FakeKeyProvider,
  isE2EESupported: () => sealing, e2eeWorker: () => new FakeWorker(),
} as unknown as LivekitModule;
const loadLivekit = vi.fn(async () => fakeLivekit);

const room = () => FakeRoom.rooms[FakeRoom.rooms.length - 1];

async function joined(over: Partial<UseGroupCallOptions> = {}) {
  const hook = renderHook((props: UseGroupCallOptions) => useGroupCall(props), {
    initialProps: { url: "wss://call.example", token: "pass", loadLivekit, ...over },
  });
  await waitFor(() => expect(hook.result.current.status).toBe("connected"));
  // the join's last step: the microphone, unless the room is too full for it
  if (!joinsMuted(room().remoteParticipants.size + 1)) await waitFor(() => expect(room().localParticipant.setMicrophoneEnabled).toHaveBeenCalled());
  await act(async () => {});
  return hook;
}

/** A `getDisplayMedia` answering with one fake screen track. */
function displayMedia() {
  const screen = new FakeTrack("video");
  const getDisplayMedia = vi.fn(async () => ({ getVideoTracks: () => [screen], getAudioTracks: () => [] }) as unknown as MediaStream);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });
  return { screen, getDisplayMedia };
}

afterEach(() => {
  FakeRoom.rooms = [];
  FakeKeyProvider.providers = [];
  FakeWorker.workers = [];
  steps = [];
  sealing = true;
  FakeRoom.waiting = [];
  FakeRoom.micFails = null;
  FakeRoom.atJoin = null;
  loadLivekit.mockClear();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("useGroupCall", () => {
  it("joins with the microphone on and the camera off, on the chosen microphone, with the pass's TURN", async () => {
    chooseDevice("audioinput", { id: "mic-2", label: "USB mic" });
    const iceServers = [{ urls: "turn:turn.example:3478", username: "u", credential: "c" }];
    const { result } = await joined({ iceServers });
    expect(loadLivekit).toHaveBeenCalledTimes(1);
    expect(room().connect).toHaveBeenCalledWith("wss://call.example", "pass", { rtcConfig: { iceServers } });
    expect(room().options).toMatchObject({ adaptiveStream: false });
    expect(room().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, { deviceId: { ideal: "mic-2" } });
    expect(room().localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.local).toMatchObject({ identity: "me", name: "Me", mic: true, camera: false, screen: false }));
    // your own voice is not handed to the window
    expect(result.current.local.tracks.audio).toBeUndefined();
  });

  it("connects with LiveKit's own ICE servers when the pass has none", async () => {
    await joined();
    expect(room().connect).toHaveBeenCalledWith("wss://call.example", "pass", undefined);
  });

  it("with Hide my IP on, keeps to the pass's TURN under the relay policy, and joins nothing without one", async () => {
    const turn = { urls: "turn:turn.example:3478", username: "u", credential: "c" };
    await joined({ iceServers: [{ urls: "stun:stun.example:3478" }, turn], relayOnly: true });
    expect(room().connect).toHaveBeenCalledWith("wss://call.example", "pass", { rtcConfig: { iceServers: [{ ...turn, urls: [turn.urls] }], iceTransportPolicy: "relay" } });

    FakeRoom.rooms = [];
    loadLivekit.mockClear();
    const { result } = renderHook(() => useGroupCall({ url: "wss://call.example", token: "pass", iceServers: [{ urls: "stun:stun.example:3478" }], relayOnly: true, loadLivekit }));
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.error).toMatchObject({ action: "join", message: NO_RELAY });
    expect(loadLivekit).not.toHaveBeenCalled();
    expect(FakeRoom.rooms).toHaveLength(0);
  });

  it(`joins muted past ${GROUP_CALL_MUTED_ABOVE} people, and with the microphone on at ${GROUP_CALL_MUTED_ABOVE}`, async () => {
    FakeRoom.waiting = Array.from({ length: GROUP_CALL_MUTED_ABOVE }, (_, i) => `p${i}`);
    const crowded = await joined();
    expect(crowded.result.current.participants).toHaveLength(GROUP_CALL_MUTED_ABOVE);
    expect(room().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(crowded.result.current.local.mic).toBe(false);
    crowded.unmount();

    FakeRoom.waiting = Array.from({ length: GROUP_CALL_MUTED_ABOVE - 1 }, (_, i) => `p${i}`);
    const full = await joined();
    await waitFor(() => expect(full.result.current.local.mic).toBe(true));
    expect(joinsMuted(GROUP_CALL_MUTED_ABOVE)).toBe(false);
    expect(joinsMuted(GROUP_CALL_MUTED_ABOVE + 1)).toBe(true);
  });

  it("follows people joining and leaving, with their names and tracks", async () => {
    const { result } = await joined();
    let ana!: FakeParticipant;
    act(() => {
      ana = room().join("ana", "Ana");
      room().join("bo");
    });
    expect(result.current.participants.map((p) => [p.identity, p.name])).toEqual([["ana", "Ana"], ["bo", "bo"]]);
    act(() => {
      ana.publish(Source.Microphone, "audio");
      ana.publish(Source.Camera, "video");
      room().emit(RoomEvent.TrackSubscribed);
    });
    const shown = result.current.participants[0];
    expect(shown).toMatchObject({ mic: true, camera: true, screen: false });
    expect(shown.tracks.audio).toBe(ana.getTrackPublication(Source.Microphone)!.track!.mediaStreamTrack);
    expect(shown.tracks.camera).toBe(ana.getTrackPublication(Source.Camera)!.track!.mediaStreamTrack);
    act(() => room().part("ana"));
    expect(result.current.participants.map((p) => p.identity)).toEqual(["bo"]);
  });

  it("marks who speaks and names the active speaker", async () => {
    const { result } = await joined();
    let ana!: FakeParticipant;
    let bo!: FakeParticipant;
    act(() => {
      ana = room().join("ana");
      bo = room().join("bo");
    });
    expect(result.current.activeSpeaker).toBeNull();
    act(() => room().speakers(bo, ana));
    expect(result.current.activeSpeaker).toBe("bo");
    expect(result.current.participants.map((p) => [p.identity, p.speaking])).toEqual([["ana", true], ["bo", true]]);
    act(() => room().speakers(room().localParticipant as FakeParticipant));
    expect(result.current.activeSpeaker).toBe("me");
    expect(result.current.local.speaking).toBe(true);
    expect(result.current.participants.every((p) => !p.speaking)).toBe(true);
    act(() => room().speakers());
    expect(result.current.activeSpeaker).toBeNull();
  });

  it("mutes and unmutes the microphone, turns the camera on and off, and shows a remote mute", async () => {
    chooseDevice("videoinput", { id: "cam-1", label: "Webcam" });
    const { result } = await joined();
    await act(() => result.current.toggleMic());
    expect(room().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false, undefined);
    expect(result.current.local.mic).toBe(false);
    await act(() => result.current.toggleMic());
    expect(result.current.local.mic).toBe(true);

    await act(() => result.current.toggleCamera());
    expect(room().localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(true, { deviceId: { ideal: "cam-1" } });
    expect(result.current.local.camera).toBe(true);
    expect(result.current.local.tracks.camera).toBeTruthy();
    await act(() => result.current.toggleCamera());
    expect(result.current.local.camera).toBe(false);

    let ana!: FakeParticipant;
    act(() => {
      ana = room().join("ana");
      ana.publish(Source.Microphone, "audio");
      room().emit(RoomEvent.TrackSubscribed);
    });
    expect(result.current.participants[0].mic).toBe(true);
    act(() => {
      ana.getTrackPublication(Source.Microphone)!.isMuted = true;
      room().emit(RoomEvent.TrackMuted);
    });
    expect(result.current.participants[0].mic).toBe(false);
  });

  it("stays in the call, muted, when the microphone will not open", async () => {
    FakeRoom.micFails = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    const hook = renderHook(() => useGroupCall({ url: "wss://call.example", token: "pass", loadLivekit }));
    await waitFor(() => expect(hook.result.current.error).toMatchObject({ action: "mic", message: "Permission denied" }));
    expect(hook.result.current.status).toBe("connected");
    expect(hook.result.current.local.mic).toBe(false);
  });

  it("shares the screen through getDisplayMedia and stops when the browser's bar ends it", async () => {
    const { screen, getDisplayMedia } = displayMedia();
    const { result } = await joined();
    await act(() => result.current.toggleScreen());
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(room().localParticipant.publishTrack).toHaveBeenCalledWith(screen, { source: Source.ScreenShare });
    expect(result.current.local.screen).toBe(true);
    expect(result.current.local.tracks.screen).toBe(screen);

    await act(async () => screen.unplug());
    await waitFor(() => expect(result.current.local.screen).toBe(false));
    expect(room().localParticipant.unpublishTrack).toHaveBeenCalledWith(screen, true);
    expect(screen.stop).toHaveBeenCalled();
    expect(result.current.local.tracks.screen).toBeNull();
    // and the button shares again
    await act(() => result.current.toggleScreen());
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
  });

  it("stops the share from the button, and says nothing when the picker is closed", async () => {
    const { screen, getDisplayMedia } = displayMedia();
    const { result } = await joined();
    await act(() => result.current.toggleScreen());
    await act(() => result.current.toggleScreen());
    expect(room().localParticipant.unpublishTrack).toHaveBeenCalledWith(screen, true);
    expect(result.current.local.screen).toBe(false);

    // closed after a while (a refusal at once is the system's, which gets a line)
    getDisplayMedia.mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" })), 350)));
    await act(() => result.current.toggleScreen());
    expect(result.current.error).toBeNull();
    expect(result.current.local.screen).toBe(false);
  });

  it("says why when the screen cannot be shared here", async () => {
    const { result } = await joined();
    await act(() => result.current.toggleScreen());
    expect(result.current.error).toMatchObject({ action: "screen", message: "Screen sharing is not available here" });
  });

  it("leaving disconnects and stops every local track, the shared screen too", async () => {
    const { screen } = displayMedia();
    const { result } = await joined();
    await act(() => result.current.toggleCamera());
    await act(() => result.current.toggleScreen());
    const local = room().localParticipant;
    const tracks = [...local.trackPublications.values()].map((p) => p.track!.mediaStreamTrack as unknown as FakeTrack);
    expect(tracks).toHaveLength(3);
    await act(() => result.current.leave());
    expect(room().disconnect).toHaveBeenCalledWith(true);
    for (const track of [...tracks, screen]) expect(track.stop).toHaveBeenCalled();
    expect(result.current.status).toBe("left");
    // once left, the buttons do nothing
    await act(() => result.current.toggleMic());
    expect(local.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
  });

  it("leaves the room on unmount, and when the node closes it", async () => {
    const first = await joined();
    const closed = room();
    first.unmount();
    await waitFor(() => expect(closed.disconnect).toHaveBeenCalledWith(true));

    const second = await joined();
    const mic = room().localParticipant.getTrackPublication(Source.Microphone)!.track!.mediaStreamTrack as unknown as FakeTrack;
    act(() => room().emit(RoomEvent.Disconnected));
    await waitFor(() => expect(second.result.current.status).toBe("left"));
    expect(mic.stop).toHaveBeenCalled();
  });

  it("an unmount before LiveKit has loaded joins nothing", async () => {
    let release!: (lk: LivekitModule) => void;
    const slow = vi.fn(() => new Promise<LivekitModule>((resolve) => (release = resolve)));
    const hook = renderHook(() => useGroupCall({ url: "wss://call.example", token: "pass", loadLivekit: slow }));
    hook.unmount();
    await act(async () => release(fakeLivekit));
    expect(FakeRoom.rooms).toHaveLength(0);
  });

  it("is idle without a pass", () => {
    const { result } = renderHook(() => useGroupCall({ url: "", token: "", loadLivekit }));
    expect(result.current.status).toBe("idle");
    expect(loadLivekit).not.toHaveBeenCalled();
  });

  it("loads livekit-client and its E2EE worker only at the join, never at the module's import", () => {
    const read = (file: string) => readFileSync(join(fileURLToPath(import.meta.url), "../../../hooks", file), "utf8");
    const source = read("useGroupCall.ts");
    const statics = source.match(/^import\s+(?!type\b)[^;]*from\s+["'](?:livekit-client|\.\/groupCallLivekit)["']/gm);
    expect(statics).toBeNull();
    expect(source).toContain('import("./groupCallLivekit")');
    // The module loaded at the join is where livekit-client and the worker come from.
    const lazy = read("groupCallLivekit.ts");
    expect(lazy).toMatch(/from "livekit-client";/);
    expect(lazy).toContain('new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), { type: "module" })');
  });
});

describe("useGroupCall, a sealed call (WISP 602 § End-to-end encryption)", () => {
  const key = (epoch: number, fill: number) => ({ epoch, key: new Uint8Array(32).fill(fill) });

  it("joins with LiveKit's E2EE: the shared key provider with the call key's raw bytes and the E2EE worker, sealed before connecting", async () => {
    const { result } = await joined({ e2ee: key(4, 7) });
    expect(FakeKeyProvider.providers).toHaveLength(1);
    const [provider] = FakeKeyProvider.providers;
    expect(provider.keys).toEqual([Array(32).fill(7)]);
    expect(room().options.encryption).toEqual({ keyProvider: provider, worker: FakeWorker.workers[0] });
    expect(room().options).toMatchObject({ adaptiveStream: false });
    expect(room().setE2EEEnabled).toHaveBeenCalledWith(true);
    expect(steps).toEqual(["key", "room", "e2ee", "connect", "mic"]);
    expect(result.current.status).toBe("connected");
  });

  it("publishes nothing before E2EE is on and the room joined: the microphone and a shared screen go out after both", async () => {
    displayMedia();
    const { result } = await joined({ e2ee: key(4, 7) });
    await act(() => result.current.toggleScreen());
    await act(() => result.current.toggleCamera());
    expect(steps).toEqual(["key", "room", "e2ee", "connect", "mic", "publish", "camera"]);
    expect(room().setE2EEEnabled).toHaveBeenCalledTimes(1);
  });

  it("subscribes by hand to sealed publications only: a track in the clear in the room at the join is never taken", async () => {
    let sealedPub: FakePublication | undefined, clearPub: FakePublication | undefined;
    FakeRoom.atJoin = (r) => {
      const bia = new FakeParticipant("bia", "Bia");
      sealedPub = bia.publish(Source.Microphone, "audio", { subscribed: false });
      const eve = new FakeParticipant("eve", "Eve");
      clearPub = eve.publish(Source.Camera, "video", { subscribed: false, encrypted: false });
      r.remoteParticipants.set("bia", bia).set("eve", eve);
    };
    const { result } = await joined({ e2ee: key(4, 7) });
    expect(room().connect).toHaveBeenCalledWith("wss://call.example", "pass", { autoSubscribe: false });
    expect(sealedPub!.setSubscribed).toHaveBeenCalledWith(true);
    expect(clearPub!.setSubscribed).not.toHaveBeenCalledWith(true);
    expect(clearPub!.track).toBeUndefined();
    act(() => room().emit(RoomEvent.TrackSubscribed, sealedPub!.track, sealedPub, room().remoteParticipants.get("bia")));
    const people = Object.fromEntries(result.current.participants.map((p) => [p.identity, p.tracks]));
    expect(people.bia.audio).toBe(sealedPub!.track!.mediaStreamTrack);
    expect(people.eve.camera).toBeNull();
  });

  it("a publication in the clear that comes later is not taken, and one the SFU sends all the same is dropped and not played", async () => {
    const { result } = await joined({ e2ee: key(4, 7) });
    const eve = room().join("eve", "Eve");
    const later = eve.publish(Source.Microphone, "audio", { subscribed: false, encrypted: false });
    act(() => room().emit(RoomEvent.TrackPublished, later, eve));
    expect(later.setSubscribed).not.toHaveBeenCalledWith(true);
    expect(later.track).toBeUndefined();
    // Sent anyway (a server that subscribes on its own): unsubscribed at once, and the window never gets it.
    const pushed = eve.publish(Source.Camera, "video", { encrypted: false });
    act(() => room().emit(RoomEvent.TrackSubscribed, pushed.track, pushed, eve));
    expect(pushed.setSubscribed).toHaveBeenCalledWith(false);
    expect(result.current.participants.find((p) => p.identity === "eve")?.tracks).toMatchObject({ audio: null, camera: null });
    // A sealed one that comes later is taken.
    const sealedLater = eve.publish(Source.ScreenShare, "video", { subscribed: false });
    act(() => room().emit(RoomEvent.TrackPublished, sealedLater, eve));
    expect(sealedLater.setSubscribed).toHaveBeenCalledWith(true);
  });

  it("sets the new epoch's key in the call when the group moves on, without joining again", async () => {
    const hook = await joined({ e2ee: key(4, 7) });
    const [provider] = FakeKeyProvider.providers;
    hook.rerender({ url: "wss://call.example", token: "pass", loadLivekit, e2ee: key(5, 9) });
    await waitFor(() => expect(provider.keys).toEqual([Array(32).fill(7), Array(32).fill(9)]));
    // The same epoch again (a new object for the same key) sets nothing.
    hook.rerender({ url: "wss://call.example", token: "pass", loadLivekit, e2ee: key(5, 9) });
    await act(async () => {});
    expect(provider.keys).toHaveLength(2);
    expect(FakeRoom.rooms).toHaveLength(1);
    expect(room().connect).toHaveBeenCalledTimes(1);
    expect(hook.result.current.status).toBe("connected");
  });

  it("a browser that can't seal call media joins nothing, and says why", async () => {
    sealing = false;
    const { result } = renderHook(() => useGroupCall({ url: "wss://call.example", token: "pass", e2ee: key(4, 7), loadLivekit }));
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.error).toMatchObject({ action: "join", message: NO_SEALING });
    expect(FakeRoom.rooms).toHaveLength(0);
    expect(FakeWorker.workers).toHaveLength(0);
  });

  it("without the group's call key (null) joins nothing, and says why", async () => {
    const { result } = renderHook(() => useGroupCall({ url: "wss://call.example", token: "pass", e2ee: null, loadLivekit }));
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.error).toMatchObject({ action: "join", message: NO_CALL_KEY });
    expect(loadLivekit).not.toHaveBeenCalled();
    expect(FakeRoom.rooms).toHaveLength(0);
  });

  it("leaving ends the E2EE worker with the room", async () => {
    const { result } = await joined({ e2ee: key(4, 7) });
    await act(() => result.current.leave());
    expect(room().disconnect).toHaveBeenCalledWith(true);
    expect(FakeWorker.workers[0].terminate).toHaveBeenCalled();
  });

  it("without e2ee the room is joined as before: no encryption, no key provider, no worker", async () => {
    FakeRoom.atJoin = (r) => {
      const bia = new FakeParticipant("bia", "Bia");
      bia.publish(Source.Microphone, "audio", { encrypted: false });
      r.remoteParticipants.set("bia", bia);
    };
    const { result } = await joined();
    expect(room().options).toEqual({ adaptiveStream: false, dynacast: true });
    expect(room().connect).toHaveBeenCalledWith("wss://call.example", "pass", undefined);
    // LiveKit subscribes by itself, and an unsealed call plays what it gets.
    const bia = room().remoteParticipants.get("bia")!;
    expect(bia.getTrackPublication(Source.Microphone)!.setSubscribed).not.toHaveBeenCalled();
    expect(result.current.participants[0].tracks.audio).toBe(bia.getTrackPublication(Source.Microphone)!.track!.mediaStreamTrack);
    expect(room().setE2EEEnabled).not.toHaveBeenCalled();
    expect(FakeKeyProvider.providers).toHaveLength(0);
    expect(FakeWorker.workers).toHaveLength(0);
  });
});
