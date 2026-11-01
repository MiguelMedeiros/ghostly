import { useId, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { useLockPassedNow } from "../../contexts/LockScreenContext";
import { reloadIntoGate, takeoverErrorKey } from "../../lib/devices";
import { focusToRetype } from "../../lib/focus";
import { InfoButton } from "../layout/Section";
import { DeviceDialog, field, primaryButton } from "./DeviceDialog";
import { type Problem, problemText } from "../../lib/problemText";
import { Notice } from "../ui/Notice";
import { said } from "../../lib/notices";
import { fillNames } from "../../lib/fillNodes";

/**
 * A forced takeover (WISP 06 § Forced takeover): "My other device is lost or broken" on a standby that holds a copy, and
 * "It wasn't me" on a device that was replaced. "Lost or stolen?", the lock password (where this copy is a frozen one)
 * and the name of the device that stops; then about half a minute in which this device checks that no other one took
 * the turn too.
 */
export function TakeoverDialog({ device, password: asks, restored, ownSet, onClose }: { device?: string; password: boolean; restored?: boolean; ownSet?: boolean; onClose(): void }) {
  const { t } = useI18n();
  const lockPassedNow = useLockPassedNow();
  const id = useId();
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const [refused, setRefused] = useState<"password" | "name" | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState(false);
  // "Lost or stolen?" (WISP 06 § Forced takeover): on yes, the money checklist comes first once the profile opens here.
  // A device set of its own (a `moving` device whose remover is gone): the question is not asked, the old set is left whole.
  const [lost, setLost] = useState<boolean | null>(restored || ownSet ? false : null);
  const other = device ?? t("devices.join.otherDevice");
  const ready = (!asks || !!password) && (!device || name.trim().length > 0) && lost !== null;
  const submit = async () => {
    setBusy(true); setError(null); setRefused(null);
    try {
      const outcome = await engine.call("deviceTakeover", { password, name, lost: lost === true });
      // Active now: the app starts again into the gate, where the engine raises its counters and starts. The lock passed
      // in this tab carries, if it did not close during the check.
      if (outcome.kind === "start") { await reloadIntoGate({ keepUnlocked: lockPassedNow() }); return; }
      setError({ tone: "error", title: t(outcome.kind === "removed" ? "devices.takeover.ownSetRemoved" : outcome.kind === "wait" ? "devices.takeover.ownSetWait" : "devices.takeover.lostRace") });
    } catch (cause) {
      const key = takeoverErrorKey(cause);
      setError(key ? said(key, t) : problemText(cause, t));
      // A refused field gets the focus back with its text selected, to be typed again.
      setRefused(key === "devices.password.wrong" ? "password" : key === "devices.takeover.fail.name" ? "name" : null);
      if (key === "devices.password.wrong") focusToRetype(passwordInput.current);
      else if (key === "devices.takeover.fail.name") focusToRetype(nameInput.current);
    } finally { setBusy(false); }
  };
  return (
    <DeviceDialog title={device ? fillNames(t("devices.takeover.title"), { device }) : t("devices.takeover.titleUnnamed")} onClose={onClose} testId="takeover-dialog">
      <div className="space-y-2">
        <p className="flex items-start gap-1.5 text-text-secondary">
          <span className="min-w-0">{restored ? t("devices.takeover.hintRestored") : fillNames(t("devices.takeover.hint"), { device: other })}</span>
          <InfoButton open={info} onToggle={() => setInfo(!info)} controls={`${id}-info`} testId="takeover-info" className="mt-px" />
        </p>
        {info && <p id={`${id}-info`} data-testid="takeover-info-text" className="rounded-lg bg-surface-hover px-3 py-2 text-xs leading-5 text-text-secondary">{fillNames(t("devices.takeover.info"), { device: other })}</p>}
      </div>
      {ownSet && <p data-testid="takeover-own-set" className="text-text-secondary">{t("devices.takeover.ownSetHint")}</p>}
      {!restored && !ownSet && (
        <fieldset className="space-y-2" data-testid="takeover-lost">
          <legend className="mb-2 font-medium text-text-primary">{t("devices.takeover.lostQuestion")}</legend>
          {([[true, "devices.takeover.lostYes", "devices.takeover.lostYesHint", "takeover-lost-yes"], [false, "devices.takeover.lostNo", "devices.takeover.lostNoHint", "takeover-lost-no"]] as const).map(([value, key, hint, testId]) => (
            <label key={testId} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${lost === value ? "border-accent bg-accent/10" : "border-border hover:bg-surface-hover"}`}>
              <input type="radio" name={`${id}-lost`} data-testid={testId} checked={lost === value} onChange={() => setLost(value)} className="mt-0.5 accent-accent" />
              <span className="min-w-0">
                <span className="block text-text-primary">{t(key)}</span>
                <span className="block text-xs text-text-muted">{t(hint)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (ready && !busy) void submit(); }}>
        {asks && <input ref={passwordInput} type="password" autoFocus autoComplete="current-password" data-testid="takeover-password" aria-label={t("devices.password.current")} placeholder={t("devices.password.current")}
          aria-invalid={refused === "password" || undefined} value={password} onChange={(event) => setPassword(event.target.value)} className={field} />}
        {device && (
          <label className="block space-y-1">
            <span className="text-text-secondary">{fillNames(t("devices.takeover.confirm"), { device })}</span>
            <input ref={nameInput} type="text" data-testid="takeover-name" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={device}
              aria-invalid={refused === "name" || undefined} value={name} onChange={(event) => setName(event.target.value)} className={field} />
          </label>
        )}
        {busy && <p role="status" data-testid="takeover-checking" className="text-text-secondary">{t("devices.takeover.checking")}</p>}
        {error && <Notice problem={error} testId="takeover-error" className="" />}
        {/* `aria-disabled`, not `disabled`, while it runs: a disabled button drops the keyboard focus to the page. */}
        <button type="submit" data-testid="takeover-go" disabled={!ready} aria-disabled={busy || undefined} aria-busy={busy || undefined} className={primaryButton}>{t("devices.takeover.go")}</button>
      </form>
    </DeviceDialog>
  );
}
