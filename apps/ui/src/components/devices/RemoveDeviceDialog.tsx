import { useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { useSettings } from "../../contexts/SettingsContext";
import { lostWalletLines, removeErrorKey } from "../../lib/devices";
import { DeviceDialog, dangerButton, primaryButton, quietButton } from "./DeviceDialog";
import { type Problem, problemText } from "../../lib/problemText";
import { Notice } from "../ui/Notice";
import { said } from "../../lib/notices";

/**
 * Remove (WISP 06 § User experience, Remove): "Remove <device>?", what it means, and "Lost or stolen", which shows the
 * money checklist first.
 */
export function RemoveDeviceDialog({ device, deviceKey, onClose, onRemoved }: { device: string; deviceKey: string; onClose(): void; onRemoved?(): void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const [checklist, setChecklist] = useState(false);
  const remove = async () => {
    setBusy(true); setError(null);
    try {
      await engine.call("deviceRemove", { key: deviceKey });
      onRemoved?.();
      onClose();
    } catch (cause) {
      const key = removeErrorKey(cause);
      setError(key ? said(key, t) : problemText(cause, t));
    } finally { setBusy(false); }
  };
  if (checklist) return <LostChecklist device={device} onClose={onClose} onRemove={() => { setChecklist(false); void remove(); }} />;
  return (
    <DeviceDialog title={t("devices.remove.title", { device })} onClose={onClose} testId="device-remove">
      <p className="text-text-secondary">{t("devices.remove.text")}</p>
      <p className="text-text-muted text-xs">{t("devices.remove.copy")}</p>
      {busy && <p role="status" data-testid="device-remove-busy" className="text-text-secondary">{t("devices.remove.removing")}</p>}
      {error && <Notice problem={error} testId="device-remove-error" className="" />}
      <button type="button" data-testid="device-remove-go" disabled={busy} onClick={() => void remove()} className={dangerButton}>{t("devices.remove.go")}</button>
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
      <ol className="space-y-2" data-testid="device-lost-lines">
        {[
          storage && { testId: "device-lost-storage", title: t("devices.lost.storage"), hint: t("devices.lost.storageHint") },
          lines.cashu && { testId: "device-lost-cashu", title: t("devices.lost.cashu"), hint: t("devices.lost.cashuHint") },
          ...lines.phrase.map((name) => ({ testId: "device-lost-phrase", title: t("devices.lost.phrase", { wallet: name }) })),
          ...lines.remote.map((name) => ({ testId: "device-lost-lightning", title: t("devices.lost.lightning", { wallet: name }) })),
          { testId: "device-lost-chats", title: t("devices.lost.chats"), hint: t("devices.lost.chatsHint") },
        ].filter((line): line is { testId: string; title: string; hint?: string } => !!line).map((line, index) => <Line key={`${line.testId}:${line.title}`} n={index + 1} {...line} />)}
      </ol>
      {onRemove && device && <button type="button" data-testid="device-lost-remove" onClick={onRemove} className={primaryButton}>{t("devices.lost.remove", { device })}</button>}
      <button type="button" data-testid="device-lost-done" onClick={onClose} className={quietButton}>{t("devices.lost.done")}</button>
    </DeviceDialog>
  );
}

function Line({ n, title, hint, testId }: { n: number; title: string; hint?: string; testId: string }) {
  return (
    <li data-testid={testId} className="flex gap-3 rounded-lg bg-surface-alt px-3 py-2.5">
      <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-bold text-accent tabular-nums">{n}</span>
      <span className="min-w-0 space-y-0.5">
        <span className="block text-text-primary">{title}</span>
        {hint && <span className="block text-xs text-text-muted">{hint}</span>}
      </span>
    </li>
  );
}
