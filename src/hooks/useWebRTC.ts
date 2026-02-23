import { useState, useRef, useEffect, useCallback } from "react";
import type { CallState, CallSignal, CallEventType } from "../lib/types";
import {
  RTC_CONFIG,
  extractParamsFromSdp,
  buildSdpFromSignal,
  waitForIceGathering,
} from "../lib/webrtc";

interface UseWebRTCParams {
  incomingCallSignal: string | null;
  publishCallSignal: (signal: string | null) => void;
  setFastPoll: (fast: boolean) => void;
  addCallEventMessage?: (type: CallEventType, hasVideo: boolean, duration?: number) => void;
}

export function useWebRTC({
  incomingCallSignal,
  publishCallSignal,
  setFastPoll,
  addCallEventMessage,
}: UseWebRTCParams) {
  const [callState, setCallState] = useState<CallState>("idle");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
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
    setHasVideo(false);
    setCallStartedAt(null);
  }, []);

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

  const startCall = useCallback(
    async (withVideo: boolean) => {
      if (callStateRef.current !== "idle") return;

      try {
        setFastPoll(true);
        setHasVideo(withVideo);
        hasVideoRef.current = withVideo;
        callConnectedEventFiredRef.current = false;
        updateCallState("offering");
        addCallEventMessage?.("call_started", withVideo);

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: withVideo,
        });
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
      } catch {
        cleanupConnection();
        updateCallState("idle");
        setFastPoll(false);
      }
    },
    [
      createPeerConnection,
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
      } catch {
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
      } catch {
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

  return {
    callState,
    localStream,
    remoteStream,
    isMuted,
    isVideoOff,
    hasVideo,
    callStartedAt,
    startCall,
    acceptCall,
    hangUp,
    rejectCall,
    toggleMute,
    toggleVideo,
  };
}
