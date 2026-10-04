import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { getBrowserHost } from "@ghostly/browser/host";
import type { EnrollView } from "@ghostly/browser/devices/enroll";
import { askPersistentStorage, isIosBrowserTab } from "@ghostly/browser/devices/install";
import { useI18n } from "../../contexts/I18nContext";
import { readDeviceInvite } from "@ghostly/core";
import { defaultDeviceName, enrollErrorKey, failureKey, reloadIntoGate } from "../../lib/devices";
import { errorText } from "../../lib/errorText";
import { isDesktopApp } from "../../lib/externalLink";
import { JoinDialog } from "../JoinDialog";
import { Notice } from "../wallet/ui";
import { DeviceDialog, Digits, field, primaryButton, quietButton } from "./DeviceDialog";

/**
 * "I already use Ghostly" on a new device (WISP 06 § User experience): add this device to the profile, or restore a
 * backup. Adding it names the device, reads the code from the active device (scan, paste or an image), shows the
 * digits once the other device proved itself, and ends on the standby screen. On an iPhone or iPad tab it only says to
 * add Ghostly to the Home Screen first. `start: "name"` opens at the name (the person chose to add it already); `code`, a
 * device code a link carried, opens there too and is used in place of the scanner.
 */
export function JoinProfileDialog({ onClose, onRestore, code, start }: { onClose(): void; onRestore(): void; code?: string; start?: "name" }) {
  const { t } = useI18n();
  const tab = isIosBrowserTab();
  // A tab on an iPhone stays on the first step, which says to add Ghostly to the Home Screen: whatever opened it.
  const [step, setStep] = useState<"choose" | "name" | "code" | "enroll">(() => (!tab && (start === "name" || code) ? "name" : "choose"));
  const [name, setName] = useState(() => defaultDeviceName(isDesktopApp() ? { userAgent: navigator.userAgent, desktop: true } : undefined));
  const [view, setView] = useState<EnrollView | null>(null);
  const [kept, setKept] = useState<boolean | null>(null);
  // The code a link carried (WISP 06 § Adding a device): used after the name, in place of the scanner. Refused or
  // used up, it is dropped, and the next try asks for a code.
  const [preset, setPreset] = useState(code);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ended = useRef(true);

  useEffect(() => {
    if (step !== "enroll") return;
    const timer = setInterval(() => void engine.call("deviceEnrollView").then((next) => {
      if (!next) return;
      ended.current = next.step === "done" || next.step === "failed" || next.step === "unfinished";
      setView(next);
    }, () => {}), 500);
    return () => clearInterval(timer);
  }, [step]);
  useEffect(() => () => { if (!ended.current) void engine.call("deviceEnrollCancel").catch(() => {}); }, []);

  const join = async (code: string) => {
    // Asked for now, where the person acted; refused, it is a warning and nothing more.
    setKept(await askPersistentStorage());
    const first = await engine.call("deviceEnrollJoin", { code, name: name.trim(), app: getBrowserHost().version });
    ended.current = false;
    setView(first); setStep("enroll");
  };

  const next = async () => {
    if (!name.trim()) return;
    if (!preset) { setStep("code"); return; }
    setError("");
    const reading = readDeviceInvite(preset);
    if (!reading.ok) { setPreset(undefined); setError(t(failureKey(reading.reason))); return; }
    setBusy(true);
    try { await join(preset); }
    catch (cause) { setPreset(undefined); const key = enrollErrorKey(cause); setError(key ? t(key) : errorText(cause, t)); }
    finally { setBusy(false); }
  };

  if (step === "code") return <JoinDialog onDevice={join} onClose={() => setStep("name")} />;

  const title = step === "choose" ? t("devices.join.already") : t("devices.join.addThis");
  const close = () => { if (view?.step === "done" || view?.step === "unfinished") void reloadIntoGate(); else onClose(); };
  return (
    <DeviceDialog title={title} onClose={close} testId="device-join">
      {step === "choose" && <>
        {tab ? <Notice tone="warning" testId="device-join-home-screen">{t("devices.join.homeScreen")}</Notice>
          : <button type="button" data-testid="device-join-add" onClick={() => setStep("name")} className={primaryButton}>{t("devices.join.addThis")}</button>}
        {tab && <p className="text-text-muted text-xs">{t("devices.join.homeScreenInfo")}</p>}
        <button type="button" data-testid="device-join-restore" onClick={onRestore} className={quietButton}>{t("devices.join.restore")}</button>
      </>}
      {step === "name" && (
        <form className="space-y-3" data-code-given={preset ? "true" : undefined} data-testid="device-join-name-form" onSubmit={(event) => { event.preventDefault(); void next(); }}>
          <label className="block space-y-1">
            <span className="text-text-secondary">{t("devices.join.name")}</span>
            <input autoFocus data-testid="device-join-name" maxLength={16} value={name} onChange={(event) => setName(event.target.value)} className={field} />
          </label>
          <p className="text-text-muted text-xs">{t("devices.join.nameHint")}</p>
          {error && <p role="alert" data-testid="device-join-error" className="text-danger">{error}</p>}
          <button type="submit" data-testid="device-join-next" disabled={!name.trim() || busy} className={primaryButton}>{t("devices.password.next")}</button>
        </form>
      )}
      {step === "enroll" && view?.role === "joiner" && <>
        {view.step === "connecting" && <p data-testid="device-join-connecting" className="text-text-secondary">{t("devices.join.connecting")}</p>}
        {view.step === "confirm" && <>
          <p className="text-text-secondary">{t("devices.join.confirm")}</p>
          <Digits digits={view.digits} testId="device-join-digits" />
          <p className="text-text-muted text-xs">{t("devices.join.confirmOn")}</p>
        </>}
        {view.step === "finishing" && <p className="text-text-secondary">{t("devices.join.finishing")}</p>}
        {(view.step === "done" || view.step === "unfinished") && <>
          <p data-testid="device-join-done" data-step={view.step} className="text-text-primary">{view.step === "done" ? t("devices.join.done") : t("devices.join.unfinished")}</p>
          {kept === false && <Notice tone="warning" testId="device-join-persist">{t("devices.join.persist", { device: view.device || t("devices.join.otherDevice") })}</Notice>}
          <button type="button" data-testid="device-join-continue" onClick={() => void reloadIntoGate()} className={primaryButton}>{t("devices.join.continue")}</button>
        </>}
        {view.step === "failed" && <>
          <p role="alert" data-testid="device-join-failed" data-reason={view.reason} className="text-danger">{t(failureKey(view.reason))}</p>
          <button type="button" onClick={() => { setView(null); setStep("code"); }} className={primaryButton}>{t("devices.add.tryAgain")}</button>
        </>}
      </>}
    </DeviceDialog>
  );
}
