import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { getBrowserHost } from "@ghostly/browser/host";
import { engine } from "@ghostly/browser/platform/engine";
import type { ProfileOpenFailure } from "@ghostly/browser/shared/idb";
import { useI18n } from "../contexts/I18nContext";
import { useUpdate } from "../contexts/UpdateContext";
import { externalLinkProps } from "../lib/externalLink";
import { activeProfileId, listProfiles, switchProfile } from "../lib/profiles";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const failureNow = () => engine.startFailure;

/**
 * The app, or the notice in its place when the peer did not start because the profile's database did not open
 * (`ProfileOpenFailure`, packages/browser/src/shared/idb.ts). The chat list is drawn from the page's own mirror, so
 * without this an app with no engine looked alive: a list, a composer, and messages that went nowhere.
 */
export function ProfileGate({ children }: { children: ReactNode }) {
  const failure = useSyncExternalStore(subscribe, failureNow);
  return failure ? <ProfileUnavailable failure={failure} /> : <>{children}</>;
}

const BUTTON = "px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-on-accent hover:bg-accent-hover cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed";
const QUIET = "px-3 py-1.5 rounded-lg text-sm text-text-secondary border border-border hover:bg-surface-hover cursor-pointer";

/**
 * Why this profile cannot be opened, and what to do: one short line, the versions and the system's own words behind
 * the ⓘ. Nothing of the profile is on screen with it, so nothing can be typed that would go nowhere. It never offers
 * to delete or reset anything: the data is whole, only this build cannot read it.
 */
export function ProfileUnavailable({ failure }: { failure: ProfileOpenFailure }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  // Every reason but `newer` has its own two lines; `newer` has its own title and hint.
  const other = failure.reason === "newer" ? null : failure.reason;
  const newer = other === null;
  const versions = { app: appVersion(), supported: String(failure.supportedVersion), stored: String(failure.storedVersion ?? `>${failure.supportedVersion}`) };
  const others = otherProfiles();
  return (
    <div role="alert" data-testid="profile-unavailable" data-reason={failure.reason} className="h-dvh overflow-y-auto grid place-items-center bg-chat-bg p-6 text-center">
      <div className="max-w-md space-y-3">
        <div className="text-5xl" aria-hidden="true">👻</div>
        <p className="text-text-primary font-semibold break-words">
          {t(newer ? "app.profileUnavailable.newerTitle" : "app.profileUnavailable.title")}
        </p>
        {other && <p data-testid="profile-unavailable-reason" className="text-text-secondary text-sm break-words">{t(`app.profileUnavailable.reason.${other}`)}</p>}
        <p className="flex items-start justify-center gap-1.5 text-text-secondary text-sm">
          <span className="min-w-0 break-words">{t(other ? `app.profileUnavailable.try.${other}` : "app.profileUnavailable.newerHint")}</span>
          <button type="button" data-testid="profile-unavailable-info" aria-expanded={open} aria-controls={id} aria-label={t("common.moreInfo")} title={t("common.moreInfo")}
            onClick={() => setOpen(!open)}
            className="relative grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-full text-text-muted transition-colors hover:text-accent aria-expanded:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent before:absolute before:-inset-2.5 before:content-['']">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
          </button>
        </p>
        {open && (
          <div id={id} data-testid="profile-unavailable-text" className="rounded-lg bg-surface-hover px-3 py-2 text-start text-xs leading-5 text-text-secondary break-words space-y-1.5">
            <p>{t(newer ? "app.profileUnavailable.newerInfo" : "app.profileUnavailable.info", versions)}</p>
            {!newer && failure.detail && <p>{t("app.profileUnavailable.detail")} <span dir="ltr" lang="en" className="font-mono">{failure.detail}</span></p>}
          </div>
        )}
        {newer ? <UpdateAction /> : (
          <button type="button" data-testid="profile-unavailable-retry" onClick={() => location.reload()} className={BUTTON}>{t("app.profileUnavailable.tryAgain")}</button>
        )}
        {others.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2 pt-2">
            {others.map((profile) => (
              <button key={profile.id} type="button" data-testid="profile-unavailable-switch" onClick={() => switchProfile(profile.id, { route: "/" })} className={QUIET}>
                {t("profileSwitcher.switchTo", { name: profile.name })}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The way to a newer version, where this client has one: look for it, then put it in place (or point at the download). */
function UpdateAction() {
  const { t } = useI18n();
  const { supported, update, stage, progress, error, lastCheckedAt, check, install, downloadUrl } = useUpdate();
  if (!supported) return null;
  if (update) {
    return update.apply === "manual"
      ? <a {...externalLinkProps(downloadUrl)} data-testid="profile-unavailable-update" className={`${BUTTON} inline-block`}>{t("updates.download")}</a>
      : (
        <button type="button" data-testid="profile-unavailable-update" disabled={stage === "installing"} onClick={() => void install()} className={BUTTON}>
          {stage === "installing"
            ? (progress > 0 ? t("updates.downloading", { percent: String(Math.round(progress * 100)) }) : t("updates.installing"))
            : t(update.apply === "restart" ? "updates.restart" : "updates.reload")}
        </button>
      );
  }
  return (
    <div className="space-y-2">
      <button type="button" data-testid="profile-unavailable-check" disabled={stage === "checking"} onClick={() => void check()} className={BUTTON}>
        {t(stage === "checking" ? "updates.checking" : "updates.checkNow")}
      </button>
      {error ? <p className="text-xs text-danger break-words">{error}</p>
        : lastCheckedAt !== null && stage === "idle" && <p data-testid="profile-unavailable-no-update" className="text-xs text-text-muted break-words">{t("app.profileUnavailable.noUpdate")}</p>}
    </div>
  );
}

function appVersion(): string {
  try { return getBrowserHost().version; } catch { return ""; }
}

/** The other profiles of this device: one that cannot be opened must not keep the person out of the rest. */
function otherProfiles(): { id: string; name: string }[] {
  try {
    const current = activeProfileId();
    return listProfiles().filter((profile) => profile.id !== current);
  } catch { return []; }
}
