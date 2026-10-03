import { useEffect, useState } from "react";
import { FAILURES, handoffErrorKey, sizeText, useHandoffView } from "../../lib/handoff";
import { engine } from "@ghostly/browser/platform/engine";
import type { HandoffView } from "@ghostly/browser/devices/handoff";
import { meteredConnection } from "@ghostly/browser/devices/handoffHost";
import { HANDOFF_LATER_BYTES } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { errorText } from "../../lib/errorText";
import { Switch } from "../wallet/ui";
import { DeviceDialog, field, primaryButton, quietButton } from "./DeviceDialog";

/*
 * The handoff's screens (WISP 06 § User experience, "Handoff progress", "Failures"), plain until part 10: Use here
 * with the password on a standby, the offer of a push, the progress on both devices, and what went wrong.
 */

/** Where a handoff stands, in one line, a bar and Cancel while nothing has changed yet. */
export function HandoffProgress({ view, onCancel }: { view: HandoffView; onCancel?: () => void }) {
  const { t } = useI18n();
  const device = view.device || t("devices.join.otherDevice");
  const failed = view.step === "failed";
  const percent = view.total > 0 ? Math.min(100, Math.floor((view.bytes / view.total) * 100)) : 0;
  const line = failed ? t(FAILURES[view.failure ?? "failed"], { device })
    : view.step === "connecting" ? t("devices.handoff.step.connecting", { device })
      : view.step === "authorizing" ? t("devices.handoff.step.authorizing")
        : view.step === "copying" ? t("devices.handoff.step.copying", { done: sizeText(view.bytes), total: sizeText(view.total) })
          : view.step === "ready" ? t("devices.handoff.step.ready")
            : view.step === "rest" ? t("devices.handoff.step.rest")
              : view.step === "checking" ? t("devices.handoff.step.checking")
                : view.step === "switching" ? (view.role === "giver" ? t("devices.handoff.movingTo", { device }) : t("devices.handoff.step.switching"))
                  : view.step === "settling" ? t("devices.handoff.step.settling")
                    : view.step === "finishing" ? t("devices.handoff.step.finishing")
                      : view.step === "done" ? (view.role === "taker" ? t("devices.handoff.step.done") : t("devices.handoff.step.doneGiver", { device }))
                        : t("devices.handoff.step.connecting", { device });
  const cancellable = !failed && ["connecting", "authorizing", "copying", "ready", "rest", "checking"].includes(view.step);
  return (
    <div data-testid="handoff-progress" data-step={view.step} data-role={view.role} data-failure={view.failure} className="space-y-2 text-start">
      <p className="font-semibold text-text-primary">{t("devices.handoff.title")}</p>
      <p data-testid="handoff-line" role={failed ? "alert" : undefined} className={failed ? "text-danger" : "text-text-secondary"}>{line}</p>
      {(view.step === "copying" || view.step === "rest") && view.total > 0 && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-border" aria-hidden="true"><div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} /></div>
      )}
      {view.step === "copying" && view.role === "giver" && <p className="text-xs text-text-muted">{t("devices.handoff.step.keepUsing")}</p>}
      {view.step === "settling" && <p className="text-xs text-text-muted">{t("devices.handoff.step.settlingInfo")}</p>}
      {!!view.later && <p data-testid="handoff-later-note" className="text-xs text-text-muted">{t("devices.handoff.laterNote", { size: sizeText(view.later), device })}</p>}
      {view.newer && <p className="text-xs text-text-muted">{t("devices.handoff.newer")}</p>}
      {cancellable && onCancel && <>
        <button type="button" data-testid="handoff-cancel" onClick={onCancel} className={quietButton}>{t("devices.handoff.cancel")}</button>
        <p className="text-xs text-text-muted">{t("devices.handoff.cancelHint")}</p>
      </>}
    </div>
  );
}

/** "Use here" on a standby: the lock password, and on mobile data whether large files come later. */
export function UseHereDialog({ device, onClose, onStarted }: { device: string; onClose(): void; onStarted(view: HandoffView | null): void }) {
  const { t } = useI18n();
  const metered = meteredConnection();
  const [password, setPassword] = useState("");
  const [later, setLater] = useState(metered);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try { onStarted(await engine.call("deviceHandoffPull", { password, later: later ? HANDOFF_LATER_BYTES : 0 })); onClose(); }
    catch (cause) { const key = handoffErrorKey(cause); setError(key ? t(key, { device }) : errorText(cause, t)); }
    finally { setBusy(false); }
  };
  return (
    <DeviceDialog title={t("devices.handoff.useHereTitle")} onClose={onClose} testId="handoff-use-here-dialog">
      <p className="text-text-secondary">{t("devices.handoff.passwordHint", { device })}</p>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <input type="password" autoFocus data-testid="handoff-password" aria-label={t("devices.password.current")} placeholder={t("devices.password.current")}
          value={password} onChange={(event) => setPassword(event.target.value)} className={field} />
        {metered && <p className="text-xs text-text-muted">{t("devices.handoff.metered")}</p>}
        <label className="flex items-center justify-between gap-3 text-text-secondary">
          <span className="min-w-0">{t("devices.handoff.later")}</span>
          <Switch checked={later} onChange={setLater} label={t("devices.handoff.later")} testId="handoff-later" />
        </label>
        {error && <p role="alert" className="text-danger">{error}</p>}
        <button type="submit" data-testid="handoff-start" disabled={busy || !password} className={primaryButton}>{t("devices.handoff.useHere")}</button>
      </form>
    </DeviceDialog>
  );
}

/** A push from the active device: "Move this profile here from <device>?". */
export function HandoffOffer({ view }: { view: HandoffView }) {
  const { t } = useI18n();
  const device = view.device || t("devices.join.otherDevice");
  const [busy, setBusy] = useState(false);
  const act = (work: () => Promise<unknown>) => { setBusy(true); void work().finally(() => setBusy(false)); };
  return (
    <div data-testid="handoff-offer" className="space-y-2">
      <p className="font-semibold text-text-primary">{t("devices.handoff.offerTitle", { device })}</p>
      <p className="text-text-secondary text-sm">{t("devices.handoff.offerHint", { size: sizeText(view.offer ?? 0) })}</p>
      <div className="grid grid-cols-2 gap-3">
        <button type="button" data-testid="handoff-decline" disabled={busy} onClick={() => act(() => engine.call("deviceHandoffCancel"))} className={quietButton}>{t("devices.handoff.notNow")}</button>
        <button type="button" data-testid="handoff-accept" disabled={busy} onClick={() => act(() => engine.call("deviceHandoffAccept", { later: meteredConnection() ? HANDOFF_LATER_BYTES : 0 }))} className={primaryButton}>{t("devices.handoff.useHere")}</button>
      </div>
    </div>
  );
}

/** "Move to <device>" on the active device, and its progress until this device reloads into the gate. */
export function MoveDialog({ device, deviceKey, onClose }: { device: string; deviceKey: string; onClose(): void }) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);
  const view = useHandoffView(started);
  useEffect(() => {
    void engine.call("deviceHandoffPush", { key: deviceKey }).then(() => setStarted(true), (cause: unknown) => {
      const key = handoffErrorKey(cause);
      setError(key ? t(key, { device }) : errorText(cause, t));
    });
  }, [deviceKey, device, t]);
  return (
    <DeviceDialog title={t("devices.handoff.moveTo", { device })} onClose={onClose} testId="handoff-move-dialog">
      {error && <p role="alert" data-testid="handoff-move-error" className="text-danger">{error}</p>}
      {!error && !view && <p className="text-text-secondary">{t("devices.handoff.waitingOffer", { device })}</p>}
      {view && <HandoffProgress view={view} onCancel={() => void engine.call("deviceHandoffCancel")} />}
    </DeviceDialog>
  );
}
