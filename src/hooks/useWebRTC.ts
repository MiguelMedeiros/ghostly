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
    console.log("[webrtc] cleanupConnection called");
    
    if (localStreamRef.current) {
      console.log("[webrtc] stopping local stream tracks:", localStreamRef.current.getTracks().map(t => t.kind));
      localStreamRef.current.getTracks().forEach((t) => {
        t.stop();
        console.log("[webrtc] stopped track:", t.kind, t.readyState);
      });
      localStreamRef.current = null;
    }
    
    if (pcRef.current) {
      console.log("[webrtc] closing peer connection");
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
      console.log("[webrtc] ontrack:", event.track.kind, "readyState:", event.track.readyState);
      console.log("[webrtc] ontrack streams:", event.streams.length, "tracks in stream[0]:", event.streams[0]?.getTracks().length);
      
      if (event.track.kind === "video") {
        console.log("[webrtc] received video track, setting hasVideo to true");
        setHasVideo(true);
      }
      
      setRemoteStream((prev) => {
        if (event.streams[0]) {
          console.log("[webrtc] Using event.streams[0] with tracks:", event.streams[0].getTracks().map(t => t.kind));
          return event.streams[0];
        }
        const stream = prev ?? new MediaStream();
        stream.addTrack(event.track);
        console.log("[webrtc] Added track to stream, total tracks:", stream.getTracks().map(t => t.kind));
        return stream;
      });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("[webrtc] new ICE candidate:", event.candidate.candidate);
      } else {
        console.log("[webrtc] ICE gathering complete");
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      const gatherState = pc.iceGatheringState;
      console.log("[webrtc] ICE connection state:", state, "gathering:", gatherState);
      
      if (state === "checking") {
        console.log("[webrtc] ICE checking - attempting to connect...");
      } else if (state === "connected" || state === "completed") {
        console.log("[webrtc] ICE connected successfully! Updating state to connected...");
        try {
          updateCallState("connected");
          setCallStartedAt(Date.now());
          setFastPoll(false);
          if (!callConnectedEventFiredRef.current) {
            callConnectedEventFiredRef.current = true;
            addCallEventMessage?.("call_connected", hasVideoRef.current);
          }
          console.log("[webrtc] State updated to connected");
        } catch (err) {
          console.error("[webrtc] Error updating state:", err);
        }
      } else if (state === "failed") {
        console.log("[webrtc] ICE connection FAILED");
        cleanupConnection();
        updateCallState("idle");
        publishCallSignal(null);
        setFastPoll(false);
      } else if (state === "disconnected") {
        console.log("[webrtc] ICE disconnected - may reconnect...");
      } else if (state === "closed") {
        console.log("[webrtc] ICE connection closed");
        cleanupConnection();
        updateCallState("idle");
        publishCallSignal(null);
        setFastPoll(false);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log("[webrtc] connection state:", state);
      
      if (state === "connected") {
        console.log("[webrtc] peer connection connected! Ensuring state is updated...");
        if (callStateRef.current === "connecting" || callStateRef.current === "answering") {
          try {
            updateCallState("connected");
            setCallStartedAt(Date.now());
            setFastPoll(false);
            if (!callConnectedEventFiredRef.current) {
              callConnectedEventFiredRef.current = true;
              addCallEventMessage?.("call_connected", hasVideoRef.current);
            }
            console.log("[webrtc] State updated to connected via onconnectionstatechange");
          } catch (err) {
            console.error("[webrtc] Error updating state in onconnectionstatechange:", err);
          }
        }
      } else if (state === "failed") {
        console.log("[webrtc] peer connection FAILED");
        cleanupConnection();
        updateCallState("idle");
        publishCallSignal(null);
        setFastPoll(false);
      }
    };

    pc.onsignalingstatechange = () => {
      console.log("[webrtc] signaling state:", pc.signalingState);
    };

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
        console.log("[webrtc] got local stream, tracks:", stream.getTracks().map(t => t.kind));

        const pc = createPeerConnection();
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
        console.log("[webrtc] senders:", pc.getSenders().map(s => s.track?.kind));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log("[webrtc] offer created, waiting for ICE gathering...");
        await waitForIceGathering(pc);

        const sdp = pc.localDescription!.sdp;
        console.log("[webrtc] full offer SDP:\n", sdp);
        const params = extractParamsFromSdp(sdp);
        console.log("[webrtc] extracted params:", params);
        console.log("[webrtc] SSRCs extracted:", params.ss, "media:", params.m);

        const offerTs = Date.now();
        myOfferTimestampRef.current = offerTs;
        
        const signal: CallSignal = {
          t: "o",
          ts: offerTs,
          ...params,
        };

        const signalStr = JSON.stringify(signal);
        console.log("[webrtc] signal size:", signalStr.length, "bytes, offer ts:", offerTs);
        publishCallSignal(signalStr);
      } catch (err) {
        console.error("[webrtc] startCall error:", err);
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
        console.log("[webrtc] accepting call, offer signal:", offer);
        console.log("[webrtc] offer SSRCs:", offer.ss, "media:", offer.m);

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: withVideo,
        });
        localStreamRef.current = stream;
        setLocalStream(stream);
        console.log("[webrtc] got local stream for answer, tracks:", stream.getTracks().map(t => t.kind));

        const pc = createPeerConnection();
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const offerSdp = buildSdpFromSignal(offer, "offer");
        console.log("[webrtc] reconstructed offer SDP:\n", offerSdp);
        
        await pc.setRemoteDescription({
          type: "offer",
          sdp: offerSdp,
        });
        console.log("[webrtc] setRemoteDescription (offer) done");

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log("[webrtc] answer created, waiting for ICE gathering...");
        await waitForIceGathering(pc);

        const sdp = pc.localDescription!.sdp;
        console.log("[webrtc] full answer SDP:\n", sdp);
        const params = extractParamsFromSdp(sdp);
        console.log("[webrtc] extracted answer params:", params);
        console.log("[webrtc] answer SSRCs:", params.ss, "media:", params.m);

        const signal: CallSignal = {
          t: "a",
          ts: Date.now(),
          ...params,
        };

        const signalStr = JSON.stringify(signal);
        console.log("[webrtc] answer signal size:", signalStr.length, "bytes");
        publishCallSignal(signalStr);
        updateCallState("connecting");
        pendingOfferRef.current = null;
      } catch (err) {
        console.error("[webrtc] acceptCall error:", err);
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
        console.log("[webrtc] handling answer signal:", signal);
        console.log("[webrtc] answer signal SSRCs:", signal.ss, "media:", signal.m);
        
        if (signal.m?.includes("v")) {
          console.log("[webrtc] answer includes video, setting hasVideo to true");
          setHasVideo(true);
        }
        
        const answerSdp = buildSdpFromSignal(signal, "answer");
        console.log("[webrtc] reconstructed answer SDP:\n", answerSdp);
        
        const receivers = pc.getReceivers();
        console.log("[webrtc] receivers before setRemoteDescription:", receivers.length);
        
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
        console.log("[webrtc] setRemoteDescription (answer) done");
        
        const receiversAfter = pc.getReceivers();
        console.log("[webrtc] receivers after setRemoteDescription:", receiversAfter.length, receiversAfter.map(r => r.track?.kind));

        updateCallState("connecting");
      } catch (err) {
        console.error("[webrtc] handleAnswer error:", err);
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
      console.warn("[webrtc] failed to parse incoming signal");
      return;
    }
    
    console.log("[webrtc] incoming signal type:", signal.t, "ts:", signal.ts, "current state:", callStateRef.current, "myOfferTs:", myOfferTimestampRef.current);

    if (signal.ts <= lastProcessedSignalRef.current) {
      console.log("[webrtc] signal already processed (ts:", signal.ts, "<=", lastProcessedSignalRef.current, ")");
      return;
    }

    if (callStateRef.current === "connected") {
      if (signal.t !== "h") {
        console.log("[webrtc] already connected, ignoring non-hangup signal:", signal.t);
        return;
      }
    }

    if (signal.t === "o" && callStateRef.current === "idle") {
      console.log("[webrtc] received OFFER, showing incoming call");
      pendingOfferRef.current = signal;
      lastProcessedSignalRef.current = signal.ts;
      const offerHasVideo = signal.m?.includes("v") ?? false;
      hasVideoRef.current = offerHasVideo;
      callConnectedEventFiredRef.current = false;
      addCallEventMessage?.("call_received", offerHasVideo);
      updateCallState("incoming");
      setFastPoll(true);
    } else if (signal.t === "o" && callStateRef.current === "offering") {
      console.log("[webrtc] received OFFER while offering - ignoring peer's old offer");
    } else if (signal.t === "o" && callStateRef.current === "connecting") {
      console.log("[webrtc] received OFFER while connecting - peer may have old offer cached, ignoring");
    } else if (signal.t === "a" && (callStateRef.current === "offering" || callStateRef.current === "connecting")) {
      if (signal.ts <= myOfferTimestampRef.current) {
        console.log("[webrtc] received ANSWER with old timestamp (", signal.ts, "<=", myOfferTimestampRef.current, "), ignoring stale answer");
      } else {
        console.log("[webrtc] received ANSWER in state", callStateRef.current, "ts:", signal.ts, "> offer ts:", myOfferTimestampRef.current);
        lastProcessedSignalRef.current = signal.ts;
        if (callStateRef.current === "offering") {
          handleAnswer(signal);
        } else {
          console.log("[webrtc] already connecting, ignoring duplicate answer");
        }
      }
    } else if (signal.t === "a" && callStateRef.current !== "offering") {
      console.log("[webrtc] received ANSWER but not in offering state, ignoring");
    } else if (signal.t === "h") {
      console.log("[webrtc] received HANGUP");
      lastProcessedSignalRef.current = signal.ts;
      if (callStateRef.current !== "idle") {
        hangUp(false);
      }
    } else {
      console.log("[webrtc] unhandled signal type:", signal.t, "in state:", callStateRef.current);
    }
  }, [incomingCallSignal, handleAnswer, hangUp, updateCallState, setFastPoll, addCallEventMessage]);

  useEffect(() => {
    return () => {
      console.log("[webrtc] component unmounting, cleaning up...");
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
