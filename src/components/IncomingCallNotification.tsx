interface IncomingCallNotificationProps {
  peerName: string;
  hasVideo: boolean;
  onAcceptAudio: () => void;
  onAcceptVideo: () => void;
  onReject: () => void;
}

export function IncomingCallNotification({
  peerName,
  hasVideo,
  onAcceptAudio,
  onAcceptVideo,
  onReject,
}: IncomingCallNotificationProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-surface-alt rounded-2xl p-8 shadow-2xl max-w-sm w-full mx-4 text-center space-y-6">
        {/* Avatar */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-20 h-20 rounded-full bg-surface-hover flex items-center justify-center animate-pulse-dot">
            <span className="text-text-muted text-2xl">
              {peerName.charAt(0).toUpperCase()}
            </span>
          </div>
          <div>
            <p className="text-text-primary text-lg font-medium">{peerName}</p>
            <p className="text-text-muted text-sm">
              Incoming {hasVideo ? "video" : "audio"} call...
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-center gap-4">
          {/* Reject */}
          <button
            onClick={onReject}
            className="w-14 h-14 rounded-full bg-danger flex items-center justify-center text-white hover:bg-danger/80 transition-colors cursor-pointer"
            title="Decline"
          >
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
              <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
              <line x1="23" y1="1" x2="1" y2="23" />
            </svg>
          </button>

          {/* Accept audio */}
          <button
            onClick={onAcceptAudio}
            className="w-14 h-14 rounded-full bg-accent flex items-center justify-center text-[#111b21] hover:bg-accent-hover transition-colors cursor-pointer"
            title="Accept audio call"
          >
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
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
          </button>

          {/* Accept video */}
          {hasVideo && (
            <button
              onClick={onAcceptVideo}
              className="w-14 h-14 rounded-full bg-accent flex items-center justify-center text-[#111b21] hover:bg-accent-hover transition-colors cursor-pointer"
              title="Accept video call"
            >
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
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
