import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CallState } from "../lib/types";
import { CORNERS, useFloatingBox, type Corner } from "../hooks/useFloatingBox";

interface CallOverlayProps {
  callState: CallState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMuted: boolean;
  /** We are sending no picture at all: an audio call, or a camera turned off. */
  isVideoOff: boolean;
  /** We are sending our screen instead of the camera. */
  isScreenSharing?: boolean;
  /** Offer the camera button: the call has a video lane our side may send on. */
  canSendVideo?: boolean;
  /** The share button works: that lane, in a browser that can capture the screen. */
  canShareScreen?: boolean;
  /** The share button shows, turned off, with this reason: the screen could be captured, but this call cannot carry it. */
  screenShareUnavailable?: string | null;
  /** Why sharing the screen just failed. */
  screenShareError?: string | null;
  /** The peer is sending a picture. */
  remoteHasVideo: boolean;
  /** The peer's picture is its screen. */
  remoteIsScreenSharing?: boolean;
  callStartedAt: number | null;
  peerName: string;
  onHangUp: () => void;
  onToggleMute: () => void;
  onToggleVideo: () => void;
  onToggleScreenShare?: () => void;
  /** The chat is off screen. The call rides along in its small window until you go back to it. */
  pinned?: boolean;
  onReturnToChat?: () => void;
  /** Where to hang the call window, so it does not go off screen with its chat. */
  layer?: HTMLElement | null;
}

const MINI_KEY = "ghostly_call_mini";

/** Corner grips of a floating box; they show when the pointer is over it. */
function Grips({ handleProps }: { handleProps: (corner: Corner) => Record<string, unknown> }) {
  return (
    <>
      {CORNERS.map((corner) => (
        <div key={corner} className={`float-grip float-grip-${corner}`} {...handleProps(corner)} />
      ))}
    </>
  );
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
  isScreenSharing = false,
  canSendVideo = false,
  canShareScreen = false,
  screenShareUnavailable = null,
  screenShareError = null,
  remoteHasVideo,
  remoteIsScreenSharing = false,
  callStartedAt,
  peerName,
  onHangUp,
  onToggleMute,
  onToggleVideo,
  onToggleScreenShare,
  pinned = false,
  onReturnToChat,
  layer,
}: CallOverlayProps) {
  // A shared screen has to be seen whole; a face can be cropped to fill the window.
  const [remoteIsWide, setRemoteIsWide] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState(0);

  // The call can shrink into a floating window, so the chat underneath stays usable.
  // Away from its own chat it has no choice: the small window is all there is.
  const [miniPreference, setMiniState] = useState(() => localStorage.getItem(MINI_KEY) === "1");
  const mini = pinned || miniPreference;
  const setMini = (next: boolean) => {
    setMiniState(next);
    try {
      localStorage.setItem(MINI_KEY, next ? "1" : "0");
    } catch {
      // only a preference
    }
  };
  const phone = window.innerWidth < 768;
  const miniWindow = useFloatingBox(
    "ghostly_call_window_box",
    () => (phone ? { x: window.innerWidth - 206, y: window.innerHeight - 240, w: 190, h: 136 } : { x: window.innerWidth - 364, y: window.innerHeight - 316, w: 340, h: 220 }),
    { enabled: mini, minWidth: 190, minHeight: 128 },
  );

  // Your own picture keeps the shape of what it shows (camera or screen), so there are never bars around it.
  const [selfAspect, setSelfAspect] = useState(4 / 3);
  const selfView = useFloatingBox(
    "ghostly_call_self_view_box",
    () => (phone ? { x: window.innerWidth - 136, y: 64, w: 120, h: 90 } : { x: window.innerWidth - 256, y: 16, w: 240, h: 180 }),
    { enabled: !mini, aspect: selfAspect, minWidth: phone ? 96 : 140 },
  );

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
    // The element is recreated when the camera is turned back on, so it needs its stream again.
  }, [localStream, isVideoOff]);

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

  const showRemoteVideo = remoteHasVideo && remoteStream && callState === "connected";
  // A screen in place of the camera leaves the camera off, and its button says so.
  const cameraOn = !isVideoOff && !isScreenSharing;
  // Sharing is never a surprise, to either side.
  const sharingNotice = callState !== "connected" ? null
    : isScreenSharing && remoteIsScreenSharing ? `You and ${peerName} are sharing your screens`
    : isScreenSharing ? "You're sharing your screen"
    : remoteIsScreenSharing ? `${peerName} is sharing their screen` : null;

  // Hung outside the chat, which may be off screen; the call is not.
  return createPortal(
    <div
      {...miniWindow.boxProps}
      data-testid="call-window"
      data-mini={mini}
      className={
        mini
          ? "call-mini floating fixed z-50 bg-chat-bg flex flex-col items-center justify-center rounded-xl border border-border shadow-2xl"
          : "fixed inset-0 z-50 bg-chat-bg/95 max-md:bg-chat-bg flex flex-col items-center justify-center"
      }
    >
      {mini && <Grips handleProps={miniWindow.handleProps} />}
      {/* Shrink to a floating window, or back to the whole screen */}
      <button
        onClick={() => (pinned ? onReturnToChat?.() : setMini(!mini))}
        className="call-resize absolute top-4 left-4 z-20 w-11 h-11 rounded-full bg-white/10 text-white hover:bg-white/20 flex items-center justify-center cursor-pointer transition-colors"
        title={pinned ? "Back to the chat" : mini ? "Back to full screen" : "Keep the call in a small window"}
        data-testid="call-minimize"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {mini ? <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /> : <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />}
        </svg>
      </button>

      {/* Remote audio (always present for audio playback) */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      
      {/* Remote video (always rendered, visibility controlled) */}
      <video
        ref={remoteVideoRef}
        autoPlay
        playsInline
        data-testid="remote-video"
        onResize={(e) => setRemoteIsWide(e.currentTarget.videoWidth >= 1000)}
        className={`absolute inset-0 w-full h-full bg-black ${remoteIsWide ? "object-contain" : "object-cover"} ${showRemoteVideo ? "" : "hidden"}`}
      />
      
      {/* Placeholder when no remote video */}
      {!showRemoteVideo && (
        <div className="call-peer flex flex-col items-center gap-4">
          <div className="call-avatar w-24 h-24 rounded-full bg-surface-hover flex items-center justify-center">
            <span className="text-text-muted text-3xl">
              {peerName.charAt(0).toUpperCase()}
            </span>
          </div>
          <p className="call-name text-text-primary text-lg font-medium">{peerName}</p>
        </div>
      )}

      {/* Status */}
      <div className="call-top absolute top-8 left-0 right-0 text-center z-10">
        <p className="text-text-muted text-sm">
          {!remoteHasVideo && isVideoOff && callState === "connected" && (
            <span className="text-accent">Audio call</span>
          )}
          {statusText && (
            <span className={callState === "connected" ? "ml-2" : ""}>
              {statusText}
            </span>
          )}
        </p>
      </div>

      {sharingNotice && (
        <p
          role="status"
          data-testid="call-sharing"
          data-self={isScreenSharing}
          data-peer={remoteIsScreenSharing}
          className="call-share-notice absolute top-16 max-md:top-[calc(4rem+env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-10 max-w-[calc(100%-2rem)] flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium bg-accent text-on-accent shadow-lg"
        >
          <svg className="shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="4" width="20" height="13" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
          <span className="truncate">{sharingNotice}</span>
        </p>
      )}

      {/* Local video (picture-in-picture) */}
      {!isVideoOff && localStream && (
        <div
          {...selfView.boxProps}
          onDoubleClick={selfView.reset}
          data-testid="call-self-view"
          title={mini ? undefined : "Drag to move, pull a corner to resize, double-click to reset"}
          className={`call-preview absolute rounded-lg overflow-hidden border border-border/50 shadow-lg z-10 bg-black ${
            mini ? "top-4 right-4 w-36 h-28" : "floating"
          }`}
        >
          {!mini && <Grips handleProps={selfView.handleProps} />}
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            onLoadedMetadata={(e) => e.currentTarget.videoWidth > 0 && setSelfAspect(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
            onResize={(e) => e.currentTarget.videoWidth > 0 && setSelfAspect(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
            className={`w-full h-full object-cover pointer-events-none ${isScreenSharing ? "" : "mirror"}`}
            style={isScreenSharing ? undefined : { transform: "scaleX(-1)" }}
          />
        </div>
      )}

      {screenShareError && (
        <p role="alert" data-testid="share-screen-error"
          className="call-share-error absolute bottom-32 max-md:bottom-[calc(8.5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-10 w-max max-w-[calc(100%-2rem)] rounded-lg bg-black/70 px-3 py-2 text-center text-xs text-white">
          {screenShareError}
        </p>
      )}

      {/* Controls */}
      <div className="call-controls absolute bottom-12 left-0 right-0 flex items-center justify-center gap-6 max-md:gap-8 z-10">
        {/* Mute */}
        <button
          onClick={onToggleMute}
          className={`w-14 h-14 max-md:w-16 max-md:h-16 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
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

        {/* Camera: an audio call can turn into a video one right here. */}
        {canSendVideo && (
          <button
            onClick={onToggleVideo}
            className={`w-14 h-14 max-md:w-16 max-md:h-16 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
              !cameraOn
                ? "bg-danger/30 text-danger"
                : "bg-white/10 text-white hover:bg-white/20"
            }`}
            title={cameraOn ? "Turn camera off" : "Turn camera on"}
          >
            {!cameraOn ? (
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

        {/* Screen share: in any connected call, voice or video. Where no screen can be captured (phones) it is not here at all. */}
        {(canShareScreen || screenShareUnavailable) && onToggleScreenShare && (
          <button
            onClick={onToggleScreenShare}
            disabled={!canShareScreen}
            data-testid="share-screen"
            aria-label={isScreenSharing ? "Stop sharing" : "Share screen"}
            aria-pressed={isScreenSharing}
            className={`w-14 h-14 max-md:w-16 max-md:h-16 rounded-full flex items-center justify-center transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              isScreenSharing ? "bg-accent text-on-accent" : "bg-white/10 text-white enabled:hover:bg-white/20"
            }`}
            title={isScreenSharing ? "Stop sharing" : canShareScreen ? "Share screen" : screenShareUnavailable ?? "Share screen"}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="13" rx="2" />
              <path d="M8 21h8M12 17v4M12 13V8m0 0l-2.5 2.5M12 8l2.5 2.5" />
            </svg>
          </button>
        )}

        {/* Hang up */}
        <button
          onClick={onHangUp}
          className="w-16 h-16 max-md:w-[72px] max-md:h-[72px] rounded-full bg-danger flex items-center justify-center text-white hover:bg-danger/80 transition-colors cursor-pointer"
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
    </div>,
    layer ?? document.body,
  );
}
