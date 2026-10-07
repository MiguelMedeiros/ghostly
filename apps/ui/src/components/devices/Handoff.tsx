import { useEffect, useId, useState } from "react";
import { FAILURES, dayText, handoffErrorKey, handoffErrorWallet, sizeText, useHandoffView, walletNameOf } from "../../lib/handoff";
import { engine } from "@ghostly/browser/platform/engine";
import type { HandoffView } from "@ghostly/browser/devices/handoff";
import { meteredConnection } from "@ghostly/browser/devices/handoffHost";
import { HANDOFF_LATER_BYTES } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { useIsMobile } from "../../hooks/useIsMobile";
import { Switch } from "../wallet/ui";
import { InfoButton } from "../layout/Section";
import { DeviceDialog, field, primaryButton, quietButton } from "./DeviceDialog";
import { type Problem, problemText } from "../../lib/problemText";
import { Notice } from "../ui/Notice";
import { said, nextOf } from "../../lib/notices";

/*
 * The handoff's screens (WISP 06 § User experience, "Handoff progress", "Failures"): Use here with the password on a
 * standby, the offer of a push, the progress on both devices, and what went wrong.
 */

/** The steps a move shows, in order. Each engine step is drawn as one of them. */
const STEPS = ["connecting", "copying", "ready", "rest", "checking", "switching", "settling"] as const;
type Step = (typeof STEPS)[number];
const STEP_OF: Partial<Record<HandoffView["step"], Step>> = {
  connecting: "connecting", authorizing: "connecting", copying: "copying", paused: "copying", ready: "ready", rest: "rest",
  checking: "checking", switching: "switching", settling: "settling", finishing: "settling",
};

/**
 * Where a move stands (WISP 06 § Handoff progress): the steps, the one running now in words (with the bytes and a bar
 * while files are copied), Cancel while nothing has changed yet, and what went wrong when it failed. The settle wait
 * says why it waits behind its ⓘ; on a phone, "Keep Ghostly open".
 */
export function HandoffProgress({ view, onCancel }: { view: HandoffView; onCancel?: () => void }) {
  const { t, language } = useI18n();
  const phone = useIsMobile();
  const [why, setWhy] = useState(false);
  const whyId = useId();
  const device = view.device || t("devices.join.otherDevice");
  const failed = view.step === "failed";
  const done = view.step === "done";
  const percent = view.total > 0 ? Math.min(100, Math.floor((view.bytes / view.total) * 100)) : 0;
  const line = failed ? t(FAILURES[view.failure ?? "failed"], { device, wallet: walletNameOf(view.wallet), date: view.expiresAt !== undefined ? dayText(view.expiresAt, language) : "" })
    // A wake push went to the other device (a phone that suspended the app): the person opens Ghostly there.
    : view.step === "connecting" ? (view.woken ? t("devices.handoff.fail.woken", { device }) : t("devices.handoff.step.connecting", { device }))
      : view.step === "authorizing" ? t("devices.handoff.step.authorizing")
        : view.step === "copying" ? t("devices.handoff.step.copying", { done: sizeText(view.bytes, t), total: sizeText(view.total, t) })
          : view.step === "paused" ? t("devices.handoff.step.paused", { percent })
            : view.step === "ready" ? t("devices.handoff.step.ready")
              : view.step === "rest" ? t("devices.handoff.step.rest")
                : view.step === "checking" ? t("devices.handoff.step.checking")
                  : view.step === "switching" ? (view.role === "giver" ? t("devices.handoff.movingTo", { device }) : t("devices.handoff.step.switching"))
                    : view.step === "settling" ? t("devices.handoff.step.settling")
                      : view.step === "finishing" ? t("devices.handoff.step.finishing")
                        : done ? (view.role === "taker" ? t("devices.handoff.step.done") : t("devices.handoff.step.doneGiver", { device }))
                          : t("devices.handoff.step.connecting", { device });
  const cancellable = !failed && ["connecting", "authorizing", "copying", "paused", "ready", "rest", "checking"].includes(view.step);
  const current = STEP_OF[view.step];
  const at = current ? STEPS.indexOf(current) : done ? STEPS.length : -1;
  const short: Record<Step, string> = {
    connecting: t("devices.handoff.step.connecting", { device }), copying: t("devices.handoff.step.copy"), ready: t("devices.handoff.step.ready"),
    rest: t("devices.handoff.step.rest"), checking: t("devices.handoff.step.checking"), switching: t("devices.handoff.step.switching"), settling: t("devices.handoff.step.settle"),
  };
  return (
    <div data-testid="handoff-progress" data-step={view.step} data-role={view.role} data-failure={view.failure} data-woken={view.woken ? "true" : undefined} className="space-y-3 text-start">
      <p className="font-semibold text-text-primary">{t("devices.handoff.title")}</p>
      {failed || done || !current ? (
        failed ? <Notice testId="handoff-line" tone="error" className="" title={line} next={nextOf(FAILURES[view.failure ?? "failed"], t, { device, wallet: walletNameOf(view.wallet), date: view.expiresAt !== undefined ? dayText(view.expiresAt, language) : "" })} />
          : <p data-testid="handoff-line" role="status" className="text-text-primary">{line}</p>
      ) : (
        <ol className="space-y-1.5" aria-label={t("devices.handoff.title")}>
          {STEPS.map((step, index) => {
            const state = index < at ? "done" : index === at ? "now" : "next";
            return (
              <li key={step} data-handoff-step={step} data-state={state} aria-current={state === "now" ? "step" : undefined} className="flex items-start gap-2.5">
                <span aria-hidden="true" className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold ${state === "done" ? "bg-accent text-on-accent" : state === "now" ? "border-2 border-accent" : "border border-border-bright"}`}>
                  {state === "done" ? "✓" : ""}
                </span>
                {state === "now" ? (
                  <span className="min-w-0 flex-1 space-y-1.5">
                    <span className="flex items-start gap-1.5">
                      <span data-testid="handoff-line" role="status" className="min-w-0 break-words text-text-primary">{line}</span>
                      {step === "settling" && <InfoButton open={why} onToggle={() => setWhy(!why)} controls={whyId} testId="handoff-settle-info" className="mt-px" />}
                    </span>
                    {(view.step === "copying" || view.step === "rest" || view.step === "paused") && view.total > 0 && (
                      <span role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t("devices.handoff.step.copy")} className="block h-1.5 w-full overflow-hidden rounded-full bg-border">
                        <span className="block h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
                      </span>
                    )}
                    {why && step === "settling" && <span id={whyId} data-testid="handoff-settle-text" className="block text-xs text-text-secondary">{t("devices.handoff.step.settlingInfo")}</span>}
                  </span>
                ) : (
                  <span className={`min-w-0 break-words ${state === "done" ? "text-text-secondary" : "text-text-muted"}`}>{short[step]}</span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {view.step === "copying" && view.role === "giver" && <p className="text-xs text-text-muted">{t("devices.handoff.step.keepUsing")}</p>}
      {phone && !failed && !done && view.role === "taker" && <p data-testid="handoff-keep-open" className="text-xs text-text-muted">{t("devices.handoff.keepOpen")}</p>}
      {!!view.later && <p data-testid="handoff-later-note" className="text-xs text-text-muted">{t("devices.handoff.laterNote", { size: sizeText(view.later, t), device })}</p>}
      {view.newer && <p className="text-xs text-text-muted">{t("devices.handoff.newer")}</p>}
      {!failed && view.role === "giver" && (view.stays ?? []).map((stay) => (
        <p key={`${stay.type}:${stay.network}`} data-testid="handoff-stays" className="text-xs text-text-muted">
          {stay.expiresAt !== undefined
            ? t("devices.handoff.staysExpires", { wallet: walletNameOf(stay.type), date: dayText(stay.expiresAt, language) })
            : t("devices.handoff.stays", { wallet: walletNameOf(stay.type) })}
        </p>
      ))}
      {cancellable && onCancel && (
        <div className="space-y-1.5 pt-1">
          <button type="button" data-testid="handoff-cancel" onClick={onCancel} className={quietButton}>{t("devices.handoff.cancel")}</button>
          <p className="text-center text-xs text-text-muted">{t("devices.handoff.cancelHint")}</p>
        </div>
      )}
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
  const [error, setError] = useState<Problem | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try { onStarted(await engine.call("deviceHandoffPull", { password, later: later ? HANDOFF_LATER_BYTES : 0 })); onClose(); }
    catch (cause) { const key = handoffErrorKey(cause); setError(key ? said(key, t, { device, wallet: handoffErrorWallet(cause) ?? "" }) : problemText(cause, t)); }
    finally { setBusy(false); }
  };
  return (
    <DeviceDialog title={t("devices.handoff.useHereTitle")} onClose={onClose} testId="handoff-use-here-dialog">
      <p className="text-text-secondary">{t("devices.handoff.passwordHint", { device })}</p>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <input type="password" autoFocus autoComplete="current-password" data-testid="handoff-password" aria-label={t("devices.password.current")} placeholder={t("devices.password.current")}
          aria-invalid={!!error || undefined} value={password} onChange={(event) => setPassword(event.target.value)} className={field} />
        {metered && <p className="text-xs text-text-muted">{t("devices.handoff.metered")}</p>}
        <label className="flex items-center justify-between gap-3 text-text-secondary">
          <span className="min-w-0">{t("devices.handoff.later")}</span>
          <Switch checked={later} onChange={setLater} label={t("devices.handoff.later")} testId="handoff-later" />
        </label>
        {error && <Notice problem={error} className="" />}
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
    <div data-testid="handoff-offer" className="space-y-3">
      <div className="space-y-1">
        <p className="font-semibold text-text-primary">{t("devices.handoff.offerTitle", { device })}</p>
        <p className="text-sm text-text-secondary">{t("devices.handoff.offerHint", { size: sizeText(view.offer ?? 0, t) })}</p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button type="button" data-testid="handoff-decline" disabled={busy} onClick={() => act(() => engine.call("deviceHandoffCancel"))} className={`${quietButton} max-sm:order-last`}>{t("devices.handoff.notNow")}</button>
        <button type="button" data-testid="handoff-accept" disabled={busy} onClick={() => act(() => engine.call("deviceHandoffAccept", { later: meteredConnection() ? HANDOFF_LATER_BYTES : 0 }))} className={primaryButton}>{t("devices.handoff.useHere")}</button>
      </div>
    </div>
  );
}

/** "Move to <device>" on the active device, and its progress until this device reloads into the gate. */
export function MoveDialog({ device, deviceKey, onClose }: { device: string; deviceKey: string; onClose(): void }) {
  const { t } = useI18n();
  const [error, setError] = useState<Problem | null>(null);
  const [started, setStarted] = useState(false);
  const view = useHandoffView(started);
  useEffect(() => {
    void engine.call("deviceHandoffPush", { key: deviceKey }).then(() => setStarted(true), (cause: unknown) => {
      const key = handoffErrorKey(cause);
      setError(key ? said(key, t, { device, wallet: handoffErrorWallet(cause) ?? "" }) : problemText(cause, t));
    });
  }, [deviceKey, device, t]);
  return (
    <DeviceDialog title={t("devices.handoff.moveTo", { device })} onClose={onClose} testId="handoff-move-dialog">
      {error && <Notice problem={error} testId="handoff-move-error" className="" />}
      {!error && !view && <p role="status" className="text-text-secondary">{t("devices.handoff.waitingOffer", { device })}</p>}
      {view && <HandoffProgress view={view} onCancel={() => void engine.call("deviceHandoffCancel")} />}
      {error && <button type="button" onClick={onClose} className={quietButton}>{t("common.close")}</button>}
    </DeviceDialog>
  );
}
