import { useEffect, useId, useState } from "react";
import type { DeviceGateView } from "@ghostly/browser/devices/gate";
import { getBrowserHost } from "@ghostly/browser/host";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../contexts/I18nContext";
import { reloadIntoGate, useDeviceSet } from "../lib/devices";
import { HandoffOffer, HandoffProgress, UseHereDialog } from "./devices/Handoff";
import { TakeoverDialog } from "./devices/TakeoverDialog";
import { useHandoffView } from "../lib/handoff";
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
  const unfinished = gate.state === "standby" && !!gate.unfinished;
  const takeover = useTakeoverInfo(gate.state);
  // A copy restored from a backup where the profile is active elsewhere (WISP 06 § A backup restored where a device set
  // exists): it starts nothing until the person takes over or removes it.
  const restored = gate.state === "standby" && takeover?.copy === "restored";
  const title = unfinished ? t("devices.standby.unfinished.title")
    : restored ? (gate.activeDevice ? t("devices.restore.activeOn", { device: gate.activeDevice }) : t("devices.restore.activeOnUnnamed"))
    : gate.state === "standby"
      ? (gate.activeDevice ? t("devices.standby.title.standby", { device: gate.activeDevice }) : t("devices.standby.title.standbyUnnamed"))
      : t(`devices.standby.title.${gate.state}`);
  const hint = unfinished
    ? (gate.activeDevice ? t("devices.standby.unfinished.hint", { device: gate.activeDevice }) : t("devices.standby.unfinished.hintUnnamed"))
    : restored ? t("devices.takeover.restoredHint")
    : gate.state === "superseded" && gate.activeDevice ? t("devices.standby.hint.supersededBy", { device: gate.activeDevice })
    : t(`devices.standby.hint.${gate.state}`);
  // A handoff froze this device or installed what it took: the pages start again into the gate.
  useEffect(() => { if (gate.reload) void reloadIntoGate(); }, [gate.reload]);
  return (
    <div role="status" data-testid="device-standby" data-state={gate.state} data-unfinished={unfinished ? "true" : undefined} className="h-dvh overflow-y-auto grid place-items-center bg-chat-bg p-6 text-center">
      <div className="max-w-md space-y-3">
        <div className="text-5xl" aria-hidden="true">👻</div>
        <p data-testid="device-standby-title" className="text-text-primary font-semibold break-words">{title}</p>
        <p className="flex items-start justify-center gap-1.5 text-text-secondary text-sm">
          <span className="min-w-0 break-words">{hint}</span>
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
          <button type="button" data-testid="device-standby-retry" onClick={() => void tryAgain()} className={BUTTON}>{t("app.profileUnavailable.tryAgain")}</button>
        )}
        {unfinished && <Unfinished />}
        {!unfinished && !restored && (gate.state === "standby" || gate.state === "releasing" || gate.state === "taking") && <StandbyHandoff gate={gate} />}
        {!unfinished && takeover?.offered && <Takeover gate={gate} info={takeover} />}
        {gate.state !== "unreadable" && !unfinished && <Links />}
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

/**
 * The handoff on a device that is not the active one (WISP 06 § The handoff): Use here and the offer of a push on a
 * standby, the progress of a pull, pass 2 of a device that is moving away, and the settle wait of one that takes over.
 */
function StandbyHandoff({ gate }: { gate: DeviceGateView }) {
  const { t } = useI18n();
  const view = useHandoffView();
  const [asking, setAsking] = useState(false);
  const device = gate.activeDevice ?? t("devices.join.otherDevice");
  const running = !!view && view.step !== "failed" && view.step !== "offer";
  if (!view && gate.state === "releasing") return null;
  return (
    <div className="space-y-3 rounded-xl border border-border p-4 text-sm" data-testid="handoff-standby">
      {view?.step === "offer" && <HandoffOffer view={view} />}
      {view && view.step !== "offer" && <HandoffProgress view={view} onCancel={() => void engine.call("deviceHandoffCancel")} />}
      {!view && gate.state === "taking" && <p data-testid="handoff-line" className="text-text-secondary">{t("devices.handoff.step.settling")}</p>}
      {gate.state === "standby" && !running && view?.step !== "offer" && (
        <button type="button" data-testid="handoff-use-here" onClick={() => setAsking(true)} className={BUTTON}>{t("devices.handoff.useHere")}</button>
      )}
      {asking && <UseHereDialog device={device} onClose={() => setAsking(false)} onStarted={() => {}} />}
    </div>
  );
}

type TakeoverInfo = { offered: boolean; device?: string; copy?: "frozen" | "restored"; password?: boolean };

/** Whether this device offers a forced takeover, and how (`deviceTakeoverInfo`): read once the screen shows. */
function useTakeoverInfo(state: DeviceGateView["state"]): TakeoverInfo | null {
  const [info, setInfo] = useState<TakeoverInfo | null>(null);
  useEffect(() => {
    if (state !== "standby" && state !== "superseded") { setInfo(null); return; }
    let live = true;
    void engine.call("deviceTakeoverInfo").then((next) => { if (live) setInfo(next); }, () => { if (live) setInfo(null); });
    return () => { live = false; };
  }, [state]);
  return info;
}

/**
 * The forced takeover (WISP 06 § Forced takeover): "It wasn't me" on a device that was replaced, "Take over" on a copy
 * restored from a backup, and "My other device is lost or broken" on a standby that holds a frozen copy.
 */
function Takeover({ gate, info }: { gate: DeviceGateView; info: TakeoverInfo }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const restored = info.copy === "restored";
  return (
    <div className="flex flex-col items-center gap-2">
      {gate.state === "superseded" || restored
        ? <button type="button" data-testid="takeover-open" onClick={() => setOpen(true)} className={gate.state === "superseded" ? QUIET : BUTTON}>{t(restored ? "devices.restore.takeOver" : "devices.takeover.notMe")}</button>
        : <button type="button" data-testid="takeover-open" onClick={() => setOpen(true)} className="text-sm text-text-muted underline hover:text-accent cursor-pointer">{t("devices.takeover.lost")}</button>}
      {open && <TakeoverDialog device={info.device ?? gate.activeDevice} password={!!info.password} restored={restored} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * "Not finished" (WISP 06 § Adding a device): the active device never listed this one. Try again looks for its record
 * once more; Remove takes the device set off this device, which then opens the profile it had before, as it was.
 */
function Unfinished() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const act = (work: () => Promise<unknown>) => { setBusy(true); void work().then(() => tryAgain(), () => setBusy(false)); };
  return (
    <div className="flex flex-wrap justify-center gap-2">
      <button type="button" data-testid="device-standby-finish" disabled={busy} onClick={() => act(async () => { if (!(await engine.call("deviceEnrollFinish")).finished) throw new Error("not yet"); })} className={BUTTON}>{t("devices.standby.unfinished.retry")}</button>
      <button type="button" data-testid="device-standby-remove" disabled={busy} onClick={() => act(() => engine.call("deviceEnrollRemove"))} className={QUIET}>{t("devices.standby.unfinished.remove")}</button>
    </div>
  );
}

/** The device links this standby holds: each other device, whether it is connected, and a check that it answers. */
function Links() {
  const { t } = useI18n();
  const view = useDeviceSet();
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const others = view?.devices.filter((device) => !device.self) ?? [];
  if (!others.length) return null;
  const check = async (key: string) => {
    try { const { ms } = await engine.call("devicePing", { key }); setAnswer((was) => ({ ...was, [key]: t("devices.section.answered", { ms: Math.max(1, Math.round(ms)) }) })); }
    catch { setAnswer((was) => ({ ...was, [key]: t("devices.section.noAnswer") })); }
  };
  return (
    <ul className="space-y-1.5 text-sm text-text-secondary" data-testid="device-standby-links">
      {others.map((device) => (
        <li key={device.key} data-testid="device-standby-link" data-status={device.status ?? "none"} className="flex flex-wrap items-center justify-center gap-2">
          <span className="break-words">{t("devices.standby.link", { device: device.name, status: device.status === "live" ? t("devices.section.live") : t("devices.section.connecting") })}</span>
          {device.status === "live" && <button type="button" data-testid="device-standby-check" onClick={() => void check(device.key)} className={QUIET}>{t("devices.section.check")}</button>}
          {answer[device.key] && <span data-testid="device-standby-check-result" className="text-xs text-text-muted">{answer[device.key]}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Reads the state again. Where the peer outlives its pages (the extension's offscreen document), it is started anew
 * first: it keeps what it read when it started, and would tell the reloaded page the same.
 */
async function tryAgain(): Promise<void> {
  try { await getBrowserHost().restartEngine?.(); } catch { /* the reload says what is wrong now */ }
  window.location.reload();
}

/** The other profiles of this device: one on standby here must not keep the person out of the rest. */
function otherProfiles(): { id: string; name: string }[] {
  try {
    const current = activeProfileId();
    return listProfiles().filter((profile) => profile.id !== current);
  } catch { return []; }
}
