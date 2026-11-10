import { useI18n } from "../contexts/I18nContext";
import { openAppSettings } from "../desktop/androidCameraRefusal";
import { mediaDeniedText } from "../lib/mediaDevices";
import { mediaDeniedOnAndroid } from "../desktop/androidMediaDenied";

/** Why a call did not start or could not use the microphone or camera (`useWebRTC`'s `mediaProblem`): its title and next step. */
const MEDIA_PROBLEM_TEXT = {
  denied: ["calls.mediaDenied", "calls.mediaDeniedNext"],
  unavailable: ["calls.mediaUnavailable", "calls.mediaUnavailableNext"],
  relay: ["calls.relayNoAnswer", "calls.relayNoAnswerNext"],
  relayOnly: ["calls.relayOnlyOff", "calls.relayOnlyOffNext"],
  relayOnlyNow: ["calls.relayOnlyNow", "calls.relayOnlyNowNext"],
} as const;
type MediaProblem = keyof typeof MEDIA_PROBLEM_TEXT;

/**
 * A call could not use the microphone or camera (refused, or none there), or "Hide my IP from contacts" kept it from
 * starting (the TURN server did not answer, or this app's calls cannot keep to it): it says why, and how to fix it.
 * Refused in the Android app, it says Android's settings, not a browser's, and opens the app's page there: once Android
 * no longer asks, only its settings allow them again.
 */
export function CallMediaProblem({ problem }: { problem: MediaProblem }) {
  const { t } = useI18n();
  const android = problem === "denied" && mediaDeniedOnAndroid();
  const next = android ? "calls.mediaDeniedAndroid"
    : problem === "denied" && mediaDeniedText() === "settings.media.deniedIos" ? "settings.media.deniedIos" : MEDIA_PROBLEM_TEXT[problem][1];
  return (
    <div role="alert" data-testid="call-media-problem" data-problem={problem}
      className="top-notice rounded-lg border border-border bg-panel-header px-4 py-2 text-center text-sm text-text-primary shadow-xl">
      <span className="block font-medium">{t(MEDIA_PROBLEM_TEXT[problem][0])}</span>
      <span className="block text-text-secondary">{t(next)}</span>
      {android && (
        <button type="button" data-testid="call-media-problem-settings" onClick={() => void openAppSettings()}
          className="relative mt-1 cursor-pointer rounded text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent before:absolute before:-inset-y-3 before:-inset-x-2 before:content-['']">
          {t("settings.noticesOpenSettings")}
        </button>
      )}
    </div>
  );
}
