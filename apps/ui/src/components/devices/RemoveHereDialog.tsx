import { useState } from "react";
import { getBrowserHost } from "@ghostly/browser/host";
import { useI18n } from "../../contexts/I18nContext";
import { removeProfileHere } from "../../lib/profileData";
import { activeProfileId, baseProfileName, currentProfile } from "../../lib/profiles";
import { DeviceDialog, dangerButton, field } from "./DeviceDialog";
import { fillNames } from "../../lib/fillNodes";
import { type Problem, problemText } from "../../lib/problemText";
import { Notice } from "../ui/Notice";

/**
 * "Remove this profile here" (WISP 06 § User experience), on a device out of the profile's device set for good: the
 * frozen copy it holds is not encrypted, and this takes it off this device. Asked with the profile's name typed, as
 * deleting a profile is. The first profile stays on the list, empty; another one goes, and the app opens the first.
 */
export function RemoveHereDialog({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const id = activeProfileId();
  // Its name without the word the app adds to a restored one: what to type, as Delete profile asks it.
  const name = baseProfileName(id) ?? currentProfile().name;
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const ready = typed.trim() === name;
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await removeProfileHere();
    } catch (cause) {
      setError(problemText(cause, t));
      setBusy(false);
      return;
    }
    // A host whose peer outlives the page (the extension's) starts a new one, which reads the gate again; then the app.
    try { await getBrowserHost().restartEngine?.(); } catch { /* the reload starts it */ }
    window.history.replaceState(null, "", "#/");
    window.location.reload();
  };
  return (
    <DeviceDialog title={fillNames(t("devices.standby.removeHere.title"), { name })} onClose={onClose} testId="device-remove-here">
      <p className="text-text-secondary">{t("devices.standby.removeHere.hint")}</p>
      {!id && <p className="text-text-secondary">{t("devices.standby.removeHere.first")}</p>}
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (ready && !busy) void submit(); }}>
        <label className="block space-y-1">
          <span className="text-text-secondary">{fillNames(t("devices.standby.removeHere.confirm"), { name })}</span>
          {/* `dir="auto"`: the name typed reads in its own direction, a Latin one in an Arabic dialog too. */}
          <input type="text" dir="auto" autoFocus data-testid="device-remove-here-name" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={name}
            value={typed} onChange={(event) => setTyped(event.target.value)} className={field} />
        </label>
        {error && <Notice problem={error} testId="device-remove-here-error" className="" />}
        {/* `aria-disabled`, not `disabled`, while it runs: a disabled button drops the keyboard focus to the page. */}
        <button type="submit" data-testid="device-remove-here-go" disabled={!ready} aria-disabled={busy || undefined} aria-busy={busy || undefined} className={dangerButton}>
          {busy ? t("devices.standby.removeHere.removing") : t("devices.standby.removeHere.go")}
        </button>
      </form>
    </DeviceDialog>
  );
}
