import { useEffect, useId, useRef } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useTabTrap } from "../hooks/useDismiss";

interface IncomingCallNotificationProps {
  peerName: string;
  hasVideo: boolean;
  onAcceptAudio: () => void;
  onAcceptVideo: () => void;
  onReject: () => void;
  /**
   * You are on a call in another chat. The choices are then End and answer (that call ends, then this one is answered
   * as it came: with the camera for a video call) and Decline. Never two calls at once (WISP 601, "On a call already").
   */
  onCall?: boolean;
}

const ICON = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const DeclineIcon = () => (
  <svg {...ICON} aria-hidden="true">
    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
    <line x1="23" y1="1" x2="1" y2="23" />
  </svg>
);

export const PhoneIcon = () => (
  <svg {...ICON} aria-hidden="true">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

export const VideoIcon = () => (
  <svg {...ICON} aria-hidden="true">
    <path d="M23 7l-7 5 7 5V7z" />
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
);

const ROUND = "w-14 h-14 max-md:w-[72px] max-md:h-[72px] shrink-0 rounded-full flex items-center justify-center transition-colors cursor-pointer";
/** The round Decline and Accept buttons, shared with the lock screen's ringing card (LockScreen.tsx). */
export const DECLINE = `${ROUND} bg-danger-fill text-white hover:bg-danger-fill/80`;
export const ACCEPT = `${ROUND} bg-accent text-on-accent hover:bg-accent-hover`;

export function IncomingCallNotification({
  peerName,
  hasVideo,
  onAcceptAudio,
  onAcceptVideo,
  onReject,
  onCall = false,
}: IncomingCallNotificationProps) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const nameId = useId(), kindId = useId(), hintId = useId();
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
      <div ref={box} role="alertdialog" aria-modal="true" aria-labelledby={nameId} aria-describedby={onCall ? `${kindId} ${hintId}` : kindId} tabIndex={-1}
        data-testid="incoming-call" data-on-call={onCall || undefined}
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
            {onCall && <p id={hintId} className="text-text-secondary text-sm mt-1">{t("calls.endsCurrent")}</p>}
          </div>
        </div>

        {onCall ? (
          // On a call already: two choices, each named under its button, since no icon says "End and answer".
          <div className="flex items-start justify-center gap-10 max-md:gap-6">
            <div className="flex w-24 flex-col items-center gap-2">
              <button onClick={onReject} className={DECLINE} title={t("calls.decline")} aria-label={t("calls.decline")}>
                <DeclineIcon />
              </button>
              <span aria-hidden="true" className="text-text-secondary text-xs">{t("calls.decline")}</span>
            </div>
            <div className="flex w-24 flex-col items-center gap-2">
              <button onClick={hasVideo ? onAcceptVideo : onAcceptAudio} className={ACCEPT} data-testid="end-and-answer"
                title={t("calls.endAndAnswer")} aria-label={t("calls.endAndAnswer")}>
                {hasVideo ? <VideoIcon /> : <PhoneIcon />}
              </button>
              <span aria-hidden="true" className="text-text-secondary text-xs">{t("calls.endAndAnswer")}</span>
            </div>
          </div>
        ) : (
          // On a phone the gap gives way first (the screen less its 2rem sides and three 72px buttons), so on a
          // 320-375px phone the buttons stay round instead of being squeezed into ovals.
          <div className="flex items-center justify-center gap-4 max-md:gap-[clamp(0.5rem,calc((100vw-4rem-216px)/2),3rem)]">
            <button onClick={onReject} className={DECLINE} title={t("calls.decline")} aria-label={t("calls.decline")}>
              <DeclineIcon />
            </button>
            <button onClick={onAcceptAudio} className={ACCEPT} title={t("calls.acceptAudio")} aria-label={t("calls.acceptAudio")}>
              <PhoneIcon />
            </button>
            {hasVideo && (
              <button onClick={onAcceptVideo} className={ACCEPT} title={t("calls.acceptVideo")} aria-label={t("calls.acceptVideo")}>
                <VideoIcon />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
