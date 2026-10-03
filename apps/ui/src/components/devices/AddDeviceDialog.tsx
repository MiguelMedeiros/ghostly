import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { EnrollView } from "@ghostly/browser/devices/enroll";
import { useI18n } from "../../contexts/I18nContext";
import { useSettings } from "../../contexts/SettingsContext";
import { DEVICE_SET_PASSWORD_MIN, defaultDeviceName, enrollErrorKey, failureKey, lockPasswordProblem } from "../../lib/devices";
import { isDesktopApp } from "../../lib/externalLink";
import { hashPassword, verifyPassword } from "../../lib/settings";
import { errorText } from "../../lib/errorText";
import { QRCodeDisplay } from "../QRCode";
import { Notice } from "../wallet/ui";
import { DeviceDialog, Digits, field, primaryButton, quietButton } from "./DeviceDialog";

/**
 * Add a device, on the active device (WISP 06 § Adding a device). First the lock password: a device set needs one of
 * 8 characters or more, typed again here (or set, or made longer). Then the code, as a QR code and to copy, good for
 * ten minutes; then the digits, which the person compares with the new device's; then the new device is on standby.
 */
export function AddDeviceDialog({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const { settings, updateLockScreen } = useSettings();
  const stored = settings.lockScreen.passwordHash;
  const [password, setPassword] = useState(""), [again, setAgain] = useState("");
  const [step, setStep] = useState<"type" | "set" | "longer" | "enroll">(stored ? "type" : "set");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<EnrollView | null>(null);
  const ended = useRef(true);

  // While an enrollment runs, its state is read twice a second.
  useEffect(() => {
    if (step !== "enroll") return;
    const timer = setInterval(() => void engine.call("deviceEnrollView").then((next) => {
      if (!next) return;
      ended.current = next.step === "done" || next.step === "failed";
      setView(next);
    }, () => {}), 500);
    return () => clearInterval(timer);
  }, [step]);
  // Closed before it ended: the code is spent, and nothing was added.
  useEffect(() => () => { if (!ended.current) void engine.call("deviceEnrollCancel").catch(() => {}); }, []);

  const start = async () => {
    setError(""); setBusy(true);
    try {
      const first = await engine.call("deviceEnrollInvite", { name: defaultDeviceName(isDesktopApp() ? { userAgent: navigator.userAgent, desktop: true } : undefined) });
      ended.current = false;
      setView(first); setStep("enroll");
    } catch (cause) {
      const key = enrollErrorKey(cause);
      setError(key ? t(key) : errorText(cause, t));
    } finally { setBusy(false); }
  };

  const submitPassword = async () => {
    setError("");
    if (step === "type") {
      setBusy(true);
      const valid = !!stored && await verifyPassword(password, stored);
      setBusy(false);
      if (!valid) { setError(t("devices.password.wrong")); return; }
      // The hash keeps no length: only the password typed now says whether it is long enough.
      if (password.length < DEVICE_SET_PASSWORD_MIN) { setPassword(""); setStep("longer"); return; }
      // A password that is stored with the lock off still leaves the profile open: a device set needs the lock on.
      if (!settings.lockScreen.enabled) updateLockScreen({ enabled: true });
      await start();
      return;
    }
    const problem = lockPasswordProblem(password, again, true);
    if (problem) { setError(t(problem === "short" ? "devices.password.tooShort" : "devices.password.mismatch")); return; }
    setBusy(true);
    updateLockScreen({ enabled: true, passwordHash: await hashPassword(password) });
    setBusy(false);
    await start();
  };

  const confirm = async (match: boolean) => {
    try { setView(await engine.call("deviceEnrollConfirm", { match })); } catch (cause) { setError(errorText(cause, t)); }
  };

  const startAgain = () => { setView(null); void start(); };

  if (step !== "enroll") {
    const title = step === "set" ? t("devices.password.setTitle") : step === "longer" ? t("devices.password.longerTitle") : t("devices.password.typeTitle");
    const hint = step === "set" ? t("devices.password.setHint") : step === "longer" ? t("devices.password.longerHint") : null;
    return (
      <DeviceDialog title={title} onClose={onClose} testId="device-add">
        {hint && <p className="text-text-secondary">{hint}</p>}
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submitPassword(); }}>
          <input type="password" autoFocus data-testid="device-add-password" aria-label={step === "type" ? t("devices.password.current") : t("devices.password.new")} placeholder={step === "type" ? t("devices.password.current") : t("devices.password.new")}
            value={password} onChange={(event) => setPassword(event.target.value)} className={field} />
          {step !== "type" && (
            <input type="password" data-testid="device-add-password-again" aria-label={t("devices.password.confirm")} placeholder={t("devices.password.confirm")}
              value={again} onChange={(event) => setAgain(event.target.value)} className={field} />
          )}
          {error && <p role="alert" className="text-danger">{error}</p>}
          <button type="submit" data-testid="device-add-next" disabled={busy || !password} className={primaryButton}>{t("devices.password.next")}</button>
        </form>
      </DeviceDialog>
    );
  }

  return (
    <DeviceDialog title={t("devices.add.title")} onClose={onClose} testId="device-add">
      {view?.role === "inviter" && view.step === "waiting" && <>
        <p className="text-text-secondary">{t("devices.add.codeHint")}</p>
        <div data-testid="device-add-code" data-code={view.code}><QRCodeDisplay value={view.code} qr={[view.code.toUpperCase()]} label={t("devices.add.title")} /></div>
        <p className="text-text-muted text-xs">{t("devices.add.valid")}</p>
      </>}
      {view?.role === "inviter" && view.step === "confirm" && <>
        <p className="text-text-secondary">{t("devices.add.confirm", { device: view.device })}</p>
        <Digits digits={view.digits} testId="device-add-digits" />
        <div className="grid grid-cols-2 gap-3">
          <button type="button" data-testid="device-add-no-match" onClick={() => void confirm(false)} className={quietButton}>{t("devices.add.noMatch")}</button>
          <button type="button" data-testid="device-add-match" onClick={() => void confirm(true)} className={primaryButton}>{t("devices.add.match")}</button>
        </div>
      </>}
      {view?.role === "inviter" && (view.step === "waiting" || view.step === "confirm") && !!view.refused && <Notice tone="warning" testId="device-add-refused">{t("devices.add.refused")}</Notice>}
      {view?.role === "inviter" && view.step === "adding" && <p data-testid="device-add-adding" className="text-text-secondary">{t("devices.add.adding", { device: view.device })}</p>}
      {view?.role === "inviter" && view.step === "done" && <>
        <p data-testid="device-add-done" className="text-text-primary">{t("devices.add.done", { device: view.device })}</p>
        {!view.published && <p className="text-text-muted text-xs">{t("devices.add.notPublished")}</p>}
        <button type="button" onClick={onClose} className={primaryButton}>{t("devices.add.finish")}</button>
      </>}
      {view?.step === "failed" && <>
        <p role="alert" data-testid="device-add-failed" data-reason={view.reason} className="text-danger">{t(failureKey(view.reason))}</p>
        <button type="button" onClick={startAgain} className={primaryButton}>{t("devices.add.tryAgain")}</button>
      </>}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </DeviceDialog>
  );
}
