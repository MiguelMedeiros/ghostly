import { useCallback, useEffect, useRef, useState } from "react";
import type { CallSignal } from "@ghostly/core";
import { useWebRTC } from "@ghostly/react";
import type { LinkView } from "../shared/types";
import type { Engine } from "./useEngine";

function Video({ stream, muted, className }: { stream: MediaStream | null; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

/**
 * Voice and video calls, the same hook and `_call` signaling Ghostly Desktop
 * uses. The call lives in this page rather than in the background peer because
 * camera and microphone access needs a visible page to ask for permission.
 */
export function CallPanel({ engine, link }: { engine: Engine; link: LinkView }) {
  const { call, onCallSignal } = engine;
  const [incomingCallSignal, setIncomingCallSignal] = useState<string | null>(null);

  useEffect(
    () => onCallSignal((linkId, signal) => linkId === link.id && setIncomingCallSignal(signal)),
    [onCallSignal, link.id],
  );

  const publishCallSignal = useCallback(
    (signal: string | null) => void call("setCallSignal", { linkId: link.id, signal }).catch(() => {}),
    [call, link.id],
  );
  const setFastPoll = useCallback(
    (fast: boolean) => void call("setFastPoll", { linkId: link.id, fast }).catch(() => {}),
    [call, link.id],
  );

  const rtc = useWebRTC({ incomingCallSignal, publishCallSignal, setFastPoll });
  const { callState } = rtc;
  const button = "rounded border border-edge px-3 py-1 text-sm hover:bg-panel";

  if (callState === "idle" || callState === "ended") {
    return (
      <div className="flex gap-2">
        <button data-testid="call-voice" className={button} onClick={() => void rtc.startCall(false)}>
          Voice
        </button>
        <button data-testid="call-video" className={button} onClick={() => void rtc.startCall(true)}>
          Video
        </button>
      </div>
    );
  }

  if (callState === "incoming") {
    let offersVideo = false;
    try {
      offersVideo = (JSON.parse(incomingCallSignal ?? "{}") as CallSignal).m?.includes("v") ?? false;
    } catch {
      // not a call signal
    }
    return (
      <div className="flex items-center gap-2 rounded-lg border border-ghost/40 bg-panel px-3 py-2 text-sm">
        <span className="mr-2">Incoming {offersVideo ? "video" : "voice"} call</span>
        <button className={button} onClick={() => void rtc.acceptCall(false)}>
          Answer
        </button>
        {offersVideo && (
          <button className={button} onClick={() => void rtc.acceptCall(true)}>
            Answer with video
          </button>
        )}
        <button className={`${button} text-red-400`} onClick={rtc.rejectCall}>
          Decline
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink/95">
      <div className="relative h-[60vh] w-[80vw] max-w-4xl overflow-hidden rounded-2xl bg-panel">
        <Video stream={rtc.remoteStream} className="h-full w-full object-contain" />
        {!rtc.hasVideo && <div className="absolute inset-0 grid place-items-center text-6xl">👻</div>}
        {rtc.localStream && rtc.localStream.getVideoTracks().length > 0 && (
          <Video stream={rtc.localStream} muted className="absolute bottom-3 right-3 h-32 rounded-lg border border-edge" />
        )}
      </div>
      <p className="text-sm text-mist" data-testid="call-state">
        {callState === "connected" ? "Connected" : callState === "offering" ? "Ringing…" : "Connecting…"}
      </p>
      <div className="flex gap-2">
        <button className={button} onClick={rtc.toggleMute}>
          {rtc.isMuted ? "Unmute" : "Mute"}
        </button>
        {rtc.localStream && rtc.localStream.getVideoTracks().length > 0 && (
          <button className={button} onClick={rtc.toggleVideo}>
            {rtc.isVideoOff ? "Camera on" : "Camera off"}
          </button>
        )}
        <button data-testid="call-hangup" className={`${button} border-red-400 text-red-400`} onClick={() => rtc.hangUp()}>
          Hang up
        </button>
      </div>
    </div>
  );
}
