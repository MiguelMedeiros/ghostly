import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalTrackPublication, Participant, RemoteTrackPublication, Room, Track, TrackPublication } from "livekit-client";
import { callRtcConfig } from "@ghostly/core";
import { screenShareErrorMessage } from "@ghostly/react";
import { preferredDevice, trackDevice } from "../lib/mediaDevices";
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
  /**
   * The pass a join again under `relayOnly` uses, when there is a newer one still good: the one the room was joined
   * with lasts an hour at most (WISP 602), and a call that outlived it was refused at its rejoin.
   */
  newest?: () => GroupCallJoin | null;
  /** Where livekit-client comes from; only tests set it. */
  loadLivekit?: () => Promise<LivekitModule>;
  /** How long a sealed room may take after its connect to say it seals (`SEAL_WAIT_MS`); only tests set it. */
  sealWaitMs?: number;
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
  /** The status is "left" because the group's admin took you out of the room (WISP 602 § Moderation), not by your own Leave. */
  removedByAdmin: boolean;
  /** Your microphone's capture, muted or not; null before it was first turned on. Never played: the device checks read it. */
  micTrack: MediaStreamTrack | null;
  toggleMic: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  toggleScreen: () => Promise<void>;
  /**
   * Captures from another microphone or camera (null: the default) in the call's own track, as `useCallDevices` asks.
   * Off, it is taken when turned on. Rejects when that device would not open: the call goes on with the one it had.
   */
  switchMicrophone: (deviceId: string | null) => Promise<void>;
  switchCamera: (deviceId: string | null) => Promise<void>;
  /** Leaves the room and stops every track this call captured. */
  leave: () => Promise<void>;
}

/** Why a room is not joined with "Hide my IP from contacts" on: the node's pass names no TURN server to go through. */
export const NO_RELAY = "The call node gave no TURN server, and Hide my IP from contacts is on";

/** Why a sealed call is not joined: this browser cannot seal call media (no Insertable Streams, no RTCRtpScriptTransform). */
export const NO_SEALING = "This browser can't seal call media end to end, and this group's call asks for it";

/** Why a sealed call is not joined: the group's call key for this epoch is not on this device yet. */
export const NO_CALL_KEY = "This group's call key is not here yet";

/** Why a sealed call was left: once in the room, LiveKit did not show it seals this device's media (`unsealedBy`). */
export const NOT_SEALED = "This call could not be sealed end to end, so this app left it";

/** How long a sealed room may take, after its connect, for its E2EE worker to say it seals this device's media. */
export const SEAL_WAIT_MS = 10_000;

/** LiveKit's mark on a sender whose encoded frames go through its E2EE worker (`E2EE_FLAG`, livekit-client e2ee/constants.ts). */
const LIVEKIT_SEALED_SENDER = "lk_e2ee";

/**
 * Why a room joined sealed does not seal this device's media now, or null when it does (WISP 602 § End-to-end
 * encryption): the room has its E2EE worker and LiveKit's E2EE manager, its sender encryption is on (`isE2EEEnabled`,
 * which LiveKit sets once the worker says so), and each track this device publishes goes through the worker: its
 * sender carries LiveKit's mark (Insertable Streams) or a script transform, and the SFU lists it as encrypted. The
 * signals the e2e's seal probe reads (e2e/support/sealProbe.ts), checked by the app: never a call left unsealed.
 */
export function unsealedBy(room: Room, worker: Worker | undefined): string | null {
  if (!worker) return "no E2EE worker";
  if (!room.hasE2EESetup) return "no E2EE manager on the room";
  if (!room.isE2EEEnabled || !room.localParticipant.isE2EEEnabled) return "the room's E2EE is not on for this device";
  for (const pub of room.localParticipant.trackPublications.values()) {
    const sender = pub.track?.sender as (RTCRtpSender & { transform?: unknown }) | undefined;
    // No sender: nothing of this track goes out.
    if (!sender) continue;
    if (!(LIVEKIT_SEALED_SENDER in sender) && !sender.transform) return `the ${pub.source} sender has no E2EE transform`;
    if (!pub.isEncrypted) return `the ${pub.source} track is not published as encrypted`;
  }
  return null;
}

/** Whether the room's E2EE comes on within `ms` (LiveKit sets `isE2EEEnabled` when its worker answers), while `alive`. */
async function sealsWithin(room: Room, ms: number, alive: () => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (!room.isE2EEEnabled && alive() && Date.now() < until) await new Promise((done) => setTimeout(done, 50));
  return room.isE2EEEnabled;
}

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

/** LiveKit's protocol numbers for the sources an admin can take away (its `TrackSource`, as `canPublishSources` holds them). */
const PROTO_SOURCE = { mic: 2, camera: 1, screen: 3 } as const;

/** LiveKit's `DisconnectReason.PARTICIPANT_REMOVED`: the node took this device out of the room (`RemoveParticipant`). */
const PARTICIPANT_REMOVED = 4;

/**
 * What the group's admin took away from someone in this call (WISP 602 § Moderation): a source left out of their
 * `canPublishSources`. An empty list is LiveKit's "every source", so every source taken is `canPublish` off.
 */
function heldOf(p: Participant): NonNullable<GroupCallParticipant["byAdmin"]> {
  const none = p.permissions?.canPublish === false;
  const allowed = p.permissions?.canPublishSources ?? [];
  const held = (source: keyof typeof PROTO_SOURCE) => none || (allowed.length > 0 && !allowed.includes(PROTO_SOURCE[source]));
  return { mic: held("mic"), camera: held("camera"), screen: held("screen") };
}

const NOBODY: GroupCallParticipant = { identity: "", name: "", mic: false, camera: false, screen: false, speaking: false, tracks: {} };
/** What the room shows now, and your own microphone's capture, which no tile carries. */
type Snapshot = GroupCallState & { micTrack: MediaStreamTrack | null };
const EMPTY: Snapshot = { participants: [], activeSpeaker: null, local: NOBODY, micTrack: null };

interface Session {
  lk?: LivekitModule;
  room?: Room;
  /** A sealed call's key provider (each epoch's key in its own slot), the epoch of the key set in it, and its E2EE worker. */
  keys?: InstanceType<LivekitModule["GroupCallKeyProvider"]>;
  epoch?: number;
  worker?: Worker;
  /** Joined under "Hide my IP from contacts" (the relay policy). */
  relayed: boolean;
  /**
   * In a sealed call, once the room said it seals: checks it still does (`unsealedBy`), and otherwise leaves the room,
   * stops every track and says why. True while sealed, and in a call that is not sealed.
   */
  sealedStill: () => boolean;
  ended: boolean;
  screen: MediaStreamTrack | null;
  screenEnded: (() => void) | null;
  screenAsking: boolean;
  refresh: () => void;
}

/** The system's default device, as asked of a capture that had a chosen one: browsers without a "default" entry take theirs. */
const DEFAULT_DEVICE: ConstrainDOMString = { ideal: "default" };

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
    byAdmin: heldOf(p),
    // Your own voice is never handed out: nothing can play it back to you.
    tracks: local
      ? { camera: track(Source.Camera), screen: track(Source.ScreenShare) }
      : { audio: track(Source.Microphone), camera: track(Source.Camera), screen: track(Source.ScreenShare) },
  };
}

function snapshot(room: Room, lk: LivekitModule, sealed: boolean): Snapshot {
  return {
    local: personOf(room.localParticipant, lk, true, sealed),
    participants: [...room.remoteParticipants.values()].map((p) => personOf(p, lk, false, sealed)),
    activeSpeaker: room.activeSpeakers[0]?.identity ?? null,
    micTrack: room.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.track?.mediaStreamTrack ?? null,
  };
}

/**
 * Captures `source` from `deviceId` (null: the default) through LiveKit's own track: a live capture restarts on it at
 * once, one turned off takes it when turned on again. Exactly that device, so one that will not open says so; LiveKit
 * stops the old capture before opening the new, and the one it had is opened again then.
 */
async function switchInput(room: Room, source: Track.Source, deviceId: string | null): Promise<void> {
  const track = room.localParticipant.getTrackPublication(source)?.track;
  // Never on in this call: turned on, it opens the device chosen then (`preferredDevice`).
  if (!track) return;
  const was = trackDevice(track.mediaStreamTrack);
  try {
    await track.setDeviceId(deviceId ? { exact: deviceId } : DEFAULT_DEVICE);
  } catch (error) {
    if (track.mediaStreamTrack.readyState === "ended" && !track.isMuted) await track.setDeviceId(was ? { ideal: was } : DEFAULT_DEVICE).catch(() => {});
    throw error;
  }
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

/**
 * Stops what the admin took away from you (WISP 602 § Moderation): the node already mutes it in the room, and this
 * device stops capturing it too. Given back, it stays off until you turn it on.
 */
async function dropHeld(session: Session, room: Room, lk: LivekitModule): Promise<void> {
  const me = room.localParticipant;
  const held = heldOf(me);
  if (held.screen) await stopScreen(session);
  const { Source } = lk.Track;
  for (const source of [held.mic && Source.Microphone, held.camera && Source.Camera]) {
    const track = source ? me.getTrackPublication(source)?.track : undefined;
    if (!track) continue;
    try {
      await me.unpublishTrack(track.mediaStreamTrack, true);
    } catch {
      // already gone from the room
    }
    track.stop();
  }
}

/** Leaves the room and stops every local track; safe to call twice. */
async function endSession(session: Session): Promise<void> {
  if (session.ended) return;
  session.ended = true;
  await stopScreen(session);
  session.keys?.dispose();
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

/**
 * Sets the newest epoch's key in a sealed call once it differs from the one set (WISP 602: the new one at an epoch
 * move), in its own slot (`GroupCallKeyProvider`): this device seals with it from then on, and still opens the frames
 * of members on the epoch before for a moment, so an epoch move drops nobody who already has the new key.
 */
async function rekey(session: Session, seal: GroupCallSeal | null | undefined): Promise<void> {
  if (!session.keys || !seal || seal.epoch === session.epoch || session.ended) return;
  session.epoch = seal.epoch;
  await session.keys.setEpochKey(seal.epoch, keyBytes(seal.key));
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
 * `e2ee` set, the room is joined sealed with LiveKit's E2EE (a shared key per epoch, `GroupCallKeyProvider`), or not
 * at all: never unsealed. Sealing turned on or off for the group joins the room again.
 */
export function useGroupCall({ url, token, iceServers, relayOnly = false, e2ee, newest, loadLivekit, sealWaitMs = SEAL_WAIT_MS }: UseGroupCallOptions): GroupCall {
  const [state, setState] = useState<Snapshot>(EMPTY);
  const [status, setStatus] = useState<GroupCallStatus>("idle");
  const [error, setError] = useState<GroupCallError | null>(null);
  const [removedByAdmin, setRemovedByAdmin] = useState(false);
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
  const sealWait = useRef(sealWaitMs);
  sealWait.current = sealWaitMs;
  const sealed = e2ee !== undefined;
  const latest = useRef(newest);
  latest.current = newest;
  // "Hide my IP from contacts" turned on in a room joined without it: the room is joined again, relay only. A room's
  // ICE policy is set at its join, and the direct path it found would stay until a rejoin.
  const [rejoin, setRejoin] = useState(0);
  const carry = useRef<{ mic: boolean; camera: boolean } | null>(null);
  const again = useRef(false);

  useEffect(() => {
    const s = session.current;
    if (!relayOnly || !s || s.ended || s.relayed) return;
    const me = s.room?.localParticipant;
    carry.current = me ? { mic: me.isMicrophoneEnabled, camera: me.isCameraEnabled } : null;
    again.current = true;
    setRejoin((n) => n + 1);
  }, [relayOnly]);

  useEffect(() => {
    if (!url || !token) return;
    let live = true;
    const kept = carry.current;
    carry.current = null;
    const pass = (again.current && latest.current?.()) || { url, token, iceServers: ice.current };
    again.current = false;
    const s: Session = { relayed: relay.current, ended: false, screen: null, screenEnded: null, screenAsking: false, refresh: () => {}, sealedStill: () => true };
    session.current = s;
    setState(EMPTY);
    setStatus("connecting");
    setError(null);
    setRemovedByAdmin(false);

    void (async () => {
      try {
        const servers = pass.iceServers;
        const rtcConfig = s.relayed ? groupCallRelayConfig(servers) : servers?.length ? { iceServers: servers } : undefined;
        // Nothing to relay through: joining would hand the node this device's address.
        if (s.relayed && !rtcConfig?.iceServers?.length) throw new Error(NO_RELAY);
        // A sealed call without its key is not joined: in the room the media would go unsealed, or not be heard.
        if (sealed && !seal.current) throw new Error(NO_CALL_KEY);
        const lk = await (load.current ?? loadLivekitClient)();
        if (!live) return;
        let encryption: { keyProvider: InstanceType<LivekitModule["GroupCallKeyProvider"]>; worker: Worker } | undefined;
        if (sealed) {
          if (!lk.isE2EESupported()) throw new Error(NO_SEALING);
          const keyProvider = new lk.GroupCallKeyProvider();
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
        // A sealed room that does not seal is left at once: the room, every track, and the reason said (fail closed).
        let sealChecked = false;
        s.sealedStill = () => {
          if (!encryption || !sealChecked || s.ended) return !s.ended;
          const why = unsealedBy(room, s.worker);
          if (!why) return true;
          void endSession(s);
          if (live) {
            setStatus("failed");
            setError({ action: "join", message: NOT_SEALED, cause: why });
          }
          return false;
        };
        if (encryption) {
          room.on(E.LocalTrackPublished, () => void s.sealedStill());
          if (E.ParticipantEncryptionStatusChanged) room.on(E.ParticipantEncryptionStatusChanged, () => void s.sealedStill());
        }
        // The admin took a source away from you, or gave it back: what was taken stops here too, and every tile shows it.
        if (E.ParticipantPermissionsChanged) {
          room.on(E.ParticipantPermissionsChanged, (_before: unknown, who: Participant) => {
            if (who !== room.localParticipant) return s.refresh();
            void dropHeld(s, room, lk).then(() => s.sealedStill() && s.refresh());
          });
        }
        room.on(E.Disconnected, (reason?: number) => {
          // The node closed the room or dropped you: the call is over here too. Your own Leave ended the session first.
          if (s.ended) return;
          void endSession(s);
          if (!live) return;
          setRemovedByAdmin(reason === PARTICIPANT_REMOVED);
          setStatus("left");
        });
        const connectOptions = { ...(rtcConfig && { rtcConfig }), ...(encryption && { autoSubscribe: false }) };
        await room.connect(pass.url, pass.token, Object.keys(connectOptions).length ? connectOptions : undefined);
        if (!live || s.ended) {
          await endSession(s);
          return;
        }
        // Nothing goes out until the room says it seals: LiveKit's worker turns its E2EE on, else the room is left.
        if (encryption) {
          await sealsWithin(room, sealWait.current, () => live && !s.ended);
          if (!live || s.ended) return;
          sealChecked = true;
          if (!s.sealedStill()) return;
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
        // A pass that leaves the microphone or camera out (the admin muted you before you joined) opens neither.
        const held = heldOf(room.localParticipant);
        if (!held.mic && (kept ? kept.mic : !joinsMuted(room.remoteParticipants.size + 1))) {
          try {
            await room.localParticipant.setMicrophoneEnabled(true, { deviceId: preferredDevice("audioinput") });
          } catch (cause) {
            // In the call all the same, muted: the person sees why and can try the button.
            if (live) setError({ action: "mic", message: messageOf(cause), cause });
          }
          if (!s.sealedStill()) return;
          s.refresh();
        }
        if (kept?.camera && !held.camera && live && !s.ended) {
          try {
            await room.localParticipant.setCameraEnabled(true, { deviceId: preferredDevice("videoinput") });
          } catch (cause) {
            if (live) setError({ action: "camera", message: messageOf(cause), cause });
          }
          if (!s.sealedStill()) return;
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
    // Taken away by the admin: it stays off until they allow it (the room would refuse it anyway).
    if (on && heldOf(s.room.localParticipant).mic) return;
    try {
      await s.room.localParticipant.setMicrophoneEnabled(on, on ? { deviceId: preferredDevice("audioinput") } : undefined);
      if (on && !s.ended) setError(null);
    } catch (cause) {
      setError({ action: "mic", message: messageOf(cause), cause });
    }
    if (s.sealedStill()) s.refresh();
  }, []);

  const toggleCamera = useCallback(async () => {
    const s = active();
    if (!s) return;
    const on = !s.room.localParticipant.isCameraEnabled;
    if (on && heldOf(s.room.localParticipant).camera) return;
    try {
      await s.room.localParticipant.setCameraEnabled(on, on ? { deviceId: preferredDevice("videoinput") } : undefined);
      if (on && !s.ended) setError(null);
    } catch (cause) {
      setError({ action: "camera", message: messageOf(cause), cause });
    }
    if (s.sealedStill()) s.refresh();
  }, []);

  const toggleScreen = useCallback(async () => {
    const s = active();
    if (!s || s.screenAsking) return;
    if (s.screen) {
      await stopScreen(s);
      s.refresh();
      return;
    }
    if (heldOf(s.room.localParticipant).screen) return;
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
      // Not over a seal check's reason: a screen that went out unsealed left the call (`sealedStill`).
      if (!s.ended) setError(null);
    } catch (cause) {
      await stopScreen(s);
      setError({ action: "screen", message: screenShareErrorMessage(cause) ?? messageOf(cause), cause });
    }
    if (s.sealedStill()) s.refresh();
  }, []);

  const switchTo = useCallback(async (source: "Microphone" | "Camera", deviceId: string | null) => {
    const s = active();
    if (!s) throw new Error("This call has no microphone or camera to switch");
    try {
      await switchInput(s.room, s.lk.Track.Source[source], deviceId);
    } finally {
      if (s.sealedStill()) s.refresh();
    }
  }, []);
  const switchMicrophone = useCallback((deviceId: string | null) => switchTo("Microphone", deviceId), [switchTo]);
  const switchCamera = useCallback((deviceId: string | null) => switchTo("Camera", deviceId), [switchTo]);

  const leave = useCallback(async () => {
    const s = session.current;
    if (!s || s.ended) return;
    await endSession(s);
    setStatus("left");
  }, []);

  return { ...state, status, error, removedByAdmin, toggleMic, toggleCamera, toggleScreen, switchMicrophone, switchCamera, leave };
}
