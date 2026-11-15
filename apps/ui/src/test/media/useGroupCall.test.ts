import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView } from "@ghostly/browser/shared/types";
import { GroupCallView } from "../../components/GroupCallView";
import { GROUP_CALL_MUTED_ABOVE, joinsMuted, useGroupCall, type GroupCall, type LivekitModule, type UseGroupCallOptions } from "../../hooks/useGroupCall";
import { authorName, groupCallNameOf } from "../../lib/groups";
import { chooseDevice } from "../../lib/mediaDevices";
import { keyEnd } from "../../lib/publicKeyLabel";
import { loadLocale, translatorFor } from "../../locales";
import { FakeTrack } from "../../../../../packages/react/test/fakes";
import { renderApp } from "../render";

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
    await waitFor(() => expect(result.current.local).toMatchObject({ identity: "me", name: keyEnd("me"), mic: true, camera: false, screen: false }));
    // your own voice is not handed to the window
    expect(result.current.local.tracks.audio).toBeUndefined();
  });

  it("connects with LiveKit's own ICE servers when the pass has none", async () => {
    await joined();
    expect(room().connect).toHaveBeenCalledWith("wss://call.example", "pass", undefined);
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
    expect(result.current.participants.map((p) => [p.identity, p.name])).toEqual([["ana", keyEnd("ana")], ["bo", keyEnd("bo")]]);
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

/*
 * Who is who in the call. The node's pass puts a name beside each key, and nothing signs it: anyone can ask for the
 * name another member shows. Each person is named by their key, as the group's chat names them.
 */
const keyOf = (start: string, end: string) => start.padEnd(46, "y") + end;
const ANA = keyOf("ana", "an4aaa");
const ANA_TOO = keyOf("anatoo", "an4bbb");
const MIGUEL = keyOf("miguel", "k1p0aa");
const STRANGER = keyOf("stranger", "str4ng");
const member = (key: string, nick?: string, me = false): GroupMemberView =>
  ({ key, role: "member", me, online: true, missing: 0, ...(nick !== undefined && { nick }) });
/** A community where two members go by Ana. The fake room's own key is "me". */
const community = (nicks: Record<string, string> = {}) => ({
  profile: "community" as const,
  members: [member("me", undefined, true), member(ANA, nicks[ANA] ?? "Ana"), member(ANA_TOO, "Ana"), member(MIGUEL, "Miguel")],
});

/** The call window over the hook's state, as GroupCallButton draws it. */
function drawn(call: GroupCall) {
  const noop = () => {};
  renderApp(createElement(GroupCallView, { call, groupName: "Community", onToggleMic: noop, onToggleCamera: noop, onToggleScreen: noop, onLeave: noop }));
  return (identity: string) => screen.getAllByTestId("group-call-tile").find((tile) => tile.dataset.identity === identity)!;
}

describe("useGroupCall's names", () => {
  it("tells two people the node calls Ana apart by their key's end, as the group's chat does", async () => {
    const group = community();
    const { result } = await joined({ nameOf: groupCallNameOf(group) });
    act(() => {
      room().join(ANA, "Ana");
      room().join(ANA_TOO, "Ana");
    });
    expect(result.current.participants.map((p) => p.name)).toEqual([`Ana ${keyEnd(ANA)}`, `Ana ${keyEnd(ANA_TOO)}`]);
    expect(result.current.participants.map((p) => p.name)).toEqual([authorName(group, ANA), authorName(group, ANA_TOO)]);
    const tile = drawn(result.current);
    expect(tile(ANA)).toHaveTextContent(`Ana ${keyEnd(ANA)}`);
    expect(tile(ANA_TOO)).toHaveTextContent(`Ana ${keyEnd(ANA_TOO)}`);
    expect(keyEnd(ANA)).toBe("\u2066(…an4aaa)\u2069");
  });

  it("names someone not in the group as not in it, never by the name the node gave them", async () => {
    const { result } = await joined({ nameOf: groupCallNameOf(community()) });
    act(() => {
      room().join(MIGUEL, "Miguel");
      room().join(STRANGER, "Miguel");
    });
    expect(result.current.participants.map((p) => p.name)).toEqual(["Miguel", `Not in this group ${keyEnd(STRANGER)}`]);
    const tile = drawn(result.current);
    expect(tile(MIGUEL)).toHaveTextContent("Miguel");
    expect(tile(STRANGER)).toHaveTextContent(`Not in this group ${keyEnd(STRANGER)}`);
    expect(tile(STRANGER)).not.toHaveTextContent("Miguel");
  });

  it("follows the roster: a member renamed there is renamed in the call, with no event from the room", async () => {
    const { result, rerender } = await joined({ nameOf: groupCallNameOf(community()) });
    act(() => void room().join(ANA, "Ana"));
    expect(result.current.participants[0]!.name).toBe(`Ana ${keyEnd(ANA)}`);
    rerender({ url: "wss://call.example", token: "pass", loadLivekit, nameOf: groupCallNameOf(community({ [ANA]: "Ana Paula" })) });
    expect(result.current.participants[0]!.name).toBe("Ana Paula");
    expect(room().connect).toHaveBeenCalledTimes(1);
  });

  it("without nameOf, names each person by their key's end: the node's names reach nothing", async () => {
    const { result } = await joined();
    act(() => {
      room().join(ANA, "Ana");
      room().join("bo", "Bo");
    });
    expect(result.current.local.name).toBe(keyEnd("me"));
    expect(result.current.participants.map((p) => p.name)).toEqual([keyEnd(ANA), keyEnd("bo")]);
    const state = JSON.stringify({ local: result.current.local, participants: result.current.participants });
    for (const name of ['"Ana"', '"Bo"', '"Me"']) expect(state).not.toContain(name);
  });
});

describe("groupCallNameOf", () => {
  it("names a member as the group's chat does, me included", () => {
    const group = community();
    const nameOf = groupCallNameOf(group);
    for (const key of ["me", ANA, ANA_TOO, MIGUEL]) expect(nameOf(key)).toBe(authorName(group, key));
    expect(nameOf("me")).toBe("You");
    expect(nameOf(ANA)).toBe(`Ana ${keyEnd(ANA)}`);
    expect(nameOf(MIGUEL)).toBe("Miguel");
    // a member with no name goes by their key, as in the chat
    expect(groupCallNameOf({ members: [member(ANA)] })(ANA)).toBe(authorName({ members: [member(ANA)] }, ANA));
  });

  it("says a key not in the roster is not in the group, a former member's too", () => {
    const group = { ...community(), formerNames: { [STRANGER]: "Miguel" } };
    expect(groupCallNameOf(group)(STRANGER)).toBe(`Not in this group ${keyEnd(STRANGER)}`);
    expect(groupCallNameOf(group)(STRANGER)).not.toContain("Miguel");
  });

  it("says it in the interface's language, the key's end isolated left to right", async () => {
    await loadLocale("pt");
    await loadLocale("ar");
    expect(groupCallNameOf(community(), translatorFor("pt"))(STRANGER)).toBe("Não está neste grupo \u2066(…str4ng)\u2069");
    expect(groupCallNameOf(community(), translatorFor("ar"))(STRANGER)).toBe("ليس في هذه المجموعة \u2066(…str4ng)\u2069");
    expect(groupCallNameOf(community(), translatorFor("pt"))("me")).toBe("Você");
  });
});
