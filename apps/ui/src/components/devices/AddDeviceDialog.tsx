import { useEffect, useId, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { EnrollView } from "@ghostly/browser/devices/enroll";
import { useI18n } from "../../contexts/I18nContext";
import { useSettings } from "../../contexts/SettingsContext";
import { DEVICE_SET_PASSWORD_MIN, defaultDeviceName, deviceLink, deviceLinkQr, enrollErrorKey, failureKey, lockPasswordProblem, timeLeft } from "../../lib/devices";
import { currentProfile } from "../../lib/profiles";
import { isDesktopApp } from "../../lib/externalLink";
import { appLinkOrigin } from "../../lib/url";
import { hashPassword, verifyPassword } from "../../lib/settings";
import { errorText } from "../../lib/errorText";
import { QRCodeDisplay } from "../QRCode";
import { Notice } from "../wallet/ui";
import { Toast } from "../ui/Toast";
import { useToast } from "../../hooks/useToast";
import { FieldError } from "../ui/FieldError";
import { focusToRetype } from "../../lib/focus";
import { DeviceDialog, Digits, InfoLine, Status, field, primaryButton, quietButton } from "./DeviceDialog";

/**
 * Add a device, on the active device (WISP 06 § Adding a device). First the lock password, in the same dialog: a device
 * set needs one of 8 characters or more, typed again here (or set, or made longer), the reason behind ⓘ. Then the code,
 * as a QR code and a link to copy, good for ten minutes, with where it stands under it as it changes: waiting for the
 * other device (and the time left), a device connecting, "Found <device>. Check the digits" with They match and They
 * don't, then "<device> added". An enrollment that ends says why in one line, with Try again (a new code): never a
 * code left on screen with nobody coming.
 */
export function AddDeviceDialog({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const { settings, updateLockScreen } = useSettings();
  const stored = settings.lockScreen.passwordHash;
  const [password, setPassword] = useState(""), [again, setAgain] = useState("");
  const [step, setStep] = useState<"type" | "set" | "longer" | "enroll">(stored ? "type" : "set");
  // What went wrong, and in which field when it is a field's fault: said under it and in a floating card.
  const [error, setError] = useState<{ field?: "password" | "again"; text: string } | null>(null);
  const notice = useToast();
  const id = useId();
  const passwordInput = useRef<HTMLInputElement>(null), againInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<EnrollView | null>(null);
  const ended = useRef(true);
  /** The password typed before it had to be made longer: what proves the verifier may be replaced. */
  const previous = useRef<string | undefined>(undefined);

  // The time left on the code, a second at a time while it shows.
  const [now, setNow] = useState(() => Date.now());
  const counting = view?.role === "inviter" && view.step === "waiting";
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [counting]);
  /** The profile the code adds the device to, named in its link for the new device's screen. */
  const [profileName] = useState(() => currentProfile().name);

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

  /** Says what went wrong; a refused field gets the focus back with its text selected, to be typed again. */
  const fail = (text: string, field?: "password" | "again") => {
    setError({ field, text });
    notice.show(text);
    if (field) focusToRetype(field === "password" ? passwordInput.current : againInput.current);
  };

  const start = async () => {
    setError(null); setBusy(true);
    try {
      const first = await engine.call("deviceEnrollInvite", { name: defaultDeviceName(isDesktopApp() ? { userAgent: navigator.userAgent, desktop: true } : undefined) });
      ended.current = false;
      setView(first); setStep("enroll");
    } catch (cause) {
      const key = enrollErrorKey(cause);
      fail(key ? t(key) : errorText(cause, t));
    } finally { setBusy(false); }
  };

  const submitPassword = async () => {
    setError(null);
    if (step === "type") {
      setBusy(true);
      const valid = !!stored && await verifyPassword(password, stored);
      setBusy(false);
      if (!valid) { fail(t("devices.password.wrong"), "password"); return; }
      // The hash keeps no length: only the password typed now says whether it is long enough.
      if (password.length < DEVICE_SET_PASSWORD_MIN) { previous.current = password; setPassword(""); setStep("longer"); return; }
      // A password that is stored with the lock off still leaves the profile open: a device set needs the lock on.
      if (!settings.lockScreen.enabled) updateLockScreen({ enabled: true });
      // The verifier a pull is checked against is made now: the app has the password in hand only here (WISP 06 § Adding a device).
      setBusy(true);
      const made = await engine.call("deviceHandoffVerifier", { password, current: password }).then(() => true, () => false);
      setBusy(false);
      if (!made) { fail(t("devices.handoff.verifierFailed")); return; }
      await start();
      return;
    }
    const problem = lockPasswordProblem(password, again, true);
    if (problem) { fail(t(problem === "short" ? "devices.password.tooShort" : "devices.password.mismatch"), problem === "short" ? "password" : "again"); return; }
    setBusy(true);
    updateLockScreen({ enabled: true, passwordHash: await hashPassword(password) });
    const made = await engine.call("deviceHandoffVerifier", { password, current: previous.current }).then(() => true, () => false);
    setBusy(false);
    if (!made) { fail(t("devices.handoff.verifierFailed")); return; }
    await start();
  };

  const confirm = async (match: boolean) => {
    try { setView(await engine.call("deviceEnrollConfirm", { match })); } catch (cause) { fail(errorText(cause, t)); }
  };

  const startAgain = () => { setView(null); void start(); };

  if (step !== "enroll") {
    // One line asks for it; why it is needed is behind ⓘ.
    const ask = step === "set" ? t("devices.password.setTitle") : step === "longer" ? t("devices.password.longerTitle") : t("devices.password.typeTitle");
    const why = step === "set" ? t("devices.password.setHint") : step === "longer" ? t("devices.password.longerHint") : t("devices.password.why");
    const wrong = (which: "password" | "again") => error?.field === which ? error.text : null;
    const invalid = (which: "password" | "again") => wrong(which) ? { "aria-invalid": true, "aria-describedby": `${id}-${which}-error` } : {};
    return (
      <DeviceDialog title={t("devices.add.title")} onClose={onClose} testId="device-add">
        <Toast toast={notice.toast} onDismiss={notice.dismiss} place="dialog" testId="device-add-notice" />
        <InfoLine testId="device-add-password-ask" info={why} className="text-text-primary">{ask}</InfoLine>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submitPassword(); }}>
          <div>
            <input ref={passwordInput} type="password" autoFocus autoComplete={step === "type" ? "current-password" : "new-password"} data-testid="device-add-password" aria-label={step === "type" ? t("devices.password.current") : t("devices.password.new")} placeholder={step === "type" ? t("devices.password.current") : t("devices.password.new")}
              {...invalid("password")} value={password} onChange={(event) => { setPassword(event.target.value); if (error?.field === "password") setError(null); }} className={`${field} aria-invalid:border-danger aria-invalid:focus:ring-danger`} />
            <FieldError id={`${id}-password-error`} testId="device-add-password-error">{wrong("password")}</FieldError>
          </div>
          {step !== "type" && (
            <div>
              <input ref={againInput} type="password" autoComplete="new-password" data-testid="device-add-password-again" aria-label={t("devices.password.confirm")} placeholder={t("devices.password.confirm")}
                {...invalid("again")} value={again} onChange={(event) => { setAgain(event.target.value); if (error?.field === "again") setError(null); }} className={`${field} aria-invalid:border-danger aria-invalid:focus:ring-danger`} />
              <FieldError id={`${id}-again-error`} testId="device-add-password-again-error">{wrong("again")}</FieldError>
            </div>
          )}
          {error && !error.field && <p data-testid="device-add-error" className="text-danger">{error.text}</p>}
          <button type="submit" data-testid="device-add-next" disabled={busy || !password} className={primaryButton}>{t("devices.password.next")}</button>
        </form>
      </DeviceDialog>
    );
  }

  return (
    <DeviceDialog title={t("devices.add.title")} onClose={onClose} testId="device-add">
      <Toast toast={notice.toast} onDismiss={notice.dismiss} place="dialog" testId="device-add-notice" />
      {view?.role === "inviter" && view.step === "waiting" && <>
        <InfoLine info={t("devices.add.scanInfo")}>{t("devices.add.scan")}</InfoLine>
        {/* The code's link on the web app, in the QR code and in Copy and Share: a phone's own camera, or a tap on the
            link sent to it, opens Ghostly with the code, on the one screen that names this profile. Join and "Add this
            device to another profile" read the link too. */}
        <div data-testid="device-add-code" data-code={view.code} data-link={deviceLink(view.code, appLinkOrigin(), profileName)}>
          <QRCodeDisplay value={deviceLink(view.code, appLinkOrigin(), profileName)} qr={deviceLinkQr(view.code, appLinkOrigin(), profileName)} copyLabel={t("devices.add.copy")} />
        </div>
        <Status testId="device-add-status" step={view.seen ? "connecting" : "waiting"}>{view.seen ? t("devices.add.connecting") : t("devices.add.waiting")}</Status>
        <p data-testid="device-add-left" className="text-text-muted text-xs">{t("devices.add.left", { time: timeLeft(view.expires, now) })}</p>
      </>}
      {view?.role === "inviter" && view.step === "confirm" && <>
        <p data-testid="device-add-status" data-step="confirm" className="text-text-primary">{t("devices.add.found", { device: view.device })}</p>
        <Digits digits={view.digits} testId="device-add-digits" />
        <div className="grid grid-cols-2 gap-3">
          <button type="button" data-testid="device-add-no-match" onClick={() => void confirm(false)} className={quietButton}>{t("devices.add.noMatch")}</button>
          <button type="button" data-testid="device-add-match" onClick={() => void confirm(true)} className={primaryButton}>{t("devices.add.match")}</button>
        </div>
      </>}
      {view?.role === "inviter" && (view.step === "waiting" || view.step === "confirm") && !!view.refused && <Notice tone="warning" testId="device-add-refused">{t("devices.add.refused")}</Notice>}
      {view?.role === "inviter" && view.step === "adding" && <Status testId="device-add-adding" step="adding">{t("devices.add.adding", { device: view.device })}</Status>}
      {view?.role === "inviter" && view.step === "done" && <>
        <p data-testid="device-add-done" className="text-text-primary">{t("devices.add.done", { device: view.device })}</p>
        {!view.published && <p className="text-text-muted text-xs">{t("devices.add.notPublished")}</p>}
        <button type="button" onClick={onClose} className={primaryButton}>{t("devices.add.finish")}</button>
      </>}
      {view?.step === "failed" && <>
        <p role="alert" data-testid="device-add-failed" data-reason={view.reason} className="text-danger">{t(failureKey(view.reason))}</p>
        <button type="button" data-testid="device-add-again" onClick={startAgain} className={primaryButton}>{t("devices.add.tryAgain")}</button>
      </>}
      {error && <p data-testid="device-add-error" className="text-danger">{error.text}</p>}
    </DeviceDialog>
  );
}
