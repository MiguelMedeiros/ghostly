import { useState, useRef, useEffect, useCallback } from "react";
import {
  RTC_CONFIG,
  extractParamsFromSdp,
  buildSdpFromSignal,
  parseCallSignal,
  signalHasVideo,
  waitForIceGathering,
  type CallState,
  type CallSignal,
  type CallEventType,
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
}

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

export function useWebRTC({
  incomingCallSignal,
  publishCallSignal,
  setFastPoll,
  addCallEventMessage,
  onError,
}: UseWebRTCParams) {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

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
    const pc = new RTCPeerConnection(RTC_CONFIG);

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
    async (next: Picture | null) => {
      const pc = pcRef.current;
      const sender = pc ? videoTransceiver(pc)?.sender : undefined;
      if (!pc || !localStreamRef.current || !sender) throw new Error("This call has no video to send on");
      const attempt = attemptRef.current;

      let track: MediaStreamTrack | null = null;
      if (next === "camera") {
        track = (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0];
      } else if (next === "screen") {
        track = (await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })).getVideoTracks()[0];
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
          if (callStateRef.current !== "idle") void stopSharingRef.current().catch(() => {});
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
    [setPicture, publishPicture],
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
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
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
        const params = extractParamsFromSdp(sdp);

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

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: withVideo,
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
        const params = extractParamsFromSdp(sdp);

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
        updateCallState("connecting");
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

      try {
        applyRemotePicture(signal);

        const answerSdp = buildSdpFromSignal(signal);
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
        refreshVideoLane();

        updateCallState("connecting");
      } catch (error) {
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
  const screenCapture = typeof navigator.mediaDevices?.getDisplayMedia === "function";

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
     * Why a connected call cannot carry a screen, where screens can be captured: the peer's offer had no video
     * section, or its answer refused ours. Null when it can, and where there is no screen to capture.
     */
    screenShareUnavailable: connected && screenCapture && !videoLaneOpen ? "Your contact's app cannot show a screen in this call" : null,
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
  };
}
