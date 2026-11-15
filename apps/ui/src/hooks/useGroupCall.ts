import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalTrackPublication, Participant, Room } from "livekit-client";
import { callRtcConfig } from "@ghostly/core";
import { screenShareErrorMessage } from "@ghostly/react";
import { preferredDevice } from "../lib/mediaDevices";
import type { GroupCallParticipant, GroupCallState } from "../components/GroupCallView";

/*
 * A group call through the group's node (WISP 602): joins the LiveKit room the node's pass names, and gives the call
 * window everyone in it, who speaks, and your microphone, camera and screen. livekit-client is loaded only here, at
 * the join, so the app's first load does not carry it.
 */

/** What the hook uses of livekit-client. Tests pass a fake through `loadLivekit` (no WebRTC in the test DOM). */
export type LivekitModule = Pick<typeof import("livekit-client"), "Room" | "RoomEvent" | "Track">;

const loadLivekitClient = (): Promise<LivekitModule> => import("livekit-client");

/** The node's pass, as its reply gives it (WISP 602): where the room is, the token, and TURN when it sends some. */
export interface GroupCallJoin {
  url: string;
  token: string;
  iceServers?: RTCIceServer[];
}

export interface UseGroupCallOptions extends GroupCallJoin {
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
  /** Joined under "Hide my IP from contacts" (the relay policy). */
  relayed: boolean;
  ended: boolean;
  screen: MediaStreamTrack | null;
  screenEnded: (() => void) | null;
  screenAsking: boolean;
  refresh: () => void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error ?? "")) || "failed";

function personOf(p: Participant, lk: LivekitModule, local: boolean): GroupCallParticipant {
  const { Source } = lk.Track;
  const track = (source: (typeof Source)[keyof typeof Source]) => p.getTrackPublication(source)?.track?.mediaStreamTrack ?? null;
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

function snapshot(room: Room, lk: LivekitModule): GroupCallState {
  return {
    local: personOf(room.localParticipant, lk, true),
    participants: [...room.remoteParticipants.values()].map((p) => personOf(p, lk, false)),
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
  if (!room) return;
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
}

/**
 * Joins the room at `url` with `token` while both are set, with the microphone on and the camera off, or muted past
 * `GROUP_CALL_MUTED_ABOVE` people. A new url or token leaves the old room first; unmounting leaves it too. `relayOnly`
 * turned on during a call joins the room again under the relay policy, with the microphone and camera as they were.
 */
export function useGroupCall({ url, token, iceServers, relayOnly = false, loadLivekit }: UseGroupCallOptions): GroupCall {
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
        const lk = await (load.current ?? loadLivekitClient)();
        if (!live) return;
        // No adaptive stream: the window draws the raw tracks in its own elements, which LiveKit would take as hidden.
        const room = new lk.Room({ adaptiveStream: false, dynacast: true });
        s.lk = lk;
        s.room = room;
        s.refresh = () => {
          if (live && !s.ended) setState(snapshot(room, lk));
        };
        const E = lk.RoomEvent;
        for (const event of [E.ParticipantConnected, E.ParticipantDisconnected, E.ParticipantNameChanged, E.TrackPublished,
          E.TrackUnpublished, E.TrackSubscribed, E.TrackUnsubscribed, E.TrackMuted, E.TrackUnmuted, E.LocalTrackPublished,
          E.LocalTrackUnpublished, E.ActiveSpeakersChanged, E.Reconnected]) room.on(event, s.refresh);
        room.on(E.Disconnected, () => {
          // The node closed the room or dropped you: the call is over here too.
          if (s.ended) return;
          void endSession(s);
          if (live) setStatus("left");
        });
        await room.connect(url, token, rtcConfig ? { rtcConfig } : undefined);
        if (!live || s.ended) {
          await endSession(s);
          return;
        }
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
  }, [url, token, rejoin]);

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
