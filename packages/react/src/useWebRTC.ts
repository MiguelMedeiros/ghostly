import { useState, useRef, useEffect, useCallback } from "react";
import {
  RTC_CONFIG,
  extractParamsFromSdp,
  buildSdpFromSignal,
  waitForIceGathering,
  type CallState,
  type CallSignal,
  type CallEventType,
} from "@ghostly/core";

interface UseWebRTCParams {
  incomingCallSignal: string | null;
  publishCallSignal: (signal: string | null) => void;
  setFastPoll: (fast: boolean) => void;
  addCallEventMessage?: (type: CallEventType, hasVideo: boolean, duration?: number) => void;
  /** Called when a call could not be placed or answered, e.g. the microphone was denied. */
  onError?: (error: unknown) => void;
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
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isScreenSharing, setIsScreenSharingState] = useState(false);
  const isScreenSharingRef = useRef(false);
  const setIsScreenSharing = useCallback((sharing: boolean) => {
    isScreenSharingRef.current = sharing;
    setIsScreenSharingState(sharing);
  }, []);
  /** Whether this call negotiated a video stream we send on, which is what a screen can ride on. */
  const [sendsVideo, setSendsVideo] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const lastProcessedSignalRef = useRef<number>(0);
  const callStateRef = useRef<CallState>("idle");
  const pendingOfferRef = useRef<CallSignal | null>(null);
  const hangupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myOfferTimestampRef = useRef<number>(0);
  const hasVideoRef = useRef<boolean>(false);
  const callConnectedEventFiredRef = useRef<boolean>(false);

  const updateCallState = useCallback((state: CallState) => {
    callStateRef.current = state;
    setCallState(state);
  }, []);

  const cleanupConnection = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    
    setLocalStream(null);
    setRemoteStream(null);
    setIsMuted(false);
    setIsVideoOff(false);
    setIsScreenSharing(false);
    setSendsVideo(false);
    setHasVideo(false);
    setCallStartedAt(null);
  }, [setIsScreenSharing]);

  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.ontrack = (event) => {
      if (event.track.kind === "video") {
        setHasVideo(true);
      }
      
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
        setSendsVideo(pc.getTransceivers().some((t) => t.receiver.track.kind === "video" && !!t.currentDirection?.includes("send")));
        setCallStartedAt(Date.now());
        setFastPoll(false);
        if (!callConnectedEventFiredRef.current) {
          callConnectedEventFiredRef.current = true;
          addCallEventMessage?.("call_connected", hasVideoRef.current);
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
          setCallStartedAt(Date.now());
          setFastPoll(false);
          if (!callConnectedEventFiredRef.current) {
            callConnectedEventFiredRef.current = true;
            addCallEventMessage?.("call_connected", hasVideoRef.current);
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
  }, [updateCallState, setFastPoll, cleanupConnection, publishCallSignal, addCallEventMessage]);

  /**
   * Swaps what the video sender carries, camera or screen. `replaceTrack` needs no
   * renegotiation, so this works with any peer that is in a video call with us.
   */
  const swapVideoTrack = useCallback(async (next: MediaStreamTrack | null) => {
    const pc = pcRef.current;
    const current = localStreamRef.current;
    const sender = pc?.getTransceivers().find((t) => t.receiver.track.kind === "video" && t.currentDirection?.includes("send"))?.sender;
    if (!pc || !current || !sender) throw new Error("This call has no video to replace");
    await sender.replaceTrack(next);
    current.getVideoTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    const stream = new MediaStream([...current.getAudioTracks(), ...(next ? [next] : [])]);
    localStreamRef.current = stream;
    setLocalStream(stream);
    setIsVideoOff(next === null);
  }, []);

  const stopScreenShare = useCallback(async () => {
    setIsScreenSharing(false);
    if (callStateRef.current === "idle") return;
    const camera = await navigator.mediaDevices.getUserMedia({ video: true }).then((s) => s.getVideoTracks()[0], () => null);
    await swapVideoTrack(camera).catch(() => camera?.stop());
  }, [swapVideoTrack, setIsScreenSharing]);

  // The browser's own "Stop sharing" button ends the track without telling anyone else.
  const watchScreenTrack = useCallback(
    (track: MediaStreamTrack) => {
      track.contentHint = "detail";
      track.onended = () => void stopScreenShare();
    },
    [stopScreenShare],
  );

  const startCall = useCallback(
    async (withVideo: boolean, source: "camera" | "screen" = "camera") => {
      if (callStateRef.current !== "idle") return;

      // A hang-up schedules clearing `_call` a few seconds later; that must not
      // wipe the offer of a call placed in the meantime.
      if (hangupTimerRef.current) {
        clearTimeout(hangupTimerRef.current);
        hangupTimerRef.current = null;
      }

      try {
        setFastPoll(true);
        setHasVideo(withVideo);
        hasVideoRef.current = withVideo;
        callConnectedEventFiredRef.current = false;
        updateCallState("offering");
        addCallEventMessage?.("call_started", withVideo);

        let stream: MediaStream;
        if (withVideo && source === "screen") {
          // To the peer this is an ordinary video call; the picture just happens to be the screen.
          const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((error) => {
            display.getTracks().forEach((track) => track.stop());
            throw error;
          });
          stream = new MediaStream([...mic.getAudioTracks(), ...display.getVideoTracks()]);
          watchScreenTrack(display.getVideoTracks()[0]);
          setIsScreenSharing(true);
        } else {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
        }
        localStreamRef.current = stream;
        setLocalStream(stream);

        const pc = createPeerConnection();
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);

        const sdp = pc.localDescription!.sdp;
        const params = extractParamsFromSdp(sdp);

        const offerTs = Date.now();
        myOfferTimestampRef.current = offerTs;
        
        const signal: CallSignal = {
          t: "o",
          ts: offerTs,
          ...params,
        };

        const signalStr = JSON.stringify(signal);
        publishCallSignal(signalStr);
      } catch (error) {
        onErrorRef.current?.(error);
        cleanupConnection();
        updateCallState("idle");
        setFastPoll(false);
      }
    },
    [
      createPeerConnection,
      setIsScreenSharing,
      watchScreenTrack,
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

      try {
        const offerHasVideo = offer.m?.includes("v") ?? false;
        updateCallState("answering");
        setHasVideo(withVideo || offerHasVideo);
        hasVideoRef.current = withVideo || offerHasVideo;
        callConnectedEventFiredRef.current = false;

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: withVideo,
        });
        localStreamRef.current = stream;
        setLocalStream(stream);

        const pc = createPeerConnection();
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const offerSdp = buildSdpFromSignal(offer, "offer");
        
        await pc.setRemoteDescription({
          type: "offer",
          sdp: offerSdp,
        });

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc);

        const sdp = pc.localDescription!.sdp;
        const params = extractParamsFromSdp(sdp);

        const signal: CallSignal = {
          t: "a",
          ts: Date.now(),
          ...params,
        };

        const signalStr = JSON.stringify(signal);
        publishCallSignal(signalStr);
        updateCallState("connecting");
        pendingOfferRef.current = null;
      } catch (error) {
        onErrorRef.current?.(error);
        cleanupConnection();
        updateCallState("idle");
        setFastPoll(false);
      }
    },
    [
      createPeerConnection,
      publishCallSignal,
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
        if (signal.m?.includes("v")) {
          setHasVideo(true);
        }
        
        const answerSdp = buildSdpFromSignal(signal, "answer");
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

        updateCallState("connecting");
      } catch (error) {
        onErrorRef.current?.(error);
        cleanupConnection();
        updateCallState("idle");
        setFastPoll(false);
      }
    },
    [updateCallState, cleanupConnection, setFastPoll],
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
        addCallEventMessage?.("call_ended", hasVideoRef.current, duration);
      }

      cleanupConnection();
      updateCallState("idle");
      pendingOfferRef.current = null;
      myOfferTimestampRef.current = 0;
      callConnectedEventFiredRef.current = false;
      setFastPoll(false);
    },
    [publishCallSignal, cleanupConnection, updateCallState, setFastPoll, addCallEventMessage, callStartedAt],
  );

  const rejectCall = useCallback(() => {
    addCallEventMessage?.("call_rejected", hasVideoRef.current);
    hangUp(true, false);
  }, [hangUp, addCallEventMessage]);

  const toggleMute = useCallback(() => {
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setIsMuted(!audioTrack.enabled);
    }
  }, []);

  const toggleVideo = useCallback(() => {
    const videoTrack = localStreamRef.current?.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      setIsVideoOff(!videoTrack.enabled);
    }
  }, []);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharingRef.current) return stopScreenShare();
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = display.getVideoTracks()[0];
      await swapVideoTrack(track).catch((error) => {
        track.stop();
        throw error;
      });
      watchScreenTrack(track);
      setIsScreenSharing(true);
    } catch (error) {
      // Closing the picker is not an error worth showing.
      if ((error as DOMException)?.name !== "NotAllowedError") onErrorRef.current?.(error);
    }
  }, [stopScreenShare, swapVideoTrack, watchScreenTrack, setIsScreenSharing]);

  useEffect(() => {
    if (!incomingCallSignal) return;

    let signal: CallSignal;
    try {
      signal = JSON.parse(incomingCallSignal);
    } catch {
      return;
    }

    if (signal.ts <= lastProcessedSignalRef.current) {
      return;
    }

    if (callStateRef.current === "connected") {
      if (signal.t !== "h") {
        return;
      }
    }

    if (signal.t === "o" && callStateRef.current === "idle") {
      pendingOfferRef.current = signal;
      lastProcessedSignalRef.current = signal.ts;
      const offerHasVideo = signal.m?.includes("v") ?? false;
      hasVideoRef.current = offerHasVideo;
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
    } else if (signal.t === "h") {
      lastProcessedSignalRef.current = signal.ts;
      if (callStateRef.current !== "idle") {
        hangUp(false);
      }
    }
  }, [incomingCallSignal, handleAnswer, hangUp, updateCallState, setFastPoll, addCallEventMessage]);

  useEffect(() => {
    return () => {
      if (hangupTimerRef.current) clearTimeout(hangupTimerRef.current);
      
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
      
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
  }, []);

  const canShareScreen = callState === "connected" && sendsVideo && typeof navigator.mediaDevices?.getDisplayMedia === "function";

  return {
    callState,
    localStream,
    remoteStream,
    isMuted,
    isVideoOff,
    isScreenSharing,
    canShareScreen,
    hasVideo,
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
