import { useState, useRef, useEffect, useCallback, useSyncExternalStore } from "react";
import {
  callRtcConfig,
  extractParamsFromSdp,
  buildSdpFromSignal,
  parseCallSignal,
  sdpHasCandidates,
  signalHasVideo,
  traceLink,
  waitForIceGathering,
  type CallState,
  type CallSignal,
  type CallEventType,
  type CallMedia,
  type CallIceServer,
} from "@ghostly/core";
import { endOtherCalls, otherCallOn as anotherCallOn, setCallOn, subscribeCalls } from "./callRegistry";

/** What a peer can put on the video lane of a call. */
export type Picture = "camera" | "screen";

interface UseWebRTCParams {
  incomingCallSignal: string | null;
  publishCallSignal: (signal: string | null) => void;
  setFastPoll: (fast: boolean) => void;
  /**
   * A line for the chat. `call`, on the lines a call has one of on this side (its ring, its miss): the time of the offer
   * it rang with, the same when that offer is heard again (the app reopened while it rang), so its line is not added twice.
   * Returns the line's id, for `removeCallEventMessage`.
   */
  addCallEventMessage?: (type: CallEventType, hasVideo: boolean, duration?: number, call?: number) => string | void;
  /**
   * Takes a line back out of the chat, by the id `addCallEventMessage` gave: our call's "call started" when the
   * contact's offer won a glare, so this chat keeps the winning call's lines only, as the contact's does.
   */
  removeCallEventMessage?: (id: string) => void;
  /** Called when a call could not be placed or answered, e.g. the microphone was denied. */
  onError?: (error: unknown) => void;
  /** Where the media comes from, when not the browser's own WebRTC (Ghostly Desktop on Linux). */
  media?: CallMedia | null;
  /** The profile's own ICE servers (a TURN relay), tried after the apps' STUN servers. */
  iceServers?: readonly CallIceServer[];
  /**
   * How many candidates a signal carries: `PAIRED_CALL_CANDIDATES` on a chat session, whose frames have room for
   * every path; a compatibility chat's DHT record keeps the default (one host, one server reflexive).
   */
  maxCandidates?: number;
  /**
   * The microphone and camera this profile chose, read each time the call asks for one (a `deviceId` constraint;
   * `ideal` falls back to the default when the device is gone). Not for a `media` that does not choose devices.
   */
  devices?: () => { audio?: ConstrainDOMString; video?: ConstrainDOMString };
}

/** The browser's own WebRTC and capture. */
const browserMedia: CallMedia = {
  restartsIce: true,
  createPeerConnection: (config) => new RTCPeerConnection(config),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  getDisplayMedia: (options) => navigator.mediaDevices.getDisplayMedia(options),
};

/** How long a failed screen share stays explained in the call window. */
export const SCREEN_SHARE_ERROR_MS = 8000;

/**
 * A picker refused faster than this was never shown to anyone: the system or the browser said no by itself
 * (macOS with Screen Recording off for the app), which is worth explaining, unlike a person closing the picker.
 */
const REFUSED_WITHOUT_PICKER_MS = 300;

/**
 * An answered call whose connection fails before it ever connected waits this long for the caller's second offer
 * before it gives up. A headless Ghostly (libdatachannel 0.24.5) can refuse a good answer and fail the handshake with
 * it (packages/cli/src/calls/manager.ts, `redial`); it then offers again once, on a new connection.
 */
export const RESTART_GRACE_MS = 8000;

/**
 * An unanswered call rings this long (WISP 601, "Ringing"): the caller then hangs up and says "No answer"; the side
 * it rang stops ringing on its own and keeps a "Missed call" line. The headless CLI's `RING_MS` is the same.
 */
export const RING_MS = 60_000;

/** How long "No answer" stays on the caller's screen. */
export const NO_ANSWER_SHOWN_MS = 6000;

/** How long the reason a microphone or camera could not be used stays on screen. */
export const MEDIA_PROBLEM_SHOWN_MS = 8000;

/** Why the microphone or camera could not be used: refused (by the person, the browser or the system), or none to use. */
export type MediaProblem = "denied" | "unavailable";

/** What a failed `getUserMedia` means for the person, or null when the failure was not the microphone's or camera's. */
export function mediaProblem(error: unknown): MediaProblem | null {
  const { name } = (error ?? {}) as { name?: unknown };
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "denied";
    case "NotFoundError":
    case "NotReadableError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
    case "TrackStartError":
      return "unavailable";
    default:
      return null;
  }
}

/**
 * A new connection that has not found a single candidate by then has stalled: Chromium, rarely and under load, leaves
 * one gathering with nothing to show for it, forever (the matrix's "Connecting..." calls, e2e-full 36677963444). Its
 * offer or answer would reach nobody, and nobody would reach it, so neither side's ICE would ever fail either. A new
 * connection is made in its place, up to `GATHER_ATTEMPTS` in all.
 */
export const GATHER_STALL_MS = 4000;
export const GATHER_ATTEMPTS = 3;

/**
 * A call answered (or whose answer came) that has not connected by then ends, and says so: ICE normally connects in
 * well under a second, or fails by itself within about 30 s; a call that does neither would say "Connecting..." forever.
 */
export const CONNECT_TIMEOUT_MS = 45_000;

/**
 * Reconnecting (WISP 601): a connected call whose path is lost (a network change: Wi-Fi to mobile data, a VPN going
 * up) restarts ICE on its own connection instead of ending, when both sides said they can (`x` on the offer and the
 * answer). The side whose offer was answered sends the restart offers (`r`); the other answers them.
 *
 * ICE that says "disconnected" often comes back by itself: the restart waits this long for that.
 */
export const ICE_DISCONNECT_GRACE_MS = 3000;
/** A call whose path has not come back this long after it was lost ends, as a failed connection ended it before. */
export const RECONNECT_TIMEOUT_MS = 30_000;
/**
 * While the path is still lost, ICE restarts again this long after the last restart offer: the new network may not
 * have been up yet when that one gathered its candidates, or its answer never came.
 */
export const ICE_RESTART_RETRY_MS = 8000;
/** A restart's description waits this long for its candidates. */
export const ICE_RESTART_GATHER_MS = 5000;

/** No connection found a way to reach anyone: the call is ended rather than left saying "Connecting...". */
export class CallUnreachableError extends Error {
  constructor(message = "The call could not reach the network") {
    super(message);
    this.name = "CallUnreachableError";
  }
}

/**
 * What to tell the person when sharing the screen failed, or null when there is nothing to tell: closing the
 * picker, or saying no to it, is a choice and not an error.
 */
export function screenShareErrorMessage(error: unknown, elapsedMs = Infinity): string | null {
  const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
  switch (name) {
    case "NotAllowedError":
      // Chromium says "Permission denied by system" when the OS refused; WebKit refuses without a word, at once.
      return /system/i.test(String(message ?? "")) || elapsedMs < REFUSED_WITHOUT_PICKER_MS
        ? "Screen sharing is blocked. Allow screen recording for this app in your system's privacy settings."
        : null;
    case "NotFoundError":
      return "There is no screen to share";
    case "NotSupportedError":
    case "TypeError":
      return "Screen sharing is not available here";
    default:
      return "Could not share the screen. Try again.";
  }
}

/** The video section of the call, once the peers agreed on one. */
function videoTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | undefined {
  return pc.getTransceivers().find((t) => t.receiver.track.kind === "video" && t.mid !== null);
}

/** The audio section of the call. */
function audioTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | undefined {
  return pc.getTransceivers().find((t) => t.receiver.track.kind === "audio" && t.mid !== null);
}

/**
 * A device request that got nothing (a picker closed, a device refused or gone) gives the turn back to the one asked
 * before it, still opening: that one was what the person wanted, and a failed later one does not replace it.
 */
function yieldRequest(counter: { current: number }, request: number): void {
  if (counter.current === request) counter.current = request - 1;
}

/**
 * Why a call ended, in the diagnostic log (`link {"me":"call","step":"call-end",…}`, the Desktop's log file, or the
 * console where link traces are on): a hang-up here or from the contact, a connection that failed (its ICE and
 * connection states), or the chat unloaded mid-call. A call that ends by itself is otherwise silent.
 */
function traceCallEnd(why: string, detail: Record<string, unknown> = {}): void {
  traceLink("call", "call-end", { why, ...detail });
}

/** The states in which this chat's call is on (placed or answered), for the app's one call at a time. */
const ON_A_CALL: ReadonlySet<CallState> = new Set<CallState>(["offering", "answering", "connecting", "connected"]);

/** Capture from exactly this device, or from the default (null). */
const exactly = (deviceId: string | null): MediaTrackConstraints | true => (deviceId ? { deviceId: { exact: deviceId } } : true);

export function useWebRTC({
  incomingCallSignal,
  publishCallSignal,
  setFastPoll,
  addCallEventMessage,
  removeCallEventMessage,
  onError,
  media,
  iceServers,
  maxCandidates,
  devices,
}: UseWebRTCParams) {
  const iceServersRef = useRef(iceServers);
  iceServersRef.current = iceServers;
  const maxCandidatesRef = useRef(maxCandidates);
  maxCandidatesRef.current = maxCandidates;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const mediaRef = useRef<CallMedia>(media ?? browserMedia);
  mediaRef.current = media ?? browserMedia;
  const devicesRef = useRef(devices);
  devicesRef.current = media && !media.choosesDevices ? undefined : devices;

  /** What to capture `kind` from: the chosen device, or whatever the default is. */
  const captureFrom = useCallback((kind: "audio" | "video"): MediaTrackConstraints | true => {
    const deviceId = devicesRef.current?.()[kind];
    return deviceId ? { deviceId } : true;
  }, []);

  const [callState, setCallState] = useState<CallState>("idle");
  /** This chat's key among the app's calls (`callRegistry`): a second call answered elsewhere ends this one. */
  const [callKey] = useState(() => Symbol("call"));
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  /** What we are sending on the video lane, if anything. */
  const [picture, setPictureState] = useState<Picture | null>(null);
  /** What the peer says it is sending on it. */
  const [remotePicture, setRemotePicture] = useState<Picture | null>(null);
  /** Whether the call negotiated a video lane we may send on, camera or screen. */
  const [videoLaneOpen, setVideoLaneOpen] = useState(false);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  /** When the call connected, for the length of a call that ends where no state is at hand (a connection that failed). */
  const callStartedAtRef = useRef<number | null>(null);
  /** Why the last attempt to share the screen failed, for a few seconds. */
  const [screenShareError, setScreenShareErrorState] = useState<string | null>(null);
  /** Our call rang out unanswered, for a few seconds (`NO_ANSWER_SHOWN_MS`). */
  const [noAnswer, setNoAnswer] = useState(false);
  /** The microphone or camera a call asked for could not be used, and why, for a few seconds (`MEDIA_PROBLEM_SHOWN_MS`). */
  const [mediaProblemShown, setMediaProblemShown] = useState<MediaProblem | null>(null);
  /** Tells the person why a call could not use the microphone or camera, when that is what `error` was. */
  const showMediaProblem = useCallback((error: unknown) => {
    const problem = mediaProblem(error);
    if (problem) setMediaProblemShown(problem);
  }, []);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const lastProcessedSignalRef = useRef<number>(0);
  const callStateRef = useRef<CallState>("idle");
  const pendingOfferRef = useRef<CallSignal | null>(null);
  const hangupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myOfferTimestampRef = useRef<number>(0);
  /** Our published offer's DTLS fingerprint: with its timestamp, what decides who rings when both call at once. */
  const myOfferFingerprintRef = useRef<string>("");
  /** Whether a picture was on at any point, which is what the chat log calls a video call. */
  const callHadVideoRef = useRef<boolean>(false);
  const callConnectedEventFiredRef = useRef<boolean>(false);
  const pictureRef = useRef<Picture | null>(null);
  /** What we were showing before the screen took the lane, to go back to when sharing stops. */
  const pictureBeforeShareRef = useRef<Picture | null>(null);
  /** A share is being started or stopped: the picker may be open. */
  const shareBusyRef = useRef(false);
  /** Counts the picture changes asked for: one whose camera or screen opens after a later one was asked is dropped. */
  const pictureRequestRef = useRef(0);
  /** The same for the microphone switches: one that opens after a later one was picked is dropped. */
  const microphoneRequestRef = useRef(0);
  const screenShareErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The offer we answered and whether we answered with the camera. */
  const answeredRef = useRef<{ offer: CallSignal; withVideo: boolean } | null>(null);
  /**
   * Whether the connection itself (ICE and DTLS) came up. ICE alone is what the call window calls connected, and a
   * headless caller answers our ICE checks before it even has our answer; only this says the media really flows.
   */
  const mediaUpRef = useRef(false);
  /** Whether this call already started over on a caller's second offer: a second failure is final. */
  const restartedRef = useRef(false);
  /** The id of our call's "call started" line, while it rings: a glare it loses takes the line back out. */
  const startedLineRef = useRef<string | null>(null);
  /** The wait for a second offer after the answered call's connection failed (`RESTART_GRACE_MS`). */
  const restartGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** The connected call lost its path and is getting it back (see ICE_DISCONNECT_GRACE_MS): "Reconnecting...". */
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectingRef = useRef(false);
  /** The contact's offer or answer said it restarts ICE (`x`), and its DTLS fingerprint: a restart keeps it. */
  const peerRestartsRef = useRef(false);
  const peerFingerprintRef = useRef("");
  /** Ends the call when the path has not come back (`RECONNECT_TIMEOUT_MS`). */
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The wait before a restart while ICE only says "disconnected", and the wait before the next restart. */
  const disconnectGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Our latest restart offer's `ts` while its answer is awaited (0: none), and the last one's, so each is later. */
  const restartOfferRef = useRef(0);
  const lastRestartOfferRef = useRef(0);
  /** A restart offer is being made. */
  const restartBusyRef = useRef(false);
  /** The restart offers being answered, one after the other. */
  const restartAnswersRef = useRef<Promise<void>>(Promise.resolve());
  /** The latest `restartIce`, for the connection's handlers and timers. */
  const restartIceRef = useRef<() => Promise<void>>(async () => {});
  /** Ends the call as its connection's failure ends it, for the current connection. */
  const giveUpRef = useRef<() => void>(() => {});

  const setScreenShareError = useCallback((message: string | null) => {
    if (screenShareErrorTimerRef.current) clearTimeout(screenShareErrorTimerRef.current);
    screenShareErrorTimerRef.current = message ? setTimeout(() => setScreenShareErrorState(null), SCREEN_SHARE_ERROR_MS) : null;
    setScreenShareErrorState(message);
  }, []);

  const setPicture = useCallback((next: Picture | null) => {
    pictureRef.current = next;
    setPictureState(next);
  }, []);

  /** The latest `hangUp`, for what runs before it is defined or outlives a render. */
  const hangUpRef = useRef<(sendSignal?: boolean, addEndMessage?: boolean, unreachable?: boolean) => void>(() => {});

  const updateCallState = useCallback((state: CallState) => {
    callStateRef.current = state;
    setCallState(state);
    // One call at a time (WISP 601, "On a call already"): answering a call in another chat hangs this one up, as its
    // person would, so the contact is told and both chats keep the end line.
    setCallOn(callKey, ON_A_CALL.has(state) ? () => { traceCallEnd("answered-another", { state: callStateRef.current }); hangUpRef.current(true, true); } : null);
  }, [callKey]);

  /**
   * Which call attempt is current. Hanging up (or any cleanup) moves it on, so a start or an answer
   * still waiting for the camera or for ICE finds out it was cancelled: it lets go of what it got and
   * sends nothing, instead of ringing someone for a call that no longer exists.
   */
  const attemptRef = useRef(0);

  const addCallEventMessageRef = useRef(addCallEventMessage);
  addCallEventMessageRef.current = addCallEventMessage;

  /**
   * The call could not connect: the chat says so ("call_failed") and the call ends. `tell` hangs up with the reason
   * (`r: "u"`), so the contact's side ends with the same line instead of ringing or saying "Connecting..." on.
   */
  const couldNotConnect = useCallback((tell: boolean) => {
    addCallEventMessageRef.current?.("call_failed", callHadVideoRef.current);
    hangUpRef.current(tell, false, true);
  }, []);

  /** Our answered call's media never came up, and it has not started over yet: a caller's second offer restarts it. */
  const restartable = useCallback(
    () => !!answeredRef.current && !mediaUpRef.current && !restartedRef.current && (callStateRef.current === "connecting" || callStateRef.current === "connected"),
    [],
  );

  const clearRestartGrace = useCallback(() => {
    if (restartGraceRef.current) clearTimeout(restartGraceRef.current);
    restartGraceRef.current = null;
  }, []);

  /** The path is back, or the call is over: nothing waits to restart ICE or to end the call any more. */
  const clearReconnect = useCallback(() => {
    for (const timer of [reconnectTimerRef, disconnectGraceRef, restartRetryRef]) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    }
    if (reconnectingRef.current) {
      reconnectingRef.current = false;
      setReconnecting(false);
    }
  }, []);

  /**
   * Whether this call restarts ICE when its path is lost: both sides said they can, and the call is up (its media
   * flowed). With an older contact, or before the call connected, a lost path ends the call as before.
   */
  const reconnects = useCallback(
    () => !!mediaRef.current.restartsIce && peerRestartsRef.current && mediaUpRef.current && callConnectedEventFiredRef.current && callStateRef.current === "connected",
    [],
  );

  const cleanupConnection = useCallback(() => {
    attemptRef.current++;
    clearRestartGrace();
    clearReconnect();
    restartOfferRef.current = 0;
    peerRestartsRef.current = false;
    peerFingerprintRef.current = "";
    answeredRef.current = null;
    restartedRef.current = false;
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      localStreamRef.current = null;
    }

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    setLocalStream(null);
    setRemoteStream(null);
    setIsMuted(false);
    setPicture(null);
    setRemotePicture(null);
    setVideoLaneOpen(false);
    pictureBeforeShareRef.current = null;
    setScreenShareError(null);
    setCallStartedAt(null);
    callStartedAtRef.current = null;
  }, [setPicture, setScreenShareError, clearRestartGrace, clearReconnect]);

  /** The lane is open once both sides have described it and our half may send. */
  const refreshVideoLane = useCallback(() => {
    const pc = pcRef.current;
    const direction = pc ? videoTransceiver(pc)?.currentDirection : undefined;
    setVideoLaneOpen(!!direction?.includes("send"));
  }, []);

  /** Tells the peer what our picture is doing; theirs is the only way they can know. */
  const publishPicture = useCallback(
    (next: Picture | null) => {
      const signal: CallSignal = { t: "v", ts: Date.now(), v: next ? 1 : 0 };
      if (next) signal.k = next === "screen" ? "s" : "c";
      publishCallSignal(JSON.stringify(signal));
    },
    [publishCallSignal],
  );

  const applyRemotePicture = useCallback((signal: CallSignal) => {
    const on = signalHasVideo(signal);
    if (on) callHadVideoRef.current = true;
    setRemotePicture(on ? (signal.k === "s" ? "screen" : "camera") : null);
  }, []);

  const createPeerConnection = useCallback(() => {
    const pc = mediaRef.current.createPeerConnection(callRtcConfig(iceServersRef.current));
    mediaUpRef.current = false;

    const connectedNow = () => {
      // The path of a call that was reconnecting is back.
      if (reconnectingRef.current) traceLink("call", "call-reconnected", {});
      clearReconnect();
      updateCallState("connected");
      refreshVideoLane();
      // Once: the clock of a call that reconnects goes on from where it was.
      if (callStartedAtRef.current === null) {
        callStartedAtRef.current = Date.now();
        setCallStartedAt(callStartedAtRef.current);
      }
      setFastPoll(false);
      if (!callConnectedEventFiredRef.current) {
        callConnectedEventFiredRef.current = true;
        addCallEventMessage?.("call_connected", callHadVideoRef.current);
      }
    };

    /**
     * The connected call lost its path. It says "Reconnecting..." and has RECONNECT_TIMEOUT_MS to get it back; the
     * side whose offer was answered restarts ICE: at once when ICE failed, after a short wait when it only says
     * "disconnected". False when this call does not reconnect (an older contact, a call not up yet).
     */
    const pathLost = (now: boolean): boolean => {
      if (!reconnects()) return false;
      if (!reconnectingRef.current) {
        reconnectingRef.current = true;
        setReconnecting(true);
        // A compatibility chat reads the contact's restart offer or answer on its next poll.
        setFastPoll(true);
        traceLink("call", "call-reconnecting", { ice: pc.iceConnectionState, connection: pc.connectionState, restarts: !answeredRef.current });
        reconnectTimerRef.current = setTimeout(() => { reconnectTimerRef.current = null; giveUpRef.current(); }, RECONNECT_TIMEOUT_MS);
      }
      // The contact's side placed the call: its restart offer is what this side waits for.
      if (answeredRef.current) return true;
      if (now) {
        if (disconnectGraceRef.current) clearTimeout(disconnectGraceRef.current);
        disconnectGraceRef.current = null;
        // One already on its way (made, or awaiting its answer) is given its time: the retry follows it.
        if (!restartBusyRef.current && !restartRetryRef.current) void restartIceRef.current();
      } else if (!disconnectGraceRef.current && !restartBusyRef.current && !restartRetryRef.current) {
        disconnectGraceRef.current = setTimeout(() => { disconnectGraceRef.current = null; void restartIceRef.current(); }, ICE_DISCONNECT_GRACE_MS);
      }
      return true;
    };

    const failed = (closed = false) => {
      // An answered call whose media never came up waits for the caller's second offer (see RESTART_GRACE_MS), once.
      if (restartable()) {
        if (!restartGraceRef.current) restartGraceRef.current = setTimeout(() => { restartGraceRef.current = null; giveUp(); }, RESTART_GRACE_MS);
        return;
      }
      if (!closed && pathLost(true)) return;
      giveUp();
    };

    const giveUp = () => {
      if (pcRef.current !== pc) return;
      traceCallEnd("connection", { ice: pc.iceConnectionState, connection: pc.connectionState, connected: callConnectedEventFiredRef.current });
      // A connected call whose contact went away (a closed tab, a reload, a lost network) ends as a hang-up ends it:
      // with its line and its length in the chat. One that never connected could not: the chat says so.
      if (callConnectedEventFiredRef.current) {
        const started = callStartedAtRef.current;
        addCallEventMessage?.("call_ended", callHadVideoRef.current, started ? Date.now() - started : undefined);
        callConnectedEventFiredRef.current = false;
      } else {
        addCallEventMessage?.("call_failed", callHadVideoRef.current);
      }
      cleanupConnection();
      updateCallState("idle");
      publishCallSignal(null);
      setFastPoll(false);
    };

    pc.ontrack = (event) => {
      setRemoteStream((prev) => {
        if (event.streams[0]) {
          return event.streams[0];
        }
        const stream = prev ?? new MediaStream();
        stream.addTrack(event.track);
        return stream;
      });
    };

    pc.onicecandidate = () => {};

    pc.oniceconnectionstatechange = () => {
      // A connection this call replaced (a second offer, see `restartAnswer`) has nothing more to say.
      if (pcRef.current !== pc) return;
      const state = pc.iceConnectionState;

      if (state === "connected" || state === "completed") connectedNow();
      else if (state === "disconnected") pathLost(false);
      else if (state === "failed" || state === "closed") failed(state === "closed");
    };

    pc.onconnectionstatechange = () => {
      if (pcRef.current !== pc) return;
      const state = pc.connectionState;

      if (state === "connected") {
        mediaUpRef.current = true;
        clearRestartGrace();
        if (callStateRef.current === "connecting" || callStateRef.current === "answering") connectedNow();
      } else if (state === "failed") {
        failed();
      }
    };

    pc.onsignalingstatechange = () => {};

    pcRef.current = pc;
    giveUpRef.current = giveUp;
    return pc;
  }, [updateCallState, setFastPoll, cleanupConnection, publishCallSignal, addCallEventMessage, refreshVideoLane, clearRestartGrace, restartable, clearReconnect, reconnects]);

  /**
   * Makes the call's connection with `make` (its description set) and waits for its candidates. One that finds none
   * (`GATHER_STALL_MS`) is closed and made again, up to `GATHER_ATTEMPTS` times; then the call cannot reach anyone
   * (`CallUnreachableError`). Null when the attempt was cancelled meanwhile.
   */
  const gathered = useCallback(async (make: () => Promise<RTCPeerConnection>, cancelled: () => boolean): Promise<RTCPeerConnection | null> => {
    for (let attempt = 1; ; attempt++) {
      const pc = await make();
      await waitForIceGathering(pc, undefined, { stallMs: GATHER_STALL_MS });
      if (cancelled()) return null;
      if (sdpHasCandidates(pc.localDescription?.sdp)) return pc;
      // Its events are not ours any more: the next connection takes its place in pcRef.
      pcRef.current = null;
      pc.close();
      if (attempt >= GATHER_ATTEMPTS) throw new CallUnreachableError();
    }
  }, []);

  /** What an offer or an answer says of our picture, and that this side restarts ICE when its media can. */
  const describeSelf = useCallback((): Pick<CallSignal, "v" | "k" | "x"> => {
    const picture = pictureRef.current;
    return { v: picture ? 1 : 0, ...(picture ? { k: picture === "screen" ? "s" as const : "c" as const } : {}), ...(mediaRef.current.restartsIce ? { x: 1 as const } : {}) };
  }, []);

  /**
   * Restarts ICE on the call's connection and sends the restart offer (`r`): new ICE credentials and the candidates
   * of the network as it is now, on the same connection, so its tracks, mute, devices and clock stay as they are.
   * Only the side whose offer was answered does. The signal goes when the chat's session can carry it (the engine
   * keeps the latest one for the next session); while the path is still lost it is made again (ICE_RESTART_RETRY_MS).
   */
  const restartIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || answeredRef.current || restartBusyRef.current || !reconnects()) return;
    restartBusyRef.current = true;
    if (restartRetryRef.current) clearTimeout(restartRetryRef.current);
    restartRetryRef.current = null;
    const attempt = attemptRef.current;
    const current = () => attemptRef.current === attempt && pcRef.current === pc;
    try {
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      await waitForIceGathering(pc, ICE_RESTART_GATHER_MS, { fresh: true });
      if (!current()) return;
      const sdp = pc.localDescription?.sdp;
      // No candidate: no network yet. Nothing to send; the next try, or the browser's "online", finds one.
      if (sdp && sdpHasCandidates(sdp)) {
        const ts = Math.max(Date.now(), lastRestartOfferRef.current + 1);
        restartOfferRef.current = lastRestartOfferRef.current = ts;
        const signal: CallSignal = { t: "r", ts, ...extractParamsFromSdp(sdp, { maxCandidates: maxCandidatesRef.current }), ...describeSelf() };
        traceLink("call", "call-ice-restart", { candidates: signal.c?.length ?? 0 });
        publishCallSignal(JSON.stringify(signal));
      }
    } catch (error) {
      if (current()) onErrorRef.current?.(error);
    } finally {
      restartBusyRef.current = false;
    }
    if (current() && reconnectingRef.current) {
      restartRetryRef.current = setTimeout(() => { restartRetryRef.current = null; void restartIceRef.current(); }, ICE_RESTART_RETRY_MS);
    }
  }, [reconnects, describeSelf, publishCallSignal]);
  restartIceRef.current = restartIce;

  /** The contact's answer to our restart offer: ICE goes on with its new credentials and candidates. */
  const applyIceRestartAnswer = useCallback(async (signal: CallSignal) => {
    const pc = pcRef.current;
    if (!pc || signal.f !== peerFingerprintRef.current) return;
    restartOfferRef.current = 0;
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: buildSdpFromSignal(signal) });
    } catch (error) {
      // The next restart offer starts over; a call that gets no path back ends when its time is up.
      if (pcRef.current === pc) onErrorRef.current?.(error);
    }
  }, []);

  /**
   * The contact's restart offer (`r`), on the call this side answered: answered on the same connection, whose ICE
   * restarts with it. Our answer says which offer it answers (`re`).
   */
  const answerIceRestart = useCallback((offer: CallSignal) => {
    restartAnswersRef.current = restartAnswersRef.current.then(async () => {
      const pc = pcRef.current;
      const attempt = attemptRef.current;
      const current = () => attemptRef.current === attempt && pcRef.current === pc;
      if (!pc || !answeredRef.current || !mediaRef.current.restartsIce || offer.f !== peerFingerprintRef.current || callStateRef.current !== "connected") return;
      try {
        await pc.setRemoteDescription({ type: "offer", sdp: buildSdpFromSignal(offer) });
        await pc.setLocalDescription(await pc.createAnswer());
        await waitForIceGathering(pc, ICE_RESTART_GATHER_MS, { fresh: true });
        if (!current()) return;
        const params = extractParamsFromSdp(pc.localDescription!.sdp, { maxCandidates: maxCandidatesRef.current });
        const signal: CallSignal = { t: "a", ts: Date.now(), ...params, ...describeSelf(), re: offer.ts };
        traceLink("call", "call-ice-restart-answer", { candidates: signal.c?.length ?? 0 });
        publishCallSignal(JSON.stringify(signal));
      } catch (error) {
        if (current()) onErrorRef.current?.(error);
      }
    });
  }, [describeSelf, publishCallSignal]);

  /** The browser has a network again: the side that restarts does so now, without waiting for ICE to notice. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const online = () => {
      if (!pcRef.current || answeredRef.current || !reconnects()) return;
      if (disconnectGraceRef.current) clearTimeout(disconnectGraceRef.current);
      disconnectGraceRef.current = null;
      void restartIceRef.current();
    };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [reconnects]);

  const stopSharingRef = useRef<() => Promise<void>>(async () => {});

  /**
   * Puts a picture on the video lane, swaps one for the other, or takes it off.
   * `replaceTrack` needs no renegotiation, so an audio call can grow a camera or
   * a screen halfway through, as long as the lane was negotiated.
   */
  const showPicture = useCallback(
    /** `camera`: which one to show, when not the chosen one (a switch from the call's device menu; null the default). */
    async (next: Picture | null, camera?: string | null) => {
      const pc = pcRef.current;
      const sender = pc ? videoTransceiver(pc)?.sender : undefined;
      if (!pc || !localStreamRef.current || !sender) throw new Error("This call has no video to send on");
      const attempt = attemptRef.current;
      const request = ++pictureRequestRef.current;

      let track: MediaStreamTrack | null = null;
      try {
        if (next === "camera") {
          track = (await mediaRef.current.getUserMedia({ video: camera === undefined ? captureFrom("video") : exactly(camera) })).getVideoTracks()[0];
        } else if (next === "screen") {
          const { getDisplayMedia } = mediaRef.current;
          if (!getDisplayMedia) throw Object.assign(new Error("Screen sharing is not available here"), { name: "NotSupportedError" });
          track = (await getDisplayMedia({ video: true, audio: false })).getVideoTracks()[0];
        }
      } catch (error) {
        yieldRequest(pictureRequestRef, request);
        throw error;
      }
      // The call ended while the prompt or the picker was open: what it gave is let go, and nobody is told.
      if (attemptRef.current !== attempt) {
        track?.stop();
        return;
      }
      // Something else was asked for while it opened (the camera turned off, another camera picked): that one wins.
      if (pictureRequestRef.current !== request) {
        track?.stop();
        return;
      }

      try {
        await sender.replaceTrack(track);
      } catch (error) {
        track?.stop();
        throw error;
      }

      // Read after the prompt: the picture may have changed while it was open.
      const current = localStreamRef.current!;
      if (next === "screen" && track) {
        track.contentHint = "detail";
        // The browser's (or the system's) own "Stop sharing" ends the track without telling anyone else.
        track.onended = () => {
          if (callStateRef.current === "idle" || shareBusyRef.current) return;
          shareBusyRef.current = true;
          void stopSharingRef.current().catch(() => {}).finally(() => { shareBusyRef.current = false; });
        };
      }

      current.getVideoTracks().forEach((old) => {
        old.onended = null;
        old.stop();
      });
      const stream = new MediaStream([...current.getAudioTracks(), ...(track ? [track] : [])]);
      localStreamRef.current = stream;
      setLocalStream(stream);
      setPicture(next);
      if (next) callHadVideoRef.current = true;
      publishPicture(next);
    },
    [setPicture, publishPicture, captureFrom],
  );

  /**
   * Back to what was on before the screen: the camera, or no picture at all for a voice call. A camera that
   * cannot come back (gone, or refused this time) still ends the share, as a voice call.
   */
  const stopSharing = useCallback(async () => {
    const before = pictureBeforeShareRef.current;
    try {
      await showPicture(before);
    } catch (error) {
      if (before) await showPicture(null);
      throw error;
    }
  }, [showPicture]);
  stopSharingRef.current = stopSharing;

  const startCall = useCallback(
    async (withVideo: boolean) => {
      // Never two calls at once: a call is placed once the one on in another chat has ended.
      if (callStateRef.current !== "idle" || anotherCallOn(callKey)) return;

      // A hang-up schedules clearing `_call` a few seconds later; that must not
      // wipe the offer of a call placed in the meantime.
      if (hangupTimerRef.current) {
        clearTimeout(hangupTimerRef.current);
        hangupTimerRef.current = null;
      }

      const attempt = ++attemptRef.current;
      const cancelled = () => attemptRef.current !== attempt;
      setNoAnswer(false);
      try {
        setFastPoll(true);
        callHadVideoRef.current = withVideo;
        callConnectedEventFiredRef.current = false;
        updateCallState("offering");
        startedLineRef.current = addCallEventMessage?.("call_started", withVideo) || null;

        // A screen is shared from inside a call (`toggleScreenShare`), never as the way one starts.
        const stream = await mediaRef.current.getUserMedia({ audio: captureFrom("audio"), video: withVideo && captureFrom("video") });
        if (cancelled()) { stream.getTracks().forEach((track) => track.stop()); return; }
        localStreamRef.current = stream;
        setLocalStream(stream);
        setPicture(withVideo ? "camera" : null);

        const pc = await gathered(async () => {
          const pc = createPeerConnection();
          stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
          stream.getVideoTracks().forEach((track) => pc.addTrack(track, stream));
          // An audio call still offers a video section, so a camera or a screen can
          // be turned on later without a second offer the peer cannot answer.
          if (stream.getVideoTracks().length === 0) pc.addTransceiver("video", { direction: "sendrecv" });

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          return pc;
        }, cancelled);
        if (!pc) return;

        const sdp = pc.localDescription!.sdp;
        const params = extractParamsFromSdp(sdp, { maxCandidates: maxCandidatesRef.current });

        const offerTs = Date.now();
        myOfferTimestampRef.current = offerTs;
        myOfferFingerprintRef.current = params.f ?? "";

        const signal: CallSignal = {
          t: "o",
          ts: offerTs,
          ...params,
          v: withVideo ? 1 : 0,
          // This side restarts ICE when the call's path is lost; so does the call, when the answer says it too.
          ...(mediaRef.current.restartsIce ? { x: 1 as const } : {}),
        };
        if (withVideo) signal.k = "c";

        const signalStr = JSON.stringify(signal);
        publishCallSignal(signalStr);
      } catch (error) {
        // A newer attempt (or none) owns the call now: its state is not ours to reset.
        if (cancelled()) return;
        onErrorRef.current?.(error);
        showMediaProblem(error);
        // The call ended before it rang anyone (no microphone, or no connection found a way out): the chat says so,
        // after its "call started" line. No offer went out, so the contact has nothing to hear.
        addCallEventMessage?.("call_failed", withVideo);
        cleanupConnection();
        updateCallState("idle");
        setFastPoll(false);
      }
    },
    [
      createPeerConnection,
      gathered,
      captureFrom,
      setPicture,
      publishCallSignal,
      setFastPoll,
      updateCallState,
      cleanupConnection,
      addCallEventMessage,
      showMediaProblem,
      callKey,
    ],
  );

  /** A new connection for the call, with its own stream, that answers `offer`: true once the answer is published. */
  const answerOffer = useCallback(
    async (offer: CallSignal, stream: MediaStream, withVideo: boolean, cancelled: () => boolean): Promise<boolean> => {
      const pc = await gathered(async () => {
        const pc = createPeerConnection();
        stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
        stream.getVideoTracks().forEach((track) => pc.addTrack(track, stream));

        await pc.setRemoteDescription({ type: "offer", sdp: buildSdpFromSignal(offer) });

        // Answering an offer with no camera of our own leaves the video section
        // receive-only; opening it keeps our side of the lane free for later.
        const video = videoTransceiver(pc);
        if (video && video.direction !== "sendrecv") video.direction = "sendrecv";

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        return pc;
      }, cancelled);
      if (!pc) return false;

      const params = extractParamsFromSdp(pc.localDescription!.sdp, { maxCandidates: maxCandidatesRef.current });
      const signal: CallSignal = { t: "a", ts: Date.now(), ...params, v: withVideo ? 1 : 0, ...(mediaRef.current.restartsIce ? { x: 1 as const } : {}) };
      if (withVideo) signal.k = "c";
      peerRestartsRef.current = offer.x === 1;
      peerFingerprintRef.current = offer.f ?? "";
      publishCallSignal(JSON.stringify(signal));
      refreshVideoLane();
      return true;
    },
    [createPeerConnection, publishCallSignal, refreshVideoLane, gathered],
  );

  /**
   * The caller offered again while our answered call was still connecting: a headless Ghostly does that once, on a
   * new connection, when libdatachannel refused our answer (see RESTART_GRACE_MS). The call starts over on a new
   * connection with the same microphone and camera; the old connection is closed first.
   */
  const restartAnswer = useCallback(
    async (offer: CallSignal) => {
      const answered = answeredRef.current;
      const stream = localStreamRef.current;
      if (!answered || !stream) return;
      const attempt = ++attemptRef.current;
      const cancelled = () => attemptRef.current !== attempt;
      restartedRef.current = true;
      clearRestartGrace();
      const old = pcRef.current;
      pcRef.current = null;
      old?.close();
      setRemoteStream(null);
      try {
        applyRemotePicture(offer);
        if (!(await answerOffer(offer, stream, answered.withVideo, cancelled))) return;
        answeredRef.current = { offer, withVideo: answered.withVideo };
      } catch (error) {
        if (cancelled()) return;
        onErrorRef.current?.(error);
        if (error instanceof CallUnreachableError) { couldNotConnect(true); return; }
        cleanupConnection();
        updateCallState("idle");
        publishCallSignal(null);
        setFastPoll(false);
      }
    },
    [answerOffer, applyRemotePicture, clearRestartGrace, cleanupConnection, updateCallState, publishCallSignal, setFastPoll, couldNotConnect],
  );

  const acceptCall = useCallback(
    async (withVideo: boolean) => {
      const offer = pendingOfferRef.current;
      if (!offer || callStateRef.current !== "incoming") return;
      // On a call in another chat: that call ends first ("End and answer"), with its hang-up and its end line, and its
      // microphone and camera are let go before this call asks for its own. Never two calls at once.
      endOtherCalls(callKey);

      if (hangupTimerRef.current) {
        clearTimeout(hangupTimerRef.current);
        hangupTimerRef.current = null;
      }

      const attempt = ++attemptRef.current;
      const cancelled = () => attemptRef.current !== attempt;
      try {
        updateCallState("answering");
        applyRemotePicture(offer);
        callHadVideoRef.current = withVideo || signalHasVideo(offer);
        callConnectedEventFiredRef.current = false;

        const stream = await mediaRef.current.getUserMedia({
          audio: captureFrom("audio"),
          video: withVideo && captureFrom("video"),
        });
        if (cancelled()) { stream.getTracks().forEach((track) => track.stop()); return; }
        localStreamRef.current = stream;
        setLocalStream(stream);
        setPicture(withVideo ? "camera" : null);

        if (!(await answerOffer(offer, stream, withVideo, cancelled))) return;
        answeredRef.current = { offer, withVideo };
        // Read again (the check above narrowed it to "incoming"): ICE may have connected while our answer gathered.
        if ((callStateRef.current as CallState) === "answering") updateCallState("connecting");
        pendingOfferRef.current = null;
      } catch (error) {
        if (cancelled()) return;
        onErrorRef.current?.(error);
        showMediaProblem(error);
        // Whatever stopped the answer (a microphone refused, no connection found), the caller is told at once
        // instead of ringing on until its own ring runs out, and both chats say the call couldn't connect.
        couldNotConnect(true);
      }
    },
    [
      answerOffer,
      captureFrom,
      applyRemotePicture,
      setPicture,
      updateCallState,
      couldNotConnect,
      showMediaProblem,
      callKey,
    ],
  );

  const handleAnswer = useCallback(
    async (signal: CallSignal) => {
      const pc = pcRef.current;
      if (!pc) return;
      const attempt = attemptRef.current;
      const cancelled = () => attemptRef.current !== attempt;

      try {
        applyRemotePicture(signal);
        peerRestartsRef.current = signal.x === 1;
        peerFingerprintRef.current = signal.f ?? "";

        const answerSdp = buildSdpFromSignal(signal);
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
        if (cancelled()) return;
        refreshVideoLane();

        // ICE may have connected before the description's promise came back (two apps on one machine, in
        // WebKit): "connected" is not taken back.
        if (callStateRef.current === "offering") updateCallState("connecting");
      } catch (error) {
        if (cancelled()) return;
        onErrorRef.current?.(error);
        cleanupConnection();
        updateCallState("idle");
        setFastPoll(false);
      }
    },
    [applyRemotePicture, refreshVideoLane, updateCallState, cleanupConnection, setFastPoll],
  );

  const hangUp = useCallback(
    /** `unreachable`: the call could not connect, and the hang-up says so (`r: "u"`). */
    (sendSignal = true, addEndMessage = true, unreachable = false) => {
      if (hangupTimerRef.current) {
        clearTimeout(hangupTimerRef.current);
        hangupTimerRef.current = null;
      }

      const wasConnected = callConnectedEventFiredRef.current;
      // A call of ours that never connected keeps a line too: cancelled while it rang, or ended while it connected.
      const ringingOut = callStateRef.current === "offering";
      const wasCalling = callStateRef.current !== "idle" && callStateRef.current !== "incoming";
      if (callStateRef.current !== "idle") {
        traceCallEnd(sendSignal ? (unreachable ? "unreachable" : "hang-up") : "ended", { state: callStateRef.current, connected: wasConnected });
      }
      const duration = callStartedAt ? Date.now() - callStartedAt : undefined;

      if (sendSignal) {
        const signal: CallSignal = unreachable ? { t: "h", ts: Date.now(), r: "u" } : { t: "h", ts: Date.now() };
        publishCallSignal(JSON.stringify(signal));
        hangupTimerRef.current = setTimeout(() => {
          publishCallSignal(null);
          hangupTimerRef.current = null;
        }, 5000);
      } else {
        publishCallSignal(null);
      }

      if (addEndMessage && wasConnected) {
        addCallEventMessage?.("call_ended", callHadVideoRef.current, duration);
      } else if (addEndMessage && wasCalling) {
        addCallEventMessage?.(ringingOut && sendSignal ? "call_cancelled" : "call_ended", callHadVideoRef.current);
      }

      cleanupConnection();
      updateCallState("idle");
      pendingOfferRef.current = null;
      myOfferTimestampRef.current = 0;
      myOfferFingerprintRef.current = "";
      callConnectedEventFiredRef.current = false;
      callHadVideoRef.current = false;
      setFastPoll(false);
    },
    [publishCallSignal, cleanupConnection, updateCallState, setFastPoll, addCallEventMessage, callStartedAt],
  );

  const rejectCall = useCallback(() => {
    addCallEventMessage?.("call_rejected", callHadVideoRef.current);
    hangUp(true, false);
  }, [hangUp, addCallEventMessage]);

  const toggleMute = useCallback(() => {
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setIsMuted(!audioTrack.enabled);
    }
  }, []);

  /** Turns the camera on, or off. From a shared screen it switches to the camera. */
  const toggleVideo = useCallback(async () => {
    try {
      await showPicture(pictureRef.current === "camera" ? null : "camera");
    } catch (error) {
      onErrorRef.current?.(error);
      showMediaProblem(error);
    }
  }, [showPicture, showMediaProblem]);

  /** Shares the screen in place of whatever picture is on, or stops and goes back to it. */
  const toggleScreenShare = useCallback(async () => {
    // One picker at a time: a second press while it is open would ask again, and forget what to go back to.
    if (shareBusyRef.current) return;
    shareBusyRef.current = true;
    const sharing = pictureRef.current === "screen";
    if (!sharing) pictureBeforeShareRef.current = pictureRef.current;
    setScreenShareError(null);
    const asked = Date.now();
    try {
      if (sharing) await stopSharing();
      else await showPicture("screen");
    } catch (error) {
      const message = sharing ? null : screenShareErrorMessage(error, Date.now() - asked);
      // Closing the picker is not an error worth showing.
      if (sharing || message) onErrorRef.current?.(error);
      setScreenShareError(message);
    } finally {
      shareBusyRef.current = false;
    }
  }, [showPicture, stopSharing, setScreenShareError]);

  /**
   * Sends another microphone (null: the default) in place of the one the call has, with `replaceTrack`: no new
   * offer, and the peer hears no gap longer than the swap. A muted call stays muted.
   */
  const switchMicrophone = useCallback(async (deviceId: string | null) => {
    const pc = pcRef.current;
    const sender = pc ? audioTransceiver(pc)?.sender : undefined;
    if (!pc || !localStreamRef.current || !sender) throw new Error("This call has no microphone to switch");
    const attempt = attemptRef.current;
    const request = ++microphoneRequestRef.current;
    let track: MediaStreamTrack | undefined;
    try {
      track = (await mediaRef.current.getUserMedia({ audio: exactly(deviceId) })).getAudioTracks()[0];
      if (!track) throw Object.assign(new Error("No microphone"), { name: "NotFoundError" });
    } catch (error) {
      yieldRequest(microphoneRequestRef, request);
      throw error;
    }
    // Hung up meanwhile, or another microphone picked since (whichever opens first): the last one picked wins.
    if (attemptRef.current !== attempt || microphoneRequestRef.current !== request) { track.stop(); return; }
    track.enabled = localStreamRef.current?.getAudioTracks()[0]?.enabled ?? true;
    try {
      await sender.replaceTrack(track);
    } catch (error) {
      track.stop();
      throw error;
    }
    // Hung up while the track was swapped: the call's tracks were stopped without this one.
    if (attemptRef.current !== attempt || !localStreamRef.current) { track.stop(); return; }
    const current = localStreamRef.current;
    current.getAudioTracks().forEach((old) => {
      old.onended = null;
      old.stop();
    });
    const stream = new MediaStream([track, ...current.getVideoTracks()]);
    localStreamRef.current = stream;
    setLocalStream(stream);
  }, []);

  /** Shows another camera (null: the default) in place of the one on; with the camera off there is nothing to swap. */
  const switchCamera = useCallback(async (deviceId: string | null) => {
    if (pictureRef.current !== "camera") return;
    await showPicture("camera", deviceId);
  }, [showPicture]);

  useEffect(() => {
    if (!incomingCallSignal) return;

    // Validated and age-checked before any of it reaches an SDP.
    const signal = parseCallSignal(incomingCallSignal);
    if (!signal) return;

    if (signal.ts <= lastProcessedSignalRef.current) {
      return;
    }

    // The caller started over on a new connection (see `restartAnswer`): ICE may already say "connected" here.
    if (signal.t === "o" && restartable() && signal.ts > answeredRef.current!.offer.ts) {
      lastProcessedSignalRef.current = signal.ts;
      void restartAnswer(signal);
      return;
    }

    // Reconnecting (WISP 601): the caller's restart offer, answered on the call's own connection by the side that
    // answered the call, and that side's answer to it. Neither ever rings, nor starts a call: with no call on, or on
    // the wrong side of one, it is dropped.
    if (signal.t === "r") {
      lastProcessedSignalRef.current = signal.ts;
      if (callStateRef.current === "connected" && answeredRef.current) {
        applyRemotePicture(signal);
        answerIceRestart(signal);
      }
      return;
    }
    if (signal.t === "a" && signal.re !== undefined) {
      lastProcessedSignalRef.current = signal.ts;
      // Only the answer to the latest restart offer: one to an older offer has credentials this side replaced.
      if (callStateRef.current === "connected" && !answeredRef.current && restartOfferRef.current && signal.re === restartOfferRef.current) {
        applyRemotePicture(signal);
        void applyIceRestartAnswer(signal);
      }
      return;
    }

    if (callStateRef.current === "connected") {
      if (signal.t !== "h" && signal.t !== "v") {
        return;
      }
    }

    // Both called at once (WISP 601, "Both call at once"): each side decides alike from the two offers themselves, the
    // earlier one wins and, at the same millisecond, the lower DTLS fingerprint. Ours still gathering is later than
    // theirs. The side whose offer lost drops its own attempt, sends nothing (a hang-up would end the winner's call),
    // and rings with the winner's offer; the winner's call keeps ringing the other side.
    let yielded = false;
    if (signal.t === "o" && callStateRef.current === "offering") {
      lastProcessedSignalRef.current = signal.ts;
      const mine = myOfferTimestampRef.current;
      const theirsFirst = !mine || signal.ts < mine || (signal.ts === mine && (signal.f ?? "") < myOfferFingerprintRef.current);
      if (!theirsFirst) return;
      cleanupConnection();
      myOfferTimestampRef.current = 0;
      myOfferFingerprintRef.current = "";
      // Our attempt is not a call of its own: the chat keeps the winner's lines only, as the contact's chat does.
      if (startedLineRef.current) removeCallEventMessage?.(startedLineRef.current);
      startedLineRef.current = null;
      yielded = true;
    }

    if (signal.t === "o" && (callStateRef.current === "idle" || yielded)) {
      pendingOfferRef.current = signal;
      lastProcessedSignalRef.current = signal.ts;
      const offerHasVideo = signalHasVideo(signal);
      callHadVideoRef.current = offerHasVideo;
      callConnectedEventFiredRef.current = false;
      addCallEventMessage?.("call_received", offerHasVideo, undefined, signal.ts);
      updateCallState("incoming");
      setFastPoll(true);
    } else if (signal.t === "a" && (callStateRef.current === "offering" || callStateRef.current === "connecting")) {
      if (signal.ts > myOfferTimestampRef.current) {
        lastProcessedSignalRef.current = signal.ts;
        if (callStateRef.current === "offering") {
          handleAnswer(signal);
        }
      }
    } else if (signal.t === "v") {
      lastProcessedSignalRef.current = signal.ts;
      if (callStateRef.current !== "idle") applyRemotePicture(signal);
    } else if (signal.t === "h") {
      lastProcessedSignalRef.current = signal.ts;
      if (callStateRef.current !== "idle") traceCallEnd("contact-hang-up", { state: callStateRef.current, ...(signal.r && { r: signal.r }) });
      // The caller gave up (or its ring ran out) before we answered: a missed call, as when our own ring runs out.
      if (callStateRef.current === "incoming") addCallEventMessage?.("call_missed", callHadVideoRef.current, undefined, pendingOfferRef.current?.ts);
      else if (callStateRef.current === "offering" && signal.r !== "u" && myOfferTimestampRef.current && signal.ts > myOfferTimestampRef.current) {
        // Our call still rang there: the contact declined it (a side that rings sends nothing else).
        addCallEventMessage?.("call_rejected", callHadVideoRef.current);
        hangUp(false, false);
        return;
      } else if (signal.r === "u" && callStateRef.current !== "idle" && !callConnectedEventFiredRef.current) {
        // The contact's side could not connect (it found no candidate, or the call did not connect in time): this
        // side's call could not either, and says so the same way.
        addCallEventMessage?.("call_failed", callHadVideoRef.current);
        hangUp(false, false);
        return;
      }
      if (callStateRef.current !== "idle") {
        hangUp(false);
      }
    }
  }, [incomingCallSignal, handleAnswer, hangUp, updateCallState, setFastPoll, addCallEventMessage, applyRemotePicture, restartAnswer, restartable, cleanupConnection, removeCallEventMessage, answerIceRestart, applyIceRestartAnswer]);

  // An unanswered call does not ring forever (RING_MS). Ours hangs up and says "No answer". Theirs stops ringing here
  // with a missed call and sends nothing: the caller's own ring runs out too, and a hang-up would read as declined.
  hangUpRef.current = hangUp;
  useEffect(() => {
    if (callState !== "offering" && callState !== "incoming") return;
    const ringing = callState;
    const timer = setTimeout(() => {
      if (callStateRef.current !== ringing) return;
      if (ringing === "offering") {
        addCallEventMessageRef.current?.("call_unanswered", callHadVideoRef.current);
        hangUpRef.current(true, false);
        setNoAnswer(true);
      } else {
        addCallEventMessageRef.current?.("call_missed", callHadVideoRef.current, undefined, pendingOfferRef.current?.ts);
        hangUpRef.current(false, false);
      }
    }, RING_MS);
    return () => clearTimeout(timer);
  }, [callState]);

  // The app or the tab closes mid-call (Ghostly Desktop's `ghostly-departing`, a page's `pagehide`): it hangs up as
  // its person would, so the contact's call ends now and not when its connection gives up, and this chat keeps the
  // call's end line. A call still ringing here is left to ring out on the caller's side: a hang-up would read as declined.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const leaving = (event: Event) => {
      if (callStateRef.current === "idle" || callStateRef.current === "incoming") return;
      traceCallEnd("app-leaving", { event: event.type });
      hangUpRef.current(true, true);
    };
    window.addEventListener("pagehide", leaving);
    window.addEventListener("ghostly-departing", leaving);
    return () => {
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("ghostly-departing", leaving);
    };
  }, []);

  // A call that neither connects nor fails (neither side's ICE ever found a pair) ends, instead of saying
  // "Connecting..." forever; the other side is told with a hang-up.
  useEffect(() => {
    if (callState !== "connecting") return;
    const timer = setTimeout(() => {
      if (callStateRef.current !== "connecting") return;
      onErrorRef.current?.(new CallUnreachableError("The call could not connect"));
      couldNotConnect(true);
    }, CONNECT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [callState, couldNotConnect]);

  useEffect(() => {
    if (!noAnswer) return;
    const timer = setTimeout(() => setNoAnswer(false), NO_ANSWER_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [noAnswer]);

  useEffect(() => {
    if (!mediaProblemShown) return;
    const timer = setTimeout(() => setMediaProblemShown(null), MEDIA_PROBLEM_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [mediaProblemShown]);

  useEffect(() => {
    const attempts = attemptRef;
    return () => {
      // Not on a call any more as far as the other chats can tell.
      setCallOn(callKey, null);
      // A start or an answer still waiting for the microphone or for ICE is cancelled, as a hang-up cancels it.
      attempts.current++;
      // The chat holding the call went away with it on: nothing is sent, and the contact's call ends when its media does.
      if (callStateRef.current !== "idle") traceCallEnd("unloaded", { state: callStateRef.current });
      if (hangupTimerRef.current) clearTimeout(hangupTimerRef.current);
      if (screenShareErrorTimerRef.current) clearTimeout(screenShareErrorTimerRef.current);
      if (restartGraceRef.current) clearTimeout(restartGraceRef.current);
      for (const timer of [reconnectTimerRef, disconnectGraceRef, restartRetryRef]) if (timer.current) clearTimeout(timer.current);

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => {
          t.onended = null;
          t.stop();
        });
        localStreamRef.current = null;
      }

      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
  }, [callKey]);

  /** A call is on in another chat: answering the one that rings here ends it first ("End and answer"). */
  const otherCallOn = useSyncExternalStore(subscribeCalls, () => anotherCallOn(callKey), () => false);

  const connected = callState === "connected";
  // Phones have no screen to capture (no getDisplayMedia): there the share button does not show at all.
  const screenCapture = media ? typeof media.getDisplayMedia === "function" : typeof navigator.mediaDevices?.getDisplayMedia === "function";

  return {
    callState,
    localStream,
    remoteStream,
    isMuted,
    /** We are not sending any picture: an audio call, or a camera turned off. */
    isVideoOff: picture === null,
    isScreenSharing: picture === "screen",
    /** The peer is sending a picture we can show. */
    remoteHasVideo: remotePicture !== null,
    /** The picture the peer is sending is its screen. */
    remoteIsScreenSharing: remotePicture === "screen",
    /** A camera or a screen can be turned on right now, even if the call started as audio. */
    canSendVideo: connected && videoLaneOpen,
    /** The screen can be shared right now: a connected call with a video lane, voice or video, and a screen to capture. */
    canShareScreen: connected && videoLaneOpen && screenCapture,
    /**
     * Why a connected call cannot carry a screen: the peer's offer had no video section, or its answer refused
     * ours; or this app cannot capture one and says why (`CallMedia.screenUnavailable`). Null when it can, and
     * where there is no screen to capture and nothing to say (phones).
     */
    screenShareUnavailable: !connected ? null
      : screenCapture ? (videoLaneOpen ? null : "Your contact's app cannot show a screen in this call")
      : media?.screenUnavailable ?? null,
    /** Why sharing the screen just failed, for a few seconds. */
    screenShareError,
    /** Our last call rang out with no answer, for a few seconds. */
    noAnswer,
    mediaProblem: mediaProblemShown,
    callStartedAt,
    /**
     * The connected call lost its path (a network change) and is getting it back: the call window says
     * "Reconnecting...". `callState` stays "connected"; the call ends as usual if the path does not come back in time.
     */
    reconnecting,
    /**
     * A call is on in another chat of this app. A call that rings here then offers "End and answer": `acceptCall` ends
     * that call first, and `startCall` places nothing until it has ended.
     */
    otherCallOn,
    startCall,
    acceptCall,
    hangUp,
    rejectCall,
    toggleMute,
    toggleVideo,
    toggleScreenShare,
    /** The microphone and camera can be switched in the call: the page's own capture, or a `media` that chooses devices. */
    canSwitchDevices: !media || !!media.choosesDevices,
    switchMicrophone,
    switchCamera,
  };
}
