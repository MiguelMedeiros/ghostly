import { useI18n } from "../contexts/I18nContext";
import { openAppSettings } from "../desktop/androidCameraRefusal";
import { dismissStoppedInBackground, useStoppedInBackground } from "../lib/stayConnected";

/**
 * Above the chat list once Android ended the app while "Stay connected in the background" held it (lib/stayConnected):
 * its battery saving stops apps out of sight, so the next step is the app's settings, where Battery → Unrestricted lets
 * it stay. Never on a first run, nor when the person stopped it: only after the system did, and once a run.
 */
export function StoppedInBackgroundBanner() {
  const { t } = useI18n();
  const stopped = useStoppedInBackground();
  if (!stopped) return null;
  return (
    <div role="status" data-testid="stopped-in-background-banner" className="shrink-0 border-b border-border bg-surface px-4 py-2 flex items-start gap-2.5">
      <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-yellow-500" />
      <p className="m-0 min-w-0 flex-1 text-xs text-text-secondary">
        <span className="font-semibold text-text-primary">{t("settings.stayConnectedStopped")}</span>
        <span className="text-text-muted"> · {t("settings.stayConnectedStoppedNext")}</span>
      </p>
      <button type="button" data-testid="stopped-in-background-settings" onClick={() => { dismissStoppedInBackground(); void openAppSettings(); }}
        className="shrink-0 text-xs font-semibold text-accent hover:underline cursor-pointer">
        {t("settings.noticesOpenSettings")}
      </button>
      <button type="button" data-testid="stopped-in-background-dismiss" aria-label={t("common.close")} title={t("common.close")} onClick={dismissStoppedInBackground}
        className="shrink-0 grid place-items-center w-5 h-5 rounded text-text-muted hover:text-text-primary cursor-pointer">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}
