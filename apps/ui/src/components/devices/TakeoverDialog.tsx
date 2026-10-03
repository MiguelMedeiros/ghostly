import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { errorText } from "../../lib/errorText";
import { reloadIntoGate, takeoverErrorKey } from "../../lib/devices";
import { DeviceDialog, field, primaryButton } from "./DeviceDialog";

/**
 * A forced takeover (WISP 06 § Forced takeover): "My other device is lost or broken" on a standby that holds a copy, and
 * "It wasn't me" on a device that was replaced. The lock password (where this copy is a frozen one) and the name of the
 * device that stops; then about half a minute in which this device checks that no other one took the turn too.
 */
export function TakeoverDialog({ device, password: asks, restored, ownSet, onClose }: { device?: string; password: boolean; restored?: boolean; ownSet?: boolean; onClose(): void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState(false);
  // "Lost or stolen?" (WISP 06 § Forced takeover): on yes, the money checklist comes first once the profile opens here.
  // A device set of its own (a `moving` device whose remover is gone): the question is not asked, the old set is left whole.
  const [lost, setLost] = useState<boolean | null>(restored || ownSet ? false : null);
  const other = device ?? t("devices.join.otherDevice");
  const ready = (!asks || !!password) && (!device || name.trim().length > 0) && lost !== null;
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const outcome = await engine.call("deviceTakeover", { password, name, lost: lost === true });
      // Active now: the app starts again into the gate, where the engine raises its counters and starts.
      if (outcome.kind === "start") { await reloadIntoGate(); return; }
      setError(t(outcome.kind === "removed" ? "devices.takeover.ownSetRemoved" : outcome.kind === "wait" ? "devices.takeover.ownSetWait" : "devices.takeover.lostRace"));
    } catch (cause) {
      const key = takeoverErrorKey(cause);
      setError(key ? t(key) : errorText(cause, t));
    } finally { setBusy(false); }
  };
  return (
    <DeviceDialog title={device ? t("devices.takeover.title", { device }) : t("devices.takeover.titleUnnamed")} onClose={onClose} testId="takeover-dialog">
      <p className="flex items-start gap-1.5 text-text-secondary">
        <span className="min-w-0">{restored ? t("devices.takeover.hintRestored") : t("devices.takeover.hint", { device: other })}</span>
        <button type="button" data-testid="takeover-info" aria-expanded={info} aria-label={t("common.moreInfo")} title={t("common.moreInfo")} onClick={() => setInfo(!info)}
          className="grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-full text-text-muted hover:text-accent aria-expanded:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">ⓘ</button>
      </p>
      {info && <p data-testid="takeover-info-text" className="rounded-lg bg-surface-hover px-3 py-2 text-xs leading-5 text-text-secondary">{t("devices.takeover.info", { device: other })}</p>}
      {ownSet && <p data-testid="takeover-own-set" className="text-text-secondary">{t("devices.takeover.ownSetHint")}</p>}
      {!restored && !ownSet && (
        <fieldset className="space-y-1.5" data-testid="takeover-lost">
          <legend className="text-text-secondary">{t("devices.takeover.lostQuestion")}</legend>
          {([[true, "devices.takeover.lostYes", "takeover-lost-yes"], [false, "devices.takeover.lostNo", "takeover-lost-no"]] as const).map(([value, key, testId]) => (
            <label key={testId} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="takeover-lost" data-testid={testId} checked={lost === value} onChange={() => setLost(value)} className="accent-accent" />
              <span>{t(key)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (ready && !busy) void submit(); }}>
        {asks && <input type="password" autoFocus data-testid="takeover-password" aria-label={t("devices.password.current")} placeholder={t("devices.password.current")}
          value={password} onChange={(event) => setPassword(event.target.value)} className={field} />}
        {device && <input type="text" data-testid="takeover-name" autoComplete="off" spellCheck={false} aria-label={t("devices.takeover.confirm", { device })} placeholder={t("devices.takeover.confirm", { device })}
          value={name} onChange={(event) => setName(event.target.value)} className={field} />}
        {busy && <p role="status" data-testid="takeover-checking" className="text-text-secondary">{t("devices.takeover.checking")}</p>}
        {error && <p role="alert" data-testid="takeover-error" className="text-danger">{error}</p>}
        <button type="submit" data-testid="takeover-go" disabled={busy || !ready} className={primaryButton}>{t("devices.takeover.go")}</button>
      </form>
    </DeviceDialog>
  );
}
