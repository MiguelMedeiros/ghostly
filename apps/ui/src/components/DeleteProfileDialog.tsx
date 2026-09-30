import { useEffect, useState, useRef } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDismiss";
import { deleteProfile, profileLock, profileSummary, type ProfileSummary } from "../lib/profileData";
import { createProfileBackup } from "../lib/profileBackup";
import type { ProfileEntry } from "../lib/profiles";
import { input } from "./wallet/ui";
import { InputGroup } from "./layout";
import { formatAmount } from "../lib/amount";

/**
 * Deleting a profile removes its chats, keys and wallets for good. The dialog says what is inside, offers
 * a backup first, and asks for the profile's name.
 */
export function DeleteProfileDialog({ entry, onClose }: { entry: ProfileEntry; onClose: () => void }) {
  const { t, language } = useI18n();
  const backdrop = useBackdropDismiss(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  const [summary, setSummary] = useState<ProfileSummary | null>(null);
  const [typed, setTyped] = useState(""), [passphrase, setPassphrase] = useState("");
  const [backingUp, setBackingUp] = useState(false), [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = !!profileLock(entry.id);
  const [lockPassword, setLockPassword] = useState("");
  useEffect(() => { void profileSummary(entry.id).then(setSummary, () => setSummary(null)); }, [entry.id]);

  const parts = summary ? [
    summary.chats === 1 ? t("profile.chatOne") : t("profile.chatCount", { count: summary.chats }),
    summary.cashuSats ? t("profile.delete.cashuSats", { amount: formatAmount(summary.cashuSats, language) }) : "",
    summary.ark ? t("profile.delete.arkWallet") : "",
    summary.usdt ? t("profile.delete.usdtWallet") : "",
    summary.services ? (summary.services === 1 ? t("profile.delete.serviceOne") : t("profile.delete.serviceCount", { count: summary.services })) : "",
  ].filter(Boolean) : [];
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const button = "px-4 py-2 min-h-10 whitespace-nowrap rounded-lg text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in" {...backdrop}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="delete-profile-title" data-testid="delete-profile" className="focus:outline-none w-full max-w-sm max-h-full overflow-y-auto bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-4">
        <div className="space-y-1">
          <h2 id="delete-profile-title" className="text-base font-semibold text-text-primary break-words">{t("profile.delete.title", { name: entry.name })}</h2>
          <p className="text-sm text-text-muted" data-testid="delete-profile-summary">{summary ? parts.join(" · ") : t("profile.delete.reading")}</p>
          <p className="text-sm text-danger">{t("profile.delete.warning")}</p>
        </div>

        {!backingUp ? (
          <button type="button" onClick={() => setBackingUp(true)} className="min-h-10 text-sm text-accent hover:underline cursor-pointer">{saved ? t("profile.delete.downloaded") : t("profile.delete.backupFirst")}</button>
        ) : (
          <InputGroup>
            <input type="password" autoComplete="new-password" aria-label={t("profile.delete.backupPassphrase")} className={input} placeholder={t("profile.backups.passphraseNew")} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <button type="button" disabled={busy || passphrase.length < 12 || (locked && !lockPassword)} className={`${button} bg-surface-alt text-text-primary border border-border`}
              onClick={() => void run(async () => {
                const text = await createProfileBackup(passphrase, entry.id, lockPassword);
                const url = URL.createObjectURL(new Blob([text], { type: "application/vnd.ghostly.backup+json" }));
                const link = document.createElement("a"); link.href = url; link.download = `${entry.name.replace(/[^\w-]+/g, "-")}.ghostly-backup`; link.click();
                setTimeout(() => URL.revokeObjectURL(url), 2000);
                setSaved(true); setBackingUp(false); setPassphrase("");
              })}>{t("common.save")}</button>
          </InputGroup>
        )}

        {locked && <input data-testid="delete-profile-password" type="password" autoComplete="current-password" aria-label={t("profile.delete.lockPasswordLabel", { name: entry.name })} className={input} placeholder={t("profile.delete.lockPassword")} value={lockPassword} onChange={(e) => setLockPassword(e.target.value)} />}
        <input data-testid="delete-profile-confirm" aria-label={t("profile.delete.confirmLabel")} className={input} placeholder={t("profile.delete.confirmPlaceholder", { name: entry.name })} value={typed} onChange={(e) => setTyped(e.target.value)} />
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={`${button} bg-surface-alt text-text-primary border border-border`}>{t("common.cancel")}</button>
          <button type="button" data-testid="delete-profile-go" disabled={busy || typed.trim() !== entry.name || (locked && !lockPassword)} onClick={() => void run(async () => { await deleteProfile(entry.id, lockPassword); onClose(); })}
            className={`${button} bg-danger text-white font-semibold`}>{busy ? t("profile.delete.deleting") : t("common.delete")}</button>
        </div>
      </div>
    </div>
  );
}
