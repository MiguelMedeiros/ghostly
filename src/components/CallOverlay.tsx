import { useEffect, useRef, useState } from "react";
import type { CallState } from "../lib/types";

interface CallOverlayProps {
  callState: CallState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMuted: boolean;
  isVideoOff: boolean;
  hasVideo: boolean;
  callStartedAt: number | null;
  peerName: string;
  onHangUp: () => void;
  onToggleMute: () => void;
  onToggleVideo: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function CallOverlay({
  callState,
  localStream,
  remoteStream,
  isMuted,
  isVideoOff,
  hasVideo,
  callStartedAt,
  peerName,
  onHangUp,
  onToggleMute,
  onToggleVideo,
}: CallOverlayProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (!remoteStream || !remoteVideoRef.current) return;
    
    if (remoteVideoRef.current.srcObject !== remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (!remoteStream || !remoteAudioRef.current) return;
    
    if (remoteAudioRef.current.srcObject !== remoteStream) {
      remoteAudioRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (callState !== "connected" || !callStartedAt) {
      setDuration(0);
      return;
    }
    const interval = setInterval(() => {
      setDuration(Math.floor((Date.now() - callStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [callState, callStartedAt]);

  const statusText = {
    offering: "Calling...",
    answering: "Connecting...",
    connecting: "Connecting...",
    connected: formatDuration(duration),
    idle: "",
    incoming: "",
    ended: "Call ended",
  }[callState];

  const showRemoteVideo = hasVideo && remoteStream && callState === "connected";
  
  return (
    <div className="fixed inset-0 z-50 bg-chat-bg/95 flex flex-col items-center justify-center">
      {/* Remote audio (always present for audio playback) */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      
      {/* Remote video (always rendered, visibility controlled) */}
      <video
        ref={remoteVideoRef}
        autoPlay
        playsInline
        className={`absolute inset-0 w-full h-full object-cover ${showRemoteVideo ? "" : "hidden"}`}
      />
      
      {/* Placeholder when no remote video */}
      {!showRemoteVideo && (
        <div className="flex flex-col items-center gap-4">
          <div className="w-24 h-24 rounded-full bg-surface-hover flex items-center justify-center">
            <span className="text-text-muted text-3xl">
              {peerName.charAt(0).toUpperCase()}
            </span>
          </div>
          <p className="text-text-primary text-lg font-medium">{peerName}</p>
        </div>
      )}

      {/* Status */}
      <div className="absolute top-8 left-0 right-0 text-center z-10">
        <p className="text-text-muted text-sm">
          {!hasVideo && callState === "connected" && (
            <span className="text-accent">Audio call</span>
          )}
          {statusText && (
            <span className={callState === "connected" ? "ml-2" : ""}>
              {statusText}
            </span>
          )}
        </p>
      </div>

      {/* Local video (picture-in-picture) */}
      {hasVideo && localStream && (
        <div className="absolute top-4 right-4 w-36 h-28 rounded-lg overflow-hidden border border-border/50 shadow-lg z-10">
          {isVideoOff ? (
            <div className="w-full h-full bg-surface-hover flex items-center justify-center">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-text-muted"
              >
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34m-7.72-2.06a4 4 0 1 1-5.56-5.56" />
              </svg>
            </div>
          ) : (
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover mirror"
              style={{ transform: "scaleX(-1)" }}
            />
          )}
        </div>
      )}

      {/* Controls */}
      <div className="absolute bottom-12 left-0 right-0 flex items-center justify-center gap-6 z-10">
        {/* Mute */}
        <button
          onClick={onToggleMute}
          className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
            isMuted
              ? "bg-danger/30 text-danger"
              : "bg-white/10 text-white hover:bg-white/20"
          }`}
          title={isMuted ? "Unmute" : "Mute"}
        >
          {isMuted ? (
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          ) : (
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          )}
        </button>

        {/* Video toggle */}
        {hasVideo && (
          <button
            onClick={onToggleVideo}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
              isVideoOff
                ? "bg-danger/30 text-danger"
                : "bg-white/10 text-white hover:bg-white/20"
            }`}
            title={isVideoOff ? "Turn camera on" : "Turn camera off"}
          >
            {isVideoOff ? (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34m-7.72-2.06a4 4 0 1 1-5.56-5.56" />
              </svg>
            ) : (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M23 7l-7 5 7 5V7z" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            )}
          </button>
        )}

        {/* Hang up */}
        <button
          onClick={onHangUp}
          className="w-16 h-16 rounded-full bg-danger flex items-center justify-center text-white hover:bg-danger/80 transition-colors cursor-pointer"
          title="End call"
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
            <line x1="23" y1="1" x2="1" y2="23" />
          </svg>
        </button>
      </div>
    </div>
  );
}
