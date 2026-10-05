import { useState, useEffect, useId, useRef } from "react";
import { useLockScreen, type LockedCall } from "../contexts/LockScreenContext";
import { useI18n } from "../contexts/I18nContext";
import { currentProfile, listProfiles } from "../lib/profiles";
import { ProfileBadge } from "./ProfileBadge";
import { useViewportHeight } from "../hooks/useViewportHeight";
import { PeerAvatar } from "./Avatar";
import { ACCEPT, DECLINE, DeclineIcon, PhoneIcon, VideoIcon } from "./IncomingCallNotification";

const LockIcon = ({ className }: { className: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
  </svg>
);

const Spinner = () => (
  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
    <path className="opacity-75" fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
  </svg>
);

export function LockScreen() {
  const { isLocked, unlock, retryAt, ringing } = useLockScreen();
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  // A call ringing while locked (WISP 601 § Locked): who calls, Decline, and Answer, which asks for the password first.
  const call = isLocked ? ringing?.[0] ?? null : null;
  const [answering, setAnswering] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const waitSeconds = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;

  // Counts the wait down after too many wrong passwords, and stops with it: a locked app left alone runs no timer.
  useEffect(() => {
    if (!retryAt || retryAt <= Date.now()) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= retryAt) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [retryAt]);

  useEffect(() => {
    if (isLocked && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLocked]);

  useEffect(() => {
    if (!isLocked) {
      setPassword("");
      setError(false);
    }
  }, [isLocked]);

  // A call that starts ringing takes the focus to its card, not to Answer: an Enter typed into the password a moment
  // before must not answer. One that stops (hung up, missed, declined) leaves the plain lock screen, its field focused.
  const callId = call?.id;
  const hadCall = useRef(false);
  useEffect(() => {
    setAnswering(false);
    if (callId) {
      hadCall.current = true;
      setError(false);
      cardRef.current?.focus({ preventScroll: true });
    } else if (hadCall.current) {
      hadCall.current = false;
      setError(false);
      inputRef.current?.focus();
    }
  }, [callId]);

  // Answer asks for the password right there, in the same field.
  useEffect(() => {
    if (answering) inputRef.current?.focus();
  }, [answering]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || isUnlocking || waitSeconds > 0) return;

    setIsUnlocking(true);
    setError(false);

    // The call Answer was pressed for. It answers through its chat, so one that ended meanwhile does nothing.
    const answer = answering ? call : null;
    const success = await unlock(password);

    if (success) answer?.answer();
    else {
      setError(true);
      setPassword("");
      inputRef.current?.focus();
    }

    setIsUnlocking(false);
  };

  if (!isLocked) return null;
  // With several profiles, which one this password opens: each has its own lock.
  const profile = listProfiles().length > 1 ? currentProfile() : null;

  return (
    <div
      // Over everything the lock hides, the call window included.
      className="fixed inset-0 z-[60] bg-app-bg"
      role="dialog"
      aria-modal="true"
      aria-label={t("lockScreen.title")}
    >
      <LockViewport />
      {/* Centred in what the keyboard leaves (`--app-height`), not in the whole screen: on a phone the field and
          Unlock sat under the keyboard. */}
      <div className="flex items-center justify-center overflow-y-auto" style={{ height: "var(--app-height, 100%)" }}>
      <div className="w-full max-w-sm mx-4 py-4">
        {call ? (
          <RingingCard call={call} cardRef={cardRef} profile={profile} />
        ) : (
        <div className="text-center mb-8">
          <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-surface flex items-center justify-center">
            <LockIcon className="w-10 h-10 text-accent" />
          </div>
          <h1 className="text-2xl font-semibold text-text-primary mb-2">
            {t("lockScreen.title")}
          </h1>
          <p className="text-text-secondary">{t("lockScreen.enterPassword")}</p>
          {profile && <LockProfile profile={profile} />}
        </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {(!call || answering) && (
          <div>
            {call && <label htmlFor={`${errorId}-field`} className="block mb-2 text-center text-sm text-text-secondary">{t("lockScreen.answerPassword")}</label>}
            <input
              ref={inputRef}
              id={`${errorId}-field`}
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(false);
              }}
              placeholder={t("settings.password")}
              aria-invalid={error || undefined}
              aria-describedby={error || waitSeconds > 0 ? errorId : undefined}
              className={`w-full bg-surface text-text-primary px-4 py-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-accent transition-all ${
                error
                  ? "border-danger animate-shake"
                  : "border-border"
              }`}
              autoComplete="current-password"
            />
          </div>
          )}

          {waitSeconds > 0 ? (
            <p id={errorId} className="text-danger text-sm text-center animate-fade-in" role="alert">
              {t("lockScreen.tooManyAttempts", { seconds: waitSeconds })}
            </p>
          ) : (
            error && (
              <p id={errorId} data-testid="lock-error" className="text-danger text-sm text-center animate-fade-in" role="alert">
                {t("lockScreen.incorrectPassword")}
              </p>
            )
          )}

          {call ? (
            <CallChoices
              call={call}
              answering={answering}
              busy={isUnlocking}
              canAnswer={!!password && !isUnlocking && waitSeconds <= 0}
              onAnswer={() => setAnswering(true)}
            />
          ) : (
          <button
            type="submit"
            disabled={!password || isUnlocking || waitSeconds > 0}
            className="w-full bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-on-accent py-3 px-4 rounded-xl font-medium transition-colors"
          >
            {isUnlocking ? (
              <span className="flex items-center justify-center gap-2">
                <Spinner />
              </span>
            ) : (
              t("lockScreen.unlock")
            )}
          </button>
          )}
        </form>
      </div>
      </div>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
          20%, 40%, 60%, 80% { transform: translateX(4px); }
        }
        .animate-shake {
          animation: shake 0.5s ease-in-out;
        }
      `}</style>
    </div>
  );
}

type ProfileEntry = NonNullable<ReturnType<typeof currentProfile>>;

/** With several profiles, which one this lock is for. */
function LockProfile({ profile }: { profile: ProfileEntry }) {
  return (
    <p data-testid="lock-profile" className="mt-4 inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-sm text-text-primary">
      <ProfileBadge entry={profile} size={22} />
      {profile.name}
    </p>
  );
}

/**
 * Who calls, as their chat shows them (name and picture, the contact face rules), and what kind of call: nothing else
 * of the chat. The app stays locked above it.
 */
function RingingCard({ call, cardRef, profile }: { call: LockedCall; cardRef: React.RefObject<HTMLDivElement | null>; profile: ProfileEntry | null }) {
  const { t } = useI18n();
  const nameId = useId(), kindId = useId();
  return (
    <div className="text-center mb-8">
      <p className="mb-6 inline-flex items-center gap-1.5 text-sm text-text-secondary">
        <LockIcon className="w-4 h-4" />
        {t("lockScreen.title")}
      </p>
      {profile && <div className="-mt-2 mb-6"><LockProfile profile={profile} /></div>}
      <div ref={cardRef} tabIndex={-1} role="alert" aria-labelledby={nameId} aria-describedby={kindId}
        data-testid="lock-call" data-video={call.hasVideo || undefined}
        className="flex flex-col items-center gap-3 rounded-2xl focus:outline-none">
        <div aria-hidden="true" className="relative w-20 h-20 rounded-full bg-surface-hover flex items-center justify-center text-2xl overflow-hidden animate-pulse-dot">
          <PeerAvatar peerPubKey={call.peerPubKey} label={call.name} named={call.named} photo={call.photo} testId="lock-call-avatar" />
        </div>
        <div className="min-w-0 max-w-full">
          <p id={nameId} data-testid="lock-call-name" className="text-text-primary text-lg font-medium truncate">{call.name}</p>
          <p id={kindId} data-testid="lock-call-kind" className="text-text-muted text-sm">
            {call.hasVideo ? t("calls.incomingVideo") : t("calls.incomingAudio")}
          </p>
          {call.onCall && <p className="text-text-secondary text-sm mt-1">{t("calls.endsCurrent")}</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * Decline declines and the app stays locked. Answer shows the password field first; then it is the form's submit, and
 * a right password unlocks and answers at once.
 */
function CallChoices({ call, answering, busy, canAnswer, onAnswer }: {
  call: LockedCall; answering: boolean; busy: boolean; canAnswer: boolean; onAnswer: () => void;
}) {
  const { t } = useI18n();
  const answerLabel = call.onCall ? t("calls.endAndAnswer") : t("lockScreen.answer");
  return (
    <div className="flex items-start justify-center gap-10 max-md:gap-6 pt-2">
      <div className="flex w-24 flex-col items-center gap-2">
        <button type="button" onClick={call.decline} className={DECLINE} data-testid="lock-call-decline"
          title={t("calls.decline")} aria-label={t("calls.decline")}>
          <DeclineIcon />
        </button>
        <span aria-hidden="true" className="text-text-secondary text-xs">{t("calls.decline")}</span>
      </div>
      <div className="flex w-24 flex-col items-center gap-2">
        {/* A plain button until the field is there, so pressing it never submits an empty password. */}
        <button type={answering ? "submit" : "button"} onClick={answering ? undefined : onAnswer}
          disabled={answering && !canAnswer} data-testid="lock-call-answer" data-answering={answering || undefined}
          className={`${ACCEPT} disabled:opacity-50 disabled:cursor-not-allowed`} title={answerLabel} aria-label={answerLabel}>
          {busy ? <Spinner /> : call.hasVideo ? <VideoIcon /> : <PhoneIcon />}
        </button>
        <span aria-hidden="true" className="text-text-secondary text-xs">{answerLabel}</span>
      </div>
    </div>
  );
}

/**
 * The visible height and whether a keyboard is up (`useViewportHeight`), kept while the lock is shown: at start, the
 * app that keeps them is not there until the password has been entered.
 */
function LockViewport() {
  useViewportHeight();
  return null;
}
