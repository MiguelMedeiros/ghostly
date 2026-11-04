import { useEffect, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { fitsDeviceName, renameErrorKey } from "../../lib/devices";
import { useFittedNameField } from "../../hooks/useGroupNameField";
import { DeviceDialog, field, primaryButton, quietButton } from "./DeviceDialog";
import { type Problem, problemText } from "../../lib/problemText";
import { Notice } from "../ui/Notice";
import { said } from "../../lib/notices";
import { fillNames } from "../../lib/fillNodes";

/**
 * Rename (WISP 06 § User experience, the row menu), on the active device: one field with the name the set holds now,
 * Save and Cancel. Enter saves and Escape cancels; while the save runs it says "Saving…" and stays open, and a refusal
 * gives the focus back to the name. The name fits the 16 bytes a device's slot keeps, as the join step's does; every
 * device of the set shows it once it reads the set's next record.
 */
export function RenameDeviceDialog({ device, deviceKey, onClose, onRenamed }: { device: string; deviceKey: string; onClose(): void; onRenamed?(name: string): void }) {
  const { t } = useI18n();
  const [name, setName] = useState(device);
  const nameField = useFittedNameField(name, setName, fitsDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const typed = name.trim();
  // The field and Save are disabled while the save runs, and a browser then leaves the focus on the page: a refusal
  // puts it back on the name, to change it or press Enter again.
  const fieldRef = nameField.ref;
  useEffect(() => { if (error && !busy) fieldRef.current?.focus(); }, [error, busy, fieldRef]);
  const save = async () => {
    if (!typed || busy) return;
    if (typed === device) { onClose(); return; }
    setBusy(true); setError(null);
    try {
      await engine.call("deviceRename", { key: deviceKey, name: typed });
      onRenamed?.(typed);
      onClose();
    } catch (cause) {
      const key = renameErrorKey(cause);
      setError(key ? said(key, t) : problemText(cause, t));
      setBusy(false);
    }
  };
  // While the save runs × and Escape do nothing, as Cancel: closed, its refusal would be said nowhere, and a save that
  // went through would rename the device after the person cancelled.
  const close = () => { if (!busy) onClose(); };
  return (
    <DeviceDialog title={fillNames(t("devices.rename.title"), { device })} onClose={close} testId="device-rename">
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="block space-y-1">
          <span className="text-text-secondary">{t("devices.rename.label")}</span>
          <input data-testid="device-rename-name" autoFocus {...nameField} value={name} disabled={busy} onFocus={(event) => event.currentTarget.select()} className={field} />
        </label>
        {busy && <p role="status" data-testid="device-rename-busy" className="text-text-secondary">{t("devices.rename.saving")}</p>}
        {error && <Notice problem={error} testId="device-rename-error" className="" />}
        <button type="submit" data-testid="device-rename-save" disabled={!typed || busy} className={primaryButton}>{t("devices.rename.save")}</button>
        <button type="button" data-testid="device-rename-cancel" disabled={busy} onClick={onClose} className={quietButton}>{t("common.cancel")}</button>
      </form>
    </DeviceDialog>
  );
}
