import { useI18n } from "../contexts/I18nContext";

interface CallButtonsProps {
  /** Why calls cannot start in this chat right now (the title of both buttons), or null when they can. */
  blocked: string | null;
  /** A call is already ringing or running. */
  busy: boolean;
  onCall: (withVideo: boolean) => void;
  /** A phone's header: the voice call alone, as large as ⋮ beside it; the video call is a row of the ⋮ menu. */
  phone?: boolean;
}

/**
 * The chat header's call buttons: a voice call and a video call. There is no button for the screen here: it is
 * shared from inside a call, voice or video (CallOverlay).
 */
export function CallButtons({ blocked, busy, onCall, phone }: CallButtonsProps) {
  const { t } = useI18n();
  // `aria-disabled` during a call, not `disabled`: a disabled button gives up the keyboard focus, and the call that
  // ends has nowhere to give it back.
  const off = "aria-disabled:opacity-30 aria-disabled:cursor-not-allowed aria-disabled:hover:text-text-secondary aria-disabled:hover:bg-transparent";
  return (
    <>
      {/* Audio call button */}
      <button
        onClick={() => { if (!busy) onCall(false); }}
        disabled={!!blocked}
        aria-disabled={busy || undefined}
        className={`${phone ? "w-11 h-11 flex items-center justify-center" : "p-2 max-md:px-2 max-md:py-2.5"} text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${off}`}
        title={blocked ?? t("calls.audio")}
        aria-label={t("calls.audio")}
        data-testid="call-audio"
      >
        <svg
          width={phone ? 20 : 18}
          height={phone ? 20 : 18}
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
      {/* Video call button */}
      {!phone && <button
        onClick={() => { if (!busy) onCall(true); }}
        disabled={!!blocked}
        aria-disabled={busy || undefined}
        className={`p-2 max-md:px-2 max-md:py-2.5 text-text-secondary hover:text-accent rounded-full hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${off}`}
        title={blocked ?? t("calls.video")}
        aria-label={t("calls.video")}
        data-testid="call-video"
      >
        <svg
          width="18"
          height="18"
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
      </button>}
    </>
  );
}
