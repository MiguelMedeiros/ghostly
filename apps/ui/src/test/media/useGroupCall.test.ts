import { act, renderHook, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUP_CALL_MUTED_ABOVE, joinsMuted, NO_RELAY, useGroupCall, type LivekitModule, type UseGroupCallOptions } from "../../hooks/useGroupCall";
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
  constructor(readonly source: SourceName, public track: FakeLocalTrack | undefined) {}
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

  /** A remote participant's track, subscribed. */
  publish(source: SourceName, kind: "audio" | "video") {
    const pub = new FakePublication(source, new FakeLocalTrack(new FakeTrack(kind) as unknown as MediaStreamTrack));
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
    const fails = FakeRoom.micFails;
    FakeRoom.micFails = null;
    if (fails) throw fails;
    return this.toggle(Source.Microphone, "audio", on);
  });
  readonly setCameraEnabled = vi.fn(async (on: boolean, _options?: unknown) => this.toggle(Source.Camera, "video", on));
  readonly publishTrack = vi.fn(async (track: MediaStreamTrack, options: { source: SourceName }) => {
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
  readonly remoteParticipants = new Map<string, FakeParticipant>();
  activeSpeakers: FakeParticipant[] = [];
  readonly localParticipant = new FakeLocalParticipant(this);
  private readonly listeners = new Map<string, Set<() => void>>();
  readonly connect = vi.fn(async (_url: string, _token: string, _opts?: { rtcConfig?: RTCConfiguration }) => {
    for (const id of FakeRoom.waiting) this.remoteParticipants.set(id, new FakeParticipant(id, id.toUpperCase()));
  });
  // Like LiveKit's, but stops nothing itself: the hook must stop its own tracks.
  readonly disconnect = vi.fn(async (_stopTracks?: boolean) => {
    this.emit(RoomEvent.Disconnected);
  });
  constructor(readonly options: unknown) {
    FakeRoom.rooms.push(this);
  }
  on(event: string, listener: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }
  off(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
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

const fakeLivekit = { Room: FakeRoom, RoomEvent, Track: { Source } } as unknown as LivekitModule;
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
  FakeRoom.waiting = [];
  FakeRoom.micFails = null;
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

  it("loads livekit-client only at the join, never at the module's import", () => {
    const source = readFileSync(join(fileURLToPath(import.meta.url), "../../../hooks/useGroupCall.ts"), "utf8");
    const statics = source.match(/^import\s+(?!type\b)[^;]*from\s+["']livekit-client["']/gm);
    expect(statics).toBeNull();
    expect(source).toContain('import("livekit-client")');
  });
});
