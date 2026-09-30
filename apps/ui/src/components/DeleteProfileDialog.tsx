import { useEffect, useState, useRef } from "react";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDismiss";
import { deleteProfile, profileLock, profileSummary, type ProfileSummary } from "../lib/profileData";
import { createProfileBackup } from "../lib/profileBackup";
import type { ProfileEntry } from "../lib/profiles";
import { input } from "./wallet/ui";
import { InputGroup } from "./layout";

/**
 * Deleting a profile removes its chats, keys and wallets for good. The dialog says what is inside, offers
 * a backup first, and asks for the profile's name.
 */
export function DeleteProfileDialog({ entry, onClose }: { entry: ProfileEntry; onClose: () => void }) {
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
    `${summary.chats} ${summary.chats === 1 ? "chat" : "chats"}`,
    summary.cashuSats ? `${summary.cashuSats.toLocaleString()} sats in Cashu` : "",
    summary.ark ? "Ark wallet" : "",
    summary.usdt ? "USDT wallet" : "",
    summary.services ? `${summary.services} ${summary.services === 1 ? "app" : "apps"}` : "",
  ].filter(Boolean) : [];
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const button = "px-4 py-2 min-h-10 whitespace-nowrap rounded-lg text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in" {...backdrop}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="delete-profile-title" data-testid="delete-profile" className="focus:outline-none w-full max-w-sm max-h-full overflow-y-auto bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-4">
        <div className="space-y-1">
          <h2 id="delete-profile-title" className="text-base font-semibold text-text-primary break-words">Delete “{entry.name}”?</h2>
          <p className="text-sm text-text-muted" data-testid="delete-profile-summary">{summary ? parts.join(" · ") : "Reading…"}</p>
          <p className="text-sm text-danger">This can’t be undone. Its wallets go with it.</p>
        </div>

        {!backingUp ? (
          <button type="button" onClick={() => setBackingUp(true)} className="min-h-10 text-sm text-accent hover:underline cursor-pointer">{saved ? "Backup downloaded ✓" : "Download a backup first"}</button>
        ) : (
          <InputGroup>
            <input type="password" autoComplete="new-password" aria-label="Backup passphrase" className={input} placeholder="Passphrase (12+)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <button type="button" disabled={busy || passphrase.length < 12 || (locked && !lockPassword)} className={`${button} bg-surface-alt text-text-primary border border-border`}
              onClick={() => void run(async () => {
                const text = await createProfileBackup(passphrase, entry.id, lockPassword);
                const url = URL.createObjectURL(new Blob([text], { type: "application/vnd.ghostly.backup+json" }));
                const link = document.createElement("a"); link.href = url; link.download = `${entry.name.replace(/[^\w-]+/g, "-")}.ghostly-backup`; link.click();
                setTimeout(() => URL.revokeObjectURL(url), 2000);
                setSaved(true); setBackingUp(false); setPassphrase("");
              })}>Save</button>
          </InputGroup>
        )}

        {locked && <input data-testid="delete-profile-password" type="password" autoComplete="current-password" aria-label={`${entry.name}'s lock password`} className={input} placeholder="Its lock password" value={lockPassword} onChange={(e) => setLockPassword(e.target.value)} />}
        <input data-testid="delete-profile-confirm" aria-label="Type the profile name to confirm" className={input} placeholder={`Type ${entry.name}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={`${button} bg-surface-alt text-text-primary border border-border`}>Cancel</button>
          <button type="button" data-testid="delete-profile-go" disabled={busy || typed.trim() !== entry.name || (locked && !lockPassword)} onClick={() => void run(async () => { await deleteProfile(entry.id, lockPassword); onClose(); })}
            className={`${button} bg-danger text-white font-semibold`}>{busy ? "Deleting…" : "Delete"}</button>
        </div>
      </div>
    </div>
  );
}
