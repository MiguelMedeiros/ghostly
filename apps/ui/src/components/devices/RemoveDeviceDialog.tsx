import { useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { useSettings } from "../../contexts/SettingsContext";
import { errorText } from "../../lib/errorText";
import { lostWalletLines, removeErrorKey } from "../../lib/devices";
import { DeviceDialog, primaryButton, quietButton } from "./DeviceDialog";

/**
 * Remove (WISP 06 § User experience, Remove): "Remove <device>?", what it means, and "Lost or stolen", which shows the
 * money checklist first. Plain on purpose: the final design is part 10.
 */
export function RemoveDeviceDialog({ device, deviceKey, onClose, onRemoved }: { device: string; deviceKey: string; onClose(): void; onRemoved?(): void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checklist, setChecklist] = useState(false);
  const remove = async () => {
    setBusy(true); setError("");
    try {
      await engine.call("deviceRemove", { key: deviceKey });
      onRemoved?.();
      onClose();
    } catch (cause) {
      const key = removeErrorKey(cause);
      setError(key ? t(key) : errorText(cause, t));
    } finally { setBusy(false); }
  };
  if (checklist) return <LostChecklist device={device} onClose={onClose} onRemove={() => { setChecklist(false); void remove(); }} />;
  return (
    <DeviceDialog title={t("devices.remove.title", { device })} onClose={onClose} testId="device-remove">
      <p className="text-text-secondary">{t("devices.remove.text")}</p>
      <p className="text-text-muted text-xs">{t("devices.remove.copy")}</p>
      {busy && <p role="status" data-testid="device-remove-busy" className="text-text-secondary">{t("devices.remove.removing")}</p>}
      {error && <p role="alert" data-testid="device-remove-error" className="text-danger">{error}</p>}
      <button type="button" data-testid="device-remove-go" disabled={busy} onClick={() => void remove()} className={primaryButton}>{t("devices.remove.go")}</button>
      <button type="button" data-testid="device-remove-lost" disabled={busy} onClick={() => setChecklist(true)} className={quietButton}>{t("devices.remove.lost")}</button>
    </DeviceDialog>
  );
}

const subscribe = (listener: () => void) => engine.subscribe(listener);
const walletOf = () => engine.state?.wallet;
const holdOf = () => !!engine.state?.settings.holdStorage;

/**
 * "Lost or stolen?": the written checklist of phase 1. First the storage keys, when storage is set up (the copy holds
 * them); then one line per wallet the lost device could spend from; then the chats. "Remove <device>" at the end.
 */
export function LostChecklist({ device, onClose, onRemove }: { device?: string; onClose(): void; onRemove?(): void }) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const wallet = useSyncExternalStore(subscribe, walletOf);
  const hold = useSyncExternalStore(subscribe, holdOf);
  const lines = lostWalletLines(wallet);
  const storage = hold || !!settings.backupS3;
  return (
    <DeviceDialog title={t("devices.lost.title")} onClose={onClose} testId="device-lost">
      <p className="text-text-secondary">{t("devices.lost.hint")}</p>
      <ol className="space-y-3 list-decimal ps-5" data-testid="device-lost-lines">
        {storage && <Line testId="device-lost-storage" title={t("devices.lost.storage")} hint={t("devices.lost.storageHint")} />}
        {lines.cashu && <Line testId="device-lost-cashu" title={t("devices.lost.cashu")} hint={t("devices.lost.cashuHint")} />}
        {lines.phrase.map((name) => <Line key={name} testId="device-lost-phrase" title={t("devices.lost.phrase", { wallet: name })} />)}
        {lines.remote.map((name) => <Line key={name} testId="device-lost-lightning" title={t("devices.lost.lightning", { wallet: name })} />)}
        <Line testId="device-lost-chats" title={t("devices.lost.chats")} hint={t("devices.lost.chatsHint")} />
      </ol>
      {onRemove && device && <button type="button" data-testid="device-lost-remove" onClick={onRemove} className={primaryButton}>{t("devices.lost.remove", { device })}</button>}
      <button type="button" data-testid="device-lost-done" onClick={onClose} className={quietButton}>{t("devices.lost.done")}</button>
    </DeviceDialog>
  );
}

function Line({ title, hint, testId }: { title: string; hint?: string; testId: string }) {
  return (
    <li data-testid={testId} className="space-y-0.5">
      <p className="text-text-primary">{title}</p>
      {hint && <p className="text-text-muted text-xs">{hint}</p>}
    </li>
  );
}
