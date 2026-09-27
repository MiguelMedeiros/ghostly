import { useState, useRef, useEffect, useCallback } from "react";
import {
  callRtcConfig,
  extractParamsFromSdp,
  buildSdpFromSignal,
  parseCallSignal,
  signalHasVideo,
  waitForIceGathering,
  type CallState,
  type CallSignal,
  type CallEventType,
  type CallMedia,
  type CallIceServer,
} from "@ghostly/core";

/** What a peer can put on the video lane of a call. */
export type Picture = "camera" | "screen";

interface UseWebRTCParams {
  incomingCallSignal: string | null;
  publishCallSignal: (signal: string | null) => void;
  setFastPoll: (fast: boolean) => void;
  addCallEventMessage?: (type: CallEventType, hasVideo: boolean, duration?: number) => void;
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
   * `ideal` falls back to the default when the device is gone). Only for the page's own capture: `media` picks its own.
   */
  devices?: () => { audio?: ConstrainDOMString; video?: ConstrainDOMString };
}

/** The browser's own WebRTC and capture. */
const browserMedia: CallMedia = {
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

/** Capture from exactly this device, or from the default (null). */
const exactly = (deviceId: string | null): MediaTrackConstraints | true => (deviceId ? { deviceId: { exact: deviceId } } : true);

export function useWebRTC({
  incomingCallSignal,
  publishCallSignal,
  setFastPoll,
  addCallEventMessage,
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
  devicesRef.current = media ? undefined : devices;

  /** What to capture `kind` from: the chosen device, or whatever the default is. */
  const captureFrom = useCallback((kind: "audio" | "video"): MediaTrackConstraints | true => {
    const deviceId = devicesRef.current?.()[kind];
    return deviceId ? { deviceId } : true;
  }, []);

  const [callState, setCallState] = useState<CallState>("idle");
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
  /** Why the last attempt to share the screen failed, for a few seconds. */
  const [screenShareError, setScreenShareErrorState] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const lastProcessedSignalRef = useRef<number>(0);
  const callStateRef = useRef<CallState>("idle");
  const pendingOfferRef = useRef<CallSignal | null>(null);
  const hangupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myOfferTimestampRef = useRef<number>(0);
  /** Whether a picture was on at any point, which is what the chat log calls a video call. */
  const callHadVideoRef = useRef<boolean>(false);
  const callConnectedEventFiredRef = useRef<boolean>(false);
  const pictureRef = useRef<Picture | null>(null);
  /** What we were showing before the screen took the lane, to go back to when sharing stops. */
  const pictureBeforeShareRef = useRef<Picture | null>(null);
  /** A share is being started or stopped: the picker may be open. */
  const shareBusyRef = useRef(false);
  const screenShareErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setScreenShareError = useCallback((message: string | null) => {
    if (screenShareErrorTimerRef.current) clearTimeout(screenShareErrorTimerRef.current);
    screenShareErrorTimerRef.current = message ? setTimeout(() => setScreenShareErrorState(null), SCREEN_SHARE_ERROR_MS) : null;
    setScreenShareErrorState(message);
  }, []);

  const setPicture = useCallback((next: Picture | null) => {
    pictureRef.current = next;
    setPictureState(next);
  }, []);

  const updateCallState = useCallback((state: CallState) => {
    callStateRef.current = state;
    setCallState(state);
  }, []);

  /**
   * Which call attempt is current. Hanging up (or any cleanup) moves it on, so a start or an answer
   * still waiting for the camera or for ICE finds out it was cancelled: it lets go of what it got and
   * sends nothing, instead of ringing someone for a call that no longer exists.
   */
  const attemptRef = useRef(0);

  const cleanupConnection = useCallback(() => {
    attemptRef.current++;
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
  }, [setPicture, setScreenShareError]);

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
      const state = pc.iceConnectionState;

      if (state === "connected" || state === "completed") {
        updateCallState("connected");
        refreshVideoLane();
        setCallStartedAt(Date.now());
        setFastPoll(false);
        if (!callConnectedEventFiredRef.current) {
          callConnectedEventFiredRef.current = true;
          addCallEventMessage?.("call_connected", callHadVideoRef.current);
        }
      } else if (state === "failed" || state === "closed") {
        cleanupConnection();
        updateCallState("idle");
        publishCallSignal(null);
        setFastPoll(false);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;

      if (state === "connected") {
        if (callStateRef.current === "connecting" || callStateRef.current === "answering") {
          updateCallState("connected");
          refreshVideoLane();
          setCallStartedAt(Date.now());
          setFastPoll(false);
          if (!callConnectedEventFiredRef.current) {
            callConnectedEventFiredRef.current = true;
            addCallEventMessage?.("call_connected", callHadVideoRef.current);
          }
        }
      } else if (state === "failed") {
        cleanupConnection();
        updateCallState("idle");
        publishCallSignal(null);
        setFastPoll(false);
      }
    };

    pc.onsignalingstatechange = () => {};

    pcRef.current = pc;
    return pc;
  }, [updateCallState, setFastPoll, cleanupConnection, publishCallSignal, addCallEventMessage, refreshVideoLane]);

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

      let track: MediaStreamTrack | null = null;
      if (next === "camera") {
        track = (await mediaRef.current.getUserMedia({ video: camera === undefined ? captureFrom("video") : exactly(camera) })).getVideoTracks()[0];
      } else if (next === "screen") {
        const { getDisplayMedia } = mediaRef.current;
        if (!getDisplayMedia) throw Object.assign(new Error("Screen sharing is not available here"), { name: "NotSupportedError" });
        track = (await getDisplayMedia({ video: true, audio: false })).getVideoTracks()[0];
      }
      // The call ended while the prompt or the picker was open: what it gave is let go, and nobody is told.
      if (attemptRef.current !== attempt) {
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
      if (callStateRef.current !== "idle") return;

      // A hang-up schedules clearing `_call` a few seconds later; that must not
      // wipe the offer of a call placed in the meantime.
      if (hangupTimerRef.current) {
        clearTimeout(hangupTimerRef.current);
        hangupTimerRef.current = null;
      }

      const attempt = ++attemptRef.current;
      const cancelled = () => attemptRef.current !== attempt;
      try {
        setFastPoll(true);
        callHadVideoRef.current = withVideo;
        callConnectedEventFiredRef.current = false;
        updateCallState("offering");
        addCallEventMessage?.("call_started", withVideo);

        // A screen is shared from inside a call (`toggleScreenShare`), never as the way one starts.
        const stream = await mediaRef.current.getUserMedia({ audio: captureFrom("audio"), video: withVideo && captureFrom("video") });
        if (cancelled()) { stream.getTracks().forEach((track) => track.stop()); return; }
        localStreamRef.current = stream;
        setLocalStream(stream);
        setPicture(withVideo ? "camera" : null);

        const pc = createPeerConnection();
        stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
        stream.getVideoTracks().forEach((track) => pc.addTrack(track, stream));
        // An audio call still offers a video section, so a camera or a screen can
        // be turned on later without a second offer the peer cannot answer.
        if (stream.getVideoTracks().length === 0) pc.addTransceiver("video", { direction: "sendrecv" });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);
        if (cancelled()) return;

        const sdp = pc.localDescription!.sdp;
        const params = extractParamsFromSdp(sdp, { maxCandidates: maxCandidatesRef.current });

        const offerTs = Date.now();
        myOfferTimestampRef.current = offerTs;

        const signal: CallSignal = {
          t: "o",
          ts: offerTs,
          ...params,
          v: withVideo ? 1 : 0,
        };
        if (withVideo) signal.k = "c";

        const signalStr = JSON.stringify(signal);
        publishCallSignal(signalStr);
      } catch (error) {
        // A newer attempt (or none) owns the call now: its state is not ours to reset.
        if (cancelled()) return;
        onErrorRef.current?.(error);
        cleanupConnection();
        updateCallState("idle");
        setFastPoll(false);
      }
    },
    [
      createPeerConnection,
      captureFrom,
      setPicture,
      publishCallSignal,
      setFastPoll,
      updateCallState,
      cleanupConnection,
      addCallEventMessage,
    ],
  );

  const acceptCall = useCallback(
    async (withVideo: boolean) => {
      const offer = pendingOfferRef.current;
      if (!offer || callStateRef.current !== "incoming") return;

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

        const pc = createPeerConnection();
        stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
        stream.getVideoTracks().forEach((track) => pc.addTrack(track, stream));

        const offerSdp = buildSdpFromSignal(offer);

        await pc.setRemoteDescription({
          type: "offer",
          sdp: offerSdp,
        });

        // Answering an offer with no camera of our own leaves the video section
        // receive-only; opening it keeps our side of the lane free for later.
        const video = videoTransceiver(pc);
        if (video && video.direction !== "sendrecv") video.direction = "sendrecv";

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc);
        if (cancelled()) return;

        const sdp = pc.localDescription!.sdp;
        const params = extractParamsFromSdp(sdp, { maxCandidates: maxCandidatesRef.current });

        const signal: CallSignal = {
          t: "a",
          ts: Date.now(),
          ...params,
          v: withVideo ? 1 : 0,
        };
        if (withVideo) signal.k = "c";

        const signalStr = JSON.stringify(signal);
        publishCallSignal(signalStr);
        refreshVideoLane();
        // Read again (the check above narrowed it to "incoming"): ICE may have connected while our answer gathered.
        if ((callStateRef.current as CallState) === "answering") updateCallState("connecting");
        pendingOfferRef.current = null;
      } catch (error) {
        if (cancelled()) return;
        onErrorRef.current?.(error);
        cleanupConnection();
        updateCallState("idle");
        setFastPoll(false);
      }
    },
    [
      createPeerConnection,
      captureFrom,
      applyRemotePicture,
      setPicture,
      publishCallSignal,
      refreshVideoLane,
      updateCallState,
      cleanupConnection,
      setFastPoll,
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
    (sendSignal = true, addEndMessage = true) => {
      if (hangupTimerRef.current) {
        clearTimeout(hangupTimerRef.current);
        hangupTimerRef.current = null;
      }

      const wasConnected = callConnectedEventFiredRef.current;
      const duration = callStartedAt ? Date.now() - callStartedAt : undefined;

      if (sendSignal) {
        const signal: CallSignal = { t: "h", ts: Date.now() };
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
      }

      cleanupConnection();
      updateCallState("idle");
      pendingOfferRef.current = null;
      myOfferTimestampRef.current = 0;
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
    }
  }, [showPicture]);

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
    const track = (await mediaRef.current.getUserMedia({ audio: exactly(deviceId) })).getAudioTracks()[0];
    if (!track) throw Object.assign(new Error("No microphone"), { name: "NotFoundError" });
    if (attemptRef.current !== attempt) { track.stop(); return; }
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

    if (callStateRef.current === "connected") {
      if (signal.t !== "h" && signal.t !== "v") {
        return;
      }
    }

    if (signal.t === "o" && callStateRef.current === "idle") {
      pendingOfferRef.current = signal;
      lastProcessedSignalRef.current = signal.ts;
      const offerHasVideo = signalHasVideo(signal);
      callHadVideoRef.current = offerHasVideo;
      callConnectedEventFiredRef.current = false;
      addCallEventMessage?.("call_received", offerHasVideo);
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
      if (callStateRef.current !== "idle") {
        hangUp(false);
      }
    }
  }, [incomingCallSignal, handleAnswer, hangUp, updateCallState, setFastPoll, addCallEventMessage, applyRemotePicture]);

  useEffect(() => {
    const attempts = attemptRef;
    return () => {
      // A start or an answer still waiting for the microphone or for ICE is cancelled, as a hang-up cancels it.
      attempts.current++;
      if (hangupTimerRef.current) clearTimeout(hangupTimerRef.current);
      if (screenShareErrorTimerRef.current) clearTimeout(screenShareErrorTimerRef.current);

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
  }, []);

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
    callStartedAt,
    startCall,
    acceptCall,
    hangUp,
    rejectCall,
    toggleMute,
    toggleVideo,
    toggleScreenShare,
    /** The microphone and camera can be switched in the call: the page's own capture (not Linux's native media). */
    canSwitchDevices: !media,
    switchMicrophone,
    switchCamera,
  };
}
