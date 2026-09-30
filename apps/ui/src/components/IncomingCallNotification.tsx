import { useEffect, useId, useRef } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useTabTrap } from "../hooks/useDismiss";

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
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const nameId = useId(), kindId = useId();
  // A call over everything: said at once, and the keys stay in it. The focus goes to the box, not to Accept, so an
  // Enter typed into the message a moment later does not answer; it goes back where it was once the ringing stops.
  useTabTrap(box);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus({ preventScroll: true });
    return () => { if (before?.isConnected && (!document.activeElement || document.activeElement === document.body)) before.focus({ preventScroll: true }); };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 max-md:bg-chat-bg backdrop-blur-sm animate-fade-in">
      <div ref={box} role="alertdialog" aria-modal="true" aria-labelledby={nameId} aria-describedby={kindId} tabIndex={-1} data-testid="incoming-call"
        className="incoming-call bg-surface-alt rounded-2xl p-8 shadow-2xl max-w-sm w-full mx-4 text-center space-y-6 focus:outline-none">
        {/* Avatar */}
        <div className="flex flex-col items-center gap-3">
          <div aria-hidden="true" className="w-20 h-20 rounded-full bg-surface-hover flex items-center justify-center animate-pulse-dot">
            <span className="text-text-muted text-2xl">
              {peerName.charAt(0).toUpperCase()}
            </span>
          </div>
          <div>
            <p id={nameId} className="text-text-primary text-lg font-medium">{peerName}</p>
            <p id={kindId} className="text-text-muted text-sm">
              {hasVideo ? t("calls.incomingVideo") : t("calls.incomingAudio")}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-center gap-4 max-md:gap-12">
          {/* Reject */}
          <button
            onClick={onReject}
            className="w-14 h-14 max-md:w-[72px] max-md:h-[72px] rounded-full bg-danger-fill flex items-center justify-center text-white hover:bg-danger-fill/80 transition-colors cursor-pointer"
            title={t("calls.decline")}
            aria-label={t("calls.decline")}
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
            className="w-14 h-14 max-md:w-[72px] max-md:h-[72px] rounded-full bg-accent flex items-center justify-center text-on-accent hover:bg-accent-hover transition-colors cursor-pointer"
            title={t("calls.acceptAudio")} aria-label={t("calls.acceptAudio")}
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
              className="w-14 h-14 max-md:w-[72px] max-md:h-[72px] rounded-full bg-accent flex items-center justify-center text-on-accent hover:bg-accent-hover transition-colors cursor-pointer"
              title={t("calls.acceptVideo")} aria-label={t("calls.acceptVideo")}
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
