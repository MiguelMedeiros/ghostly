import { useEffect, useId, useState, type ReactNode } from "react";
import type { DeviceGateView } from "@ghostly/browser/devices/gate";
import { getBrowserHost } from "@ghostly/browser/host";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../contexts/I18nContext";
import { listNames, reenrollHere, reloadIntoGate, useDeviceSet } from "../lib/devices";
import { HandoffOffer, HandoffProgress, UseHereDialog } from "./devices/Handoff";
import { TakeoverDialog } from "./devices/TakeoverDialog";
import { DeviceGlyph } from "./devices/DeviceGlyph";
import { SCREEN_BUTTON, SCREEN_QUIET } from "./devices/DeviceDialog";
import { InfoButton } from "./layout/Section";
import { useHandoffView } from "../lib/handoff";
import { activeProfileId, listProfiles, switchProfile } from "../lib/profiles";
import { deviceWakeWords, useStandbyPush } from "../lib/wakePush";
import { useComputerAwake } from "../lib/keepAwake";

const LINK = "min-h-11 px-2 text-sm text-text-muted underline underline-offset-2 hover:text-accent cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded";
/** A part of the screen with more than a line in it: an offer, the progress of a move, the new device list. */
const PANEL = "rounded-xl border border-border bg-surface p-4 text-start text-sm";

/**
 * The standby screen (WISP 06 § User experience, "What a standby shows"): the state this device is in for the profile
 * in a title and one hint, why behind the ⓘ, then what can be done here (Use here, an offer from the active device, the
 * progress of a move, a takeover), the person's other devices and their links, and the other profiles of this device,
 * one click away. Nothing of the profile itself is on it.
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
  // Out of its set for good (WISP 06 § Removing a device): nothing it can accept brings it back, or it was removed.
  const reenroll = !!gate.reenroll && (gate.state === "moving" || gate.state === "removed");
  const title = unfinished ? t("devices.standby.unfinished.title")
    : reenroll ? t("devices.standby.reenroll.title")
    : restored ? (gate.activeDevice ? t("devices.restore.activeOn", { device: gate.activeDevice }) : t("devices.restore.activeOnUnnamed"))
    : gate.state === "standby"
      ? (gate.activeDevice ? t("devices.standby.title.standby", { device: gate.activeDevice }) : t("devices.standby.title.standbyUnnamed"))
      : t(`devices.standby.title.${gate.state}`);
  const hint = unfinished
    ? (gate.activeDevice ? t("devices.standby.unfinished.hint", { device: gate.activeDevice }) : t("devices.standby.unfinished.hintUnnamed"))
    : restored ? t("devices.takeover.restoredHint")
    : reenroll ? t("devices.standby.reenroll.hint")
    : gate.state === "moving" && gate.activeDevice ? t("devices.standby.hint.movingOn", { device: gate.activeDevice })
    : gate.state === "removed" && gate.activeDevice ? t("devices.standby.hint.removedFrom", { device: gate.activeDevice })
    : gate.state === "superseded" && gate.activeDevice ? t("devices.standby.hint.supersededBy", { device: gate.activeDevice })
    : t(`devices.standby.hint.${gate.state}`);
  // A handoff froze this device or installed what it took: the pages start again into the gate.
  useEffect(() => { if (gate.reload) void reloadIntoGate(); }, [gate.reload]);
  // The screen back in front is a screen opened again (WISP 06 § When a device checks): the turn is read once more.
  useTurnReadOnReturn(gate.state !== "unreadable");
  // What this device's push worker shows while it is not the active one, and its subscription kept (WISP 06 § Push and the phone).
  useStandbyPush({ title: "Ghostly", body: t("pwa.wakeNotice"), call: t("pwa.wakeCall"), ...deviceWakeWords(t) }, gate.state !== "unreadable" && gate.state !== "removed");
  // Desktop: a handoff that runs here (this device takes the profile, or gives it in pass 2) keeps the computer awake.
  useComputerAwake();
  return (
    <div role="status" data-testid="device-standby" data-state={gate.state} data-unfinished={unfinished ? "true" : undefined} className="h-dvh w-full min-w-0 flex-1 overflow-y-auto bg-chat-bg">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-5 px-4 py-8 text-center">
        <div className="space-y-2">
          <div className="text-5xl" aria-hidden="true">👻</div>
          <h1 data-testid="device-standby-title" className="text-lg font-semibold text-text-primary break-words">{title}</h1>
          <p className="flex items-start justify-center gap-1.5 text-sm text-text-secondary">
            <span className="min-w-0 break-words">{hint}</span>
            <InfoButton open={open} onToggle={() => setOpen(!open)} controls={id} testId="device-standby-info" className="mt-px" />
          </p>
          {open && (
            <div id={id} data-testid="device-standby-text" className="rounded-lg bg-surface-hover px-3 py-2 text-start text-xs leading-5 text-text-secondary break-words space-y-1.5">
              <p>{t(gate.state === "unreadable" ? "devices.standby.unreadableInfo" : "devices.standby.info")}</p>
              {gate.detail && <p>{t("app.profileUnavailable.detail")} <span dir="ltr" lang="en" className="font-mono">{gate.detail}</span></p>}
            </div>
          )}
        </div>
        {gate.state === "unreadable" && (
          <Actions><button type="button" data-testid="device-standby-retry" onClick={() => void tryAgain()} className={SCREEN_BUTTON}>{t("app.profileUnavailable.tryAgain")}</button></Actions>
        )}
        {unfinished && <Unfinished />}
        {gate.state === "standby" && gate.notice && <SetNotice names={gate.notice} />}
        {(reenroll || gate.state === "removed") && (
          <Actions><button type="button" data-testid="device-standby-reenroll" onClick={() => reenrollHere()} className={SCREEN_BUTTON}>{t("devices.join.addThis")}</button></Actions>
        )}
        {!unfinished && !restored && (gate.state === "standby" || gate.state === "releasing" || gate.state === "taking") && <StandbyHandoff gate={gate} />}
        {!unfinished && takeover?.offered && <Takeover gate={gate} info={takeover} />}
        {gate.state !== "unreadable" && gate.state !== "removed" && !unfinished && <Links />}
        {others.length > 0 && (
          <nav aria-label={t("devices.standby.others")} className="space-y-2 border-t border-border pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("devices.standby.others")}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {others.map((profile) => (
                <button key={profile.id} type="button" data-testid="device-standby-switch" onClick={() => switchProfile(profile.id, { route: "/" })} className={SCREEN_QUIET}>
                  {t("profileSwitcher.switchTo", { name: profile.name })}
                </button>
              ))}
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}

/** A row of the screen's buttons: one under the other on a phone, side by side above. */
function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-stretch justify-center gap-2 sm:flex-row sm:flex-wrap sm:items-center">{children}</div>;
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
  // Not while the new device list waits for an answer: "If this list looks wrong, do not use this device".
  const useHere = gate.state === "standby" && !gate.notice && !running && view?.step !== "offer";
  return (
    <div className="space-y-3" data-testid="handoff-standby">
      {view?.step === "offer" && <div className={PANEL}><HandoffOffer view={view} /></div>}
      {view && view.step !== "offer" && <div className={PANEL}><HandoffProgress view={view} onCancel={() => void engine.call("deviceHandoffCancel")} /></div>}
      {!view && gate.state === "taking" && <p data-testid="handoff-line" className="text-sm text-text-secondary">{t("devices.handoff.step.settling")}</p>}
      {useHere && <Actions><button type="button" data-testid="handoff-use-here" onClick={() => setAsking(true)} className={SCREEN_BUTTON}>{t("devices.handoff.useHere")}</button></Actions>}
      {asking && <UseHereDialog device={device} onClose={() => setAsking(false)} onStarted={() => {}} />}
    </div>
  );
}

/** How often coming back to the front may read the turn: the relays' budget is shared with everything else. */
const RETURN_READ_EVERY_MS = 30_000;

function useTurnReadOnReturn(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    let last = Date.now();
    const back = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < RETURN_READ_EVERY_MS) return;
      last = Date.now();
      void engine.call("deviceTurnCheck").catch(() => {});
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => { document.removeEventListener("visibilitychange", back); window.removeEventListener("focus", back); };
  }, [on]);
}

type TakeoverInfo = { offered: boolean; device?: string; copy?: "frozen" | "restored"; password?: boolean; ownSet?: true };

/**
 * Whether this device offers a forced takeover, and how (`deviceTakeoverInfo`): read once the screen shows. On a
 * `moving` device it is a device set of its own, for when the device that removed another is gone for good.
 */
function useTakeoverInfo(state: DeviceGateView["state"]): TakeoverInfo | null {
  const [info, setInfo] = useState<TakeoverInfo | null>(null);
  useEffect(() => {
    if (state !== "standby" && state !== "superseded" && state !== "moving") { setInfo(null); return; }
    let live = true;
    void engine.call("deviceTakeoverInfo").then((next) => { if (live) setInfo(next); }, () => { if (live) setInfo(null); });
    return () => { live = false; };
  }, [state]);
  return info;
}

/**
 * The forced takeover (WISP 06 § Forced takeover): "It wasn't me" on a device that was replaced, "Take over" on a copy
 * restored from a backup, and "My other device is lost or broken", a link under the main action, on a standby that
 * holds a frozen copy.
 */
function Takeover({ gate, info }: { gate: DeviceGateView; info: TakeoverInfo }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const restored = info.copy === "restored";
  return (
    <div className="flex flex-col items-center gap-2">
      {gate.state === "superseded" || restored
        ? <Actions><button type="button" data-testid="takeover-open" onClick={() => setOpen(true)} className={gate.state === "superseded" ? SCREEN_QUIET : SCREEN_BUTTON}>{t(restored ? "devices.restore.takeOver" : "devices.takeover.notMe")}</button></Actions>
        : <button type="button" data-testid="takeover-open" onClick={() => setOpen(true)} className={LINK}>{t("devices.takeover.lost")}</button>}
      {open && <TakeoverDialog device={info.device ?? gate.activeDevice} password={!!info.password} restored={restored} ownSet={!!info.ownSet} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * After this device took a new device secret (WISP 06 § Removing a device), once: the new device list. "This is wrong"
 * keeps the device out of that set, and it is added again by enrollment.
 */
function SetNotice({ names }: { names: string[] }) {
  const { t, language } = useI18n();
  const [busy, setBusy] = useState(false);
  const answer = (wrong: boolean) => { setBusy(true); void engine.call("deviceSetNoticeSeen", { wrong }).finally(() => setBusy(false)); };
  return (
    <div className={`${PANEL} space-y-3`} data-testid="device-set-notice">
      <p data-testid="device-set-notice-title" className="font-semibold text-text-primary break-words">{t("devices.standby.notice.title", { devices: listNames(names, language) })}</p>
      <p className="text-text-secondary">{t("devices.standby.notice.hint")}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button type="button" data-testid="device-set-notice-wrong" disabled={busy} onClick={() => answer(true)} className={`${SCREEN_QUIET} sm:order-1`}>{t("devices.standby.notice.wrong")}</button>
        <button type="button" data-testid="device-set-notice-ok" disabled={busy} onClick={() => answer(false)} className={`${SCREEN_BUTTON} max-sm:order-first sm:order-2`}>{t("devices.standby.notice.ok")}</button>
      </div>
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
    <Actions>
      <button type="button" data-testid="device-standby-finish" disabled={busy} onClick={() => act(async () => { if (!(await engine.call("deviceEnrollFinish")).finished) throw new Error("not yet"); })} className={SCREEN_BUTTON}>{t("devices.standby.unfinished.retry")}</button>
      <button type="button" data-testid="device-standby-remove" disabled={busy} onClick={() => act(() => engine.call("deviceEnrollRemove"))} className={SCREEN_QUIET}>{t("devices.standby.unfinished.remove")}</button>
    </Actions>
  );
}

/** The person's other devices as this standby sees them: each one's link, connected or not, and a check that it answers. */
function Links() {
  const { t } = useI18n();
  const view = useDeviceSet();
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const others = view?.devices.filter((device) => !device.self) ?? [];
  if (!others.length) return null;
  const check = async (key: string) => {
    setAnswer((was) => ({ ...was, [key]: t("devices.section.checking") }));
    try { const { ms } = await engine.call("devicePing", { key }); setAnswer((was) => ({ ...was, [key]: t("devices.section.answered", { ms: Math.max(1, Math.round(ms)) }) })); }
    catch { setAnswer((was) => ({ ...was, [key]: t("devices.section.noAnswer") })); }
  };
  return (
    <section aria-label={t("devices.standby.links")} className="space-y-2 text-start">
      <p className="text-center text-xs font-semibold uppercase tracking-wide text-text-muted">{t("devices.standby.links")}</p>
      <ul className="divide-y divide-border rounded-xl bg-surface text-sm" data-testid="device-standby-links">
        {others.map((device) => {
          const live = device.status === "live";
          return (
            <li key={device.key} data-testid="device-standby-link" data-status={device.status ?? "none"} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <DeviceGlyph name={device.name} active={device.active} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-text-primary">{device.name}</p>
                <p className="text-xs text-text-muted">
                  {device.active ? `${t("devices.section.active")} · ` : ""}
                  <span className="inline-flex items-center gap-1">
                    <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${live ? "bg-accent" : "bg-text-muted"}`} />
                    {live ? t("devices.section.live") : t("devices.section.connecting")}
                  </span>
                  {answer[device.key] && <span data-testid="device-standby-check-result" role="status" className="block">{answer[device.key]}</span>}
                </p>
              </div>
              {live && <button type="button" data-testid="device-standby-check" onClick={() => void check(device.key)} className="min-h-10 rounded-lg border border-border px-3 text-xs text-text-secondary hover:bg-surface-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{t("devices.section.check")}</button>}
            </li>
          );
        })}
      </ul>
    </section>
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
