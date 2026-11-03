import { useState } from "react";
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
 * Save and Cancel. Enter saves and Escape cancels. The name fits the 16 bytes a device's slot keeps, as the join step's
 * does; every device of the set shows it once it reads the set's next record.
 */
export function RenameDeviceDialog({ device, deviceKey, onClose, onRenamed }: { device: string; deviceKey: string; onClose(): void; onRenamed?(name: string): void }) {
  const { t } = useI18n();
  const [name, setName] = useState(device);
  const nameField = useFittedNameField(name, setName, fitsDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const typed = name.trim();
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
  return (
    <DeviceDialog title={fillNames(t("devices.rename.title"), { device })} onClose={onClose} testId="device-rename">
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="block space-y-1">
          <span className="text-text-secondary">{t("devices.rename.label")}</span>
          <input data-testid="device-rename-name" autoFocus {...nameField} value={name} disabled={busy} onFocus={(event) => event.currentTarget.select()} className={field} />
        </label>
        {error && <Notice problem={error} testId="device-rename-error" className="" />}
        <button type="submit" data-testid="device-rename-save" disabled={!typed || busy} className={primaryButton}>{t("devices.rename.save")}</button>
        <button type="button" data-testid="device-rename-cancel" disabled={busy} onClick={onClose} className={quietButton}>{t("common.cancel")}</button>
      </form>
    </DeviceDialog>
  );
}
