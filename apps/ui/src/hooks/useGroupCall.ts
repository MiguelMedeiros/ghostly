import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalTrackPublication, Participant, RemoteTrackPublication, Room, TrackPublication } from "livekit-client";
import { callRtcConfig } from "@ghostly/core";
import { screenShareErrorMessage } from "@ghostly/react";
import { preferredDevice } from "../lib/mediaDevices";
import type { GroupCallParticipant, GroupCallState } from "../components/GroupCallView";

/*
 * A group call through the group's node (WISP 602): joins the LiveKit room the node's pass names, and gives the call
 * window everyone in it, who speaks, and your microphone, camera and screen. livekit-client is loaded only here, at
 * the join, so the app's first load does not carry it; nor its E2EE worker, which a sealed call starts.
 */

/** What the hook uses of livekit-client. Tests pass a fake through `loadLivekit` (no WebRTC in the test DOM). */
export type LivekitModule = typeof import("./groupCallLivekit");

const loadLivekitClient = (): Promise<LivekitModule> => import("./groupCallLivekit");

/** The node's pass, as its reply gives it (WISP 602): where the room is, the token, and TURN when it sends some. */
export interface GroupCallJoin {
  url: string;
  token: string;
  iceServers?: RTCIceServer[];
}

/** The group's call key for one epoch (WISP 602 § End-to-end encryption): the engine's `groupCallKey`, as bytes. */
export interface GroupCallSeal {
  epoch: number;
  key: Uint8Array;
}

export interface UseGroupCallOptions extends GroupCallJoin {
  /**
   * Set when the group's call says `e2ee: 1`: the media is sealed end to end with this key, and the room is never
   * joined unsealed. Null: the key is not here (yet), so the room is not joined. A new epoch's key is set in the call
   * as it comes. Left out: the call is not sealed.
   */
  e2ee?: GroupCallSeal | null;
  /**
   * "Hide my IP from contacts": the media goes through the pass's TURN servers alone (`iceTransportPolicy: "relay"`),
   * and a pass without one is not joined (`groupCallRelayConfig`).
   */
  relayOnly?: boolean;
  /** Where livekit-client comes from; only tests set it. */
  loadLivekit?: () => Promise<LivekitModule>;
}

export type GroupCallStatus = "idle" | "connecting" | "connected" | "left" | "failed";

/** What went wrong last. `message` is the screen share's line (`screenShareErrorMessage`) or the error's own. */
export interface GroupCallError {
  action: "join" | "mic" | "camera" | "screen";
  message: string;
  cause?: unknown;
}

export interface GroupCall extends GroupCallState {
  status: GroupCallStatus;
  error: GroupCallError | null;
  toggleMic: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  toggleScreen: () => Promise<void>;
  /** Leaves the room and stops every track this call captured. */
  leave: () => Promise<void>;
}

/** Why a room is not joined with "Hide my IP from contacts" on: the node's pass names no TURN server to go through. */
export const NO_RELAY = "The call node gave no TURN server, and Hide my IP from contacts is on";

/** Why a sealed call is not joined: this browser cannot seal call media (no Insertable Streams, no RTCRtpScriptTransform). */
export const NO_SEALING = "This browser can't seal call media end to end, and this group's call asks for it";

/** Why a sealed call is not joined: the group's call key for this epoch is not on this device yet. */
export const NO_CALL_KEY = "This group's call key is not here yet";

/**
 * The room's WebRTC configuration under "Hide my IP from contacts", as a 1:1 call's (`callRtcConfig`): the pass's TURN
 * servers alone, and the relay policy, so no candidate but the relay's reaches the node. No server: nothing to join by.
 */
export function groupCallRelayConfig(iceServers: readonly RTCIceServer[] = []): RTCConfiguration {
  return callRtcConfig(iceServers, { relayOnly: true });
}

/** Past this many people in the room (you included), you join with the microphone off (phase2-sfu.md §4). */
export const GROUP_CALL_MUTED_ABOVE = 8;

/** Whether someone joining a room of `count` people (themselves included) starts muted. */
export const joinsMuted = (count: number): boolean => count > GROUP_CALL_MUTED_ABOVE;

const NOBODY: GroupCallParticipant = { identity: "", name: "", mic: false, camera: false, screen: false, speaking: false, tracks: {} };
const EMPTY: GroupCallState = { participants: [], activeSpeaker: null, local: NOBODY };

interface Session {
  lk?: LivekitModule;
  room?: Room;
  /** A sealed call's key provider, the epoch of the key set in it, and its E2EE worker. */
  keys?: InstanceType<LivekitModule["ExternalE2EEKeyProvider"]>;
  epoch?: number;
  worker?: Worker;
  /** Joined under "Hide my IP from contacts" (the relay policy). */
  relayed: boolean;
  ended: boolean;
  screen: MediaStreamTrack | null;
  screenEnded: (() => void) | null;
  screenAsking: boolean;
  refresh: () => void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error ?? "")) || "failed";

/**
 * Whether a call may play a publication's media: in a sealed call, only what its sender sealed. LiveKit's E2EE hands
 * a publication the SFU marks unencrypted straight to the decoder (its worker's "known to publish unencrypted media"),
 * so someone the node lets in without the group's call key would be heard and seen in the clear.
 */
const playable = (pub: TrackPublication | undefined, sealed: boolean): boolean => !!pub && (!sealed || pub.isEncrypted);

function personOf(p: Participant, lk: LivekitModule, local: boolean, sealed: boolean): GroupCallParticipant {
  const { Source } = lk.Track;
  const track = (source: (typeof Source)[keyof typeof Source]) => {
    const pub = p.getTrackPublication(source);
    return local || playable(pub, sealed) ? (pub?.track?.mediaStreamTrack ?? null) : null;
  };
  return {
    identity: p.identity,
    name: p.name || p.identity,
    mic: p.isMicrophoneEnabled,
    camera: p.isCameraEnabled,
    screen: p.isScreenShareEnabled,
    speaking: p.isSpeaking,
    // Your own voice is never handed out: nothing can play it back to you.
    tracks: local
      ? { camera: track(Source.Camera), screen: track(Source.ScreenShare) }
      : { audio: track(Source.Microphone), camera: track(Source.Camera), screen: track(Source.ScreenShare) },
  };
}

function snapshot(room: Room, lk: LivekitModule, sealed: boolean): GroupCallState {
  return {
    local: personOf(room.localParticipant, lk, true, sealed),
    participants: [...room.remoteParticipants.values()].map((p) => personOf(p, lk, false, sealed)),
    activeSpeaker: room.activeSpeakers[0]?.identity ?? null,
  };
}

/** Takes the shared screen down and stops it; safe to call twice. */
async function stopScreen(session: Session): Promise<void> {
  const track = session.screen;
  if (!track) return;
  session.screen = null;
  if (session.screenEnded) track.removeEventListener("ended", session.screenEnded);
  session.screenEnded = null;
  try {
    await session.room?.localParticipant.unpublishTrack(track, true);
  } catch {
    // already gone from the room (it ended the share itself, or the room is closed)
  }
  track.stop();
}

/** Leaves the room and stops every local track; safe to call twice. */
async function endSession(session: Session): Promise<void> {
  if (session.ended) return;
  session.ended = true;
  await stopScreen(session);
  const room = session.room;
  if (!room) {
    session.worker?.terminate();
    return;
  }
  const tracks = [...room.localParticipant.trackPublications.values()].map((p: LocalTrackPublication) => p.track);
  try {
    await room.disconnect(true);
  } catch {
    // stopped below all the same
  }
  for (const track of tracks) {
    try {
      track?.stop();
    } catch {
      // a track that would not stop is already ended
    }
  }
  session.worker?.terminate();
}

/** The key's own bytes, as LiveKit takes raw key material (HKDF, not the passphrase's PBKDF2). */
const keyBytes = (key: Uint8Array): ArrayBuffer => new Uint8Array(key).buffer;

/** Sets the newest epoch's key in a sealed call once it differs from the one set (WISP 602: the new one at an epoch move). */
async function rekey(session: Session, seal: GroupCallSeal | null | undefined): Promise<void> {
  if (!session.keys || !seal || seal.epoch === session.epoch || session.ended) return;
  session.epoch = seal.epoch;
  await session.keys.setKey(keyBytes(seal.key));
}

/**
 * A sealed call subscribes by hand (`autoSubscribe: false`): to a publication its sender sealed, and never to one in the
 * clear, so unsealed media never reaches this device's decoder. Safe to call again for the same publication.
 */
function admit(pub: RemoteTrackPublication): void {
  const want = pub.isEncrypted;
  if (pub.isDesired !== want || pub.isSubscribed !== want) pub.setSubscribed(want);
}

/**
 * Joins the room at `url` with `token` while both are set, with the microphone on and the camera off, or muted past
 * `GROUP_CALL_MUTED_ABOVE` people. A new url or token leaves the old room first; unmounting leaves it too. `relayOnly`
 * turned on during a call joins the room again under the relay policy, with the microphone and camera as they were. With
 * `e2ee` set, the room is joined sealed with LiveKit's E2EE (a shared key from `ExternalE2EEKeyProvider`), or not at
 * all: never unsealed. Sealing turned on or off for the group joins the room again.
 */
export function useGroupCall({ url, token, iceServers, relayOnly = false, e2ee, loadLivekit }: UseGroupCallOptions): GroupCall {
  const [state, setState] = useState<GroupCallState>(EMPTY);
  const [status, setStatus] = useState<GroupCallStatus>("idle");
  const [error, setError] = useState<GroupCallError | null>(null);
  const session = useRef<Session | null>(null);
  // Read at the join: a new array for the same pass is not a new call.
  const ice = useRef(iceServers);
  ice.current = iceServers;
  const relay = useRef(relayOnly);
  relay.current = relayOnly;
  const load = useRef(loadLivekit);
  load.current = loadLivekit;
  const seal = useRef(e2ee);
  seal.current = e2ee;
  const sealed = e2ee !== undefined;
  // "Hide my IP from contacts" turned on in a room joined without it: the room is joined again, relay only. A room's
  // ICE policy is set at its join, and the direct path it found would stay until a rejoin.
  const [rejoin, setRejoin] = useState(0);
  const carry = useRef<{ mic: boolean; camera: boolean } | null>(null);

  useEffect(() => {
    const s = session.current;
    if (!relayOnly || !s || s.ended || s.relayed) return;
    const me = s.room?.localParticipant;
    carry.current = me ? { mic: me.isMicrophoneEnabled, camera: me.isCameraEnabled } : null;
    setRejoin((n) => n + 1);
  }, [relayOnly]);

  useEffect(() => {
    if (!url || !token) return;
    let live = true;
    const kept = carry.current;
    carry.current = null;
    const s: Session = { relayed: relay.current, ended: false, screen: null, screenEnded: null, screenAsking: false, refresh: () => {} };
    session.current = s;
    setState(EMPTY);
    setStatus("connecting");
    setError(null);

    void (async () => {
      try {
        const servers = ice.current;
        const rtcConfig = s.relayed ? groupCallRelayConfig(servers) : servers?.length ? { iceServers: servers } : undefined;
        // Nothing to relay through: joining would hand the node this device's address.
        if (s.relayed && !rtcConfig?.iceServers?.length) throw new Error(NO_RELAY);
        // A sealed call without its key is not joined: in the room the media would go unsealed, or not be heard.
        if (sealed && !seal.current) throw new Error(NO_CALL_KEY);
        const lk = await (load.current ?? loadLivekitClient)();
        if (!live) return;
        let encryption: { keyProvider: InstanceType<LivekitModule["ExternalE2EEKeyProvider"]>; worker: Worker } | undefined;
        if (sealed) {
          if (!lk.isE2EESupported()) throw new Error(NO_SEALING);
          const keyProvider = new lk.ExternalE2EEKeyProvider();
          s.keys = keyProvider;
          await rekey(s, seal.current);
          if (!live || s.ended) return;
          s.worker = lk.e2eeWorker();
          encryption = { keyProvider, worker: s.worker };
        }
        // No adaptive stream: the window draws the raw tracks in its own elements, which LiveKit would take as hidden.
        const room = new lk.Room({ adaptiveStream: false, dynacast: true, ...(encryption && { encryption }) });
        s.lk = lk;
        s.room = room;
        // Sealed before connecting, so no track ever goes out unsealed; a room that will not seal is not joined.
        if (encryption) await room.setE2EEEnabled(true);
        s.refresh = () => {
          if (live && !s.ended) setState(snapshot(room, lk, sealed));
        };
        const E = lk.RoomEvent;
        for (const event of [E.ParticipantConnected, E.ParticipantDisconnected, E.ParticipantNameChanged, E.TrackPublished,
          E.TrackUnpublished, E.TrackSubscribed, E.TrackUnsubscribed, E.TrackMuted, E.TrackUnmuted, E.LocalTrackPublished,
          E.LocalTrackUnpublished, E.ActiveSpeakersChanged, E.Reconnected]) room.on(event, s.refresh);
        if (encryption) {
          room.on(E.TrackPublished, (pub: RemoteTrackPublication) => admit(pub));
          // Not asked for with autoSubscribe off; a track in the clear that comes all the same is dropped.
          room.on(E.TrackSubscribed, (_track: unknown, pub: RemoteTrackPublication) => {
            if (!pub.isEncrypted) admit(pub);
          });
        }
        room.on(E.Disconnected, () => {
          // The node closed the room or dropped you: the call is over here too.
          if (s.ended) return;
          void endSession(s);
          if (live) setStatus("left");
        });
        const connectOptions = { ...(rtcConfig && { rtcConfig }), ...(encryption && { autoSubscribe: false }) };
        await room.connect(url, token, Object.keys(connectOptions).length ? connectOptions : undefined);
        if (!live || s.ended) {
          await endSession(s);
          return;
        }
        // What the room held at the join: its sealed publications, subscribed by hand.
        if (encryption) {
          for (const p of room.remoteParticipants.values()) {
            for (const pub of p.trackPublications.values()) admit(pub);
          }
        }
        // The group moved to a new epoch while joining.
        await rekey(s, seal.current);
        setStatus("connected");
        s.refresh();
        if (kept ? kept.mic : !joinsMuted(room.remoteParticipants.size + 1)) {
          try {
            await room.localParticipant.setMicrophoneEnabled(true, { deviceId: preferredDevice("audioinput") });
          } catch (cause) {
            // In the call all the same, muted: the person sees why and can try the button.
            if (live) setError({ action: "mic", message: messageOf(cause), cause });
          }
          s.refresh();
        }
        if (kept?.camera && live && !s.ended) {
          try {
            await room.localParticipant.setCameraEnabled(true, { deviceId: preferredDevice("videoinput") });
          } catch (cause) {
            if (live) setError({ action: "camera", message: messageOf(cause), cause });
          }
          s.refresh();
        }
      } catch (cause) {
        if (!live) return;
        await endSession(s);
        setStatus("failed");
        setError({ action: "join", message: messageOf(cause), cause });
      }
    })();

    return () => {
      live = false;
      void endSession(s);
      if (session.current === s) session.current = null;
    };
  }, [url, token, sealed, rejoin]);

  // The group moved to a new epoch: its key goes into the call; everyone in the room does the same (WISP 602).
  const sealEpoch = e2ee?.epoch;
  useEffect(() => {
    const s = session.current;
    if (s) void rekey(s, seal.current).catch(() => { /* the room keeps the key it had */ });
  }, [sealEpoch]);

  const active = () => {
    const s = session.current;
    return s && s.room && !s.ended ? (s as Session & { room: Room; lk: LivekitModule }) : null;
  };

  const toggleMic = useCallback(async () => {
    const s = active();
    if (!s) return;
    const on = !s.room.localParticipant.isMicrophoneEnabled;
    try {
      await s.room.localParticipant.setMicrophoneEnabled(on, on ? { deviceId: preferredDevice("audioinput") } : undefined);
      if (on) setError(null);
    } catch (cause) {
      setError({ action: "mic", message: messageOf(cause), cause });
    }
    s.refresh();
  }, []);

  const toggleCamera = useCallback(async () => {
    const s = active();
    if (!s) return;
    const on = !s.room.localParticipant.isCameraEnabled;
    try {
      await s.room.localParticipant.setCameraEnabled(on, on ? { deviceId: preferredDevice("videoinput") } : undefined);
      if (on) setError(null);
    } catch (cause) {
      setError({ action: "camera", message: messageOf(cause), cause });
    }
    s.refresh();
  }, []);

  const toggleScreen = useCallback(async () => {
    const s = active();
    if (!s || s.screenAsking) return;
    if (s.screen) {
      await stopScreen(s);
      s.refresh();
      return;
    }
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (typeof media?.getDisplayMedia !== "function") {
      setError({ action: "screen", message: screenShareErrorMessage({ name: "NotSupportedError" }) ?? "" });
      return;
    }
    s.screenAsking = true;
    const asked = Date.now();
    let stream: MediaStream;
    try {
      stream = await media.getDisplayMedia({ video: true, audio: false });
    } catch (cause) {
      s.screenAsking = false;
      // null: the person closed the picker, nothing to say
      const message = screenShareErrorMessage(cause, Date.now() - asked);
      if (message) setError({ action: "screen", message, cause });
      return;
    }
    s.screenAsking = false;
    const [track, ...rest] = stream.getVideoTracks();
    for (const other of [...rest, ...stream.getAudioTracks()]) other.stop();
    if (!track) return;
    if (s.ended) {
      track.stop();
      return;
    }
    s.screen = track;
    // The browser's own "Stop sharing" bar ends the track: take it out of the room as the button would.
    s.screenEnded = () => void stopScreen(s).then(s.refresh);
    track.addEventListener("ended", s.screenEnded);
    try {
      await s.room.localParticipant.publishTrack(track, { source: s.lk.Track.Source.ScreenShare });
      setError(null);
    } catch (cause) {
      await stopScreen(s);
      setError({ action: "screen", message: screenShareErrorMessage(cause) ?? messageOf(cause), cause });
    }
    s.refresh();
  }, []);

  const leave = useCallback(async () => {
    const s = session.current;
    if (!s || s.ended) return;
    await endSession(s);
    setStatus("left");
  }, []);

  return { ...state, status, error, toggleMic, toggleCamera, toggleScreen, leave };
}
