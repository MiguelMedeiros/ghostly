import { useId, useState } from "react";
import type { DeviceGateView } from "@ghostly/browser/devices/gate";
import { useI18n } from "../contexts/I18nContext";
import { activeProfileId, listProfiles, switchProfile } from "../lib/profiles";

const BUTTON = "px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-on-accent hover:bg-accent-hover cursor-pointer";
const QUIET = "px-3 py-1.5 rounded-lg text-sm text-text-secondary border border-border hover:bg-surface-hover cursor-pointer";

/**
 * The standby screen: which state this device is in for the profile, in one short line and a hint, with why behind
 * the ⓘ. Plain on purpose: the buttons that act (Use here, the handoff, the takeover) come with the parts of WISP 06
 * that do those things. The person's other profiles stay one click away.
 */
export function DeviceStandby({ gate }: { gate: DeviceGateView }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const others = otherProfiles();
  const title = gate.state === "standby"
    ? (gate.activeDevice ? t("devices.standby.title.standby", { device: gate.activeDevice }) : t("devices.standby.title.standbyUnnamed"))
    : t(`devices.standby.title.${gate.state}`);
  return (
    <div role="status" data-testid="device-standby" data-state={gate.state} className="h-dvh overflow-y-auto grid place-items-center bg-chat-bg p-6 text-center">
      <div className="max-w-md space-y-3">
        <div className="text-5xl" aria-hidden="true">👻</div>
        <p data-testid="device-standby-title" className="text-text-primary font-semibold break-words">{title}</p>
        <p className="flex items-start justify-center gap-1.5 text-text-secondary text-sm">
          <span className="min-w-0 break-words">{t(`devices.standby.hint.${gate.state}`)}</span>
          <button type="button" data-testid="device-standby-info" aria-expanded={open} aria-controls={id} aria-label={t("common.moreInfo")} title={t("common.moreInfo")}
            onClick={() => setOpen(!open)}
            className="relative grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-full text-text-muted transition-colors hover:text-accent aria-expanded:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent before:absolute before:-inset-2.5 before:content-['']">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
          </button>
        </p>
        {open && (
          <div id={id} data-testid="device-standby-text" className="rounded-lg bg-surface-hover px-3 py-2 text-start text-xs leading-5 text-text-secondary break-words space-y-1.5">
            <p>{t(gate.state === "unreadable" ? "devices.standby.unreadableInfo" : "devices.standby.info")}</p>
            {gate.detail && <p>{t("app.profileUnavailable.detail")} <span dir="ltr" lang="en" className="font-mono">{gate.detail}</span></p>}
          </div>
        )}
        {gate.state === "unreadable" && (
          <button type="button" data-testid="device-standby-retry" onClick={() => location.reload()} className={BUTTON}>{t("app.profileUnavailable.tryAgain")}</button>
        )}
        {others.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2 pt-2">
            {others.map((profile) => (
              <button key={profile.id} type="button" data-testid="device-standby-switch" onClick={() => switchProfile(profile.id, { route: "/" })} className={QUIET}>
                {t("profileSwitcher.switchTo", { name: profile.name })}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The other profiles of this device: one on standby here must not keep the person out of the rest. */
function otherProfiles(): { id: string; name: string }[] {
  try {
    const current = activeProfileId();
    return listProfiles().filter((profile) => profile.id !== current);
  } catch { return []; }
}
