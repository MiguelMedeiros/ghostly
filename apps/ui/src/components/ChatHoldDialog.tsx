import { useRef, useState } from "react";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDismiss";
import type { PeerLinkState } from "../lib/platform";
import { Switch } from "./wallet/ui";
import { useI18n } from "../contexts/I18nContext";
import { errorText } from "../lib/errorText";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

/**
 * Store-and-forward for one chat (WISP 404): whether what is sent while the contact is away waits in
 * this device's own storage, sealed for them, and whether this device picks up what they held for it.
 * One switch covers both directions; a way works only when both sides allow it, like payments.
 */
export function ChatHoldDialog({ peer, name, onSave, onClose }: { peer: PeerLinkState; name: string; onSave: (enabled: boolean) => Promise<void>; onClose: () => void }) {
  const hold = peer.hold;
  const initial = hold?.enabled ?? false;
  const [enabled, setEnabled] = useState(initial);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, onClose);
  const backdrop = useBackdropDismiss(onClose);
  const { t } = useI18n();
  const connected = peer.dataLink === "open";
  const contact = !initial ? t("chat.hold.off") : hold?.peerAllows === undefined ? (connected ? t("chat.hold.contactOnSession") : t("chat.hold.contactOnConnect")) : hold.peerAllows ? t("chat.hold.contactAllows") : t("chat.hold.contactOff");
  const days = Math.round((hold?.ttlMs ?? 0) / 86_400_000);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in" {...backdrop}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="chat-hold-title" data-testid="chat-hold" className="focus:outline-none w-full max-w-md bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-4">
        <div>
          <h2 id="chat-hold-title" className="text-lg font-medium text-text-primary">{t("chat.hold.title", { name })}</h2>
          <p className="text-xs text-text-muted mt-1">{t("chat.hold.intro", { name, days })}</p>
        </div>
        <div className="bg-surface rounded-xl divide-y divide-border">
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-text-primary">{t("chat.hold.switch")}</p>
              <p className="text-[11px] text-text-secondary" data-testid="chat-hold-contact">{contact}</p>
            </div>
            <Switch testId="chat-hold-toggle" label={t("chat.hold.switch")} checked={enabled} disabled={busy} onChange={setEnabled} />
          </div>
          <div className="px-4 py-3 space-y-1">
            <p className="text-[11px] text-text-secondary" data-testid="chat-hold-storage">{hold?.storage ? t("chat.hold.storage") : t("chat.hold.noStorage")}</p>
            <p className="text-[11px] text-text-secondary" data-testid="chat-hold-quota">
              {hold ? t("chat.hold.quota", { name, count: hold.outstanding, max: hold.maxItems, bytes: mb(hold.bytes), maxBytes: mb(hold.maxBytes) }) : t("chat.hold.nothing")}
            </p>
            {hold?.refused ? <p className="text-[11px] text-danger" data-testid="chat-hold-refused">{hold.refused === 1 ? t("chat.hold.refusedOne", { name }) : t("chat.hold.refusedMany", { count: hold.refused, name })}</p> : null}
            {hold?.error && <p className="text-[11px] text-danger" data-testid="chat-hold-error">{hold.error}</p>}
          </div>
        </div>
        <p className="text-[11px] text-text-muted">{t("chat.hold.privacy")}</p>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm bg-surface-alt text-text-primary border border-border hover:bg-surface-hover cursor-pointer">{t("common.cancel")}</button>
          <button type="button" data-testid="chat-hold-save" disabled={enabled === initial || busy}
            onClick={() => { setBusy(true); setError(""); void onSave(enabled).then(onClose, (e) => { setError(errorText(e, t)); setBusy(false); }); }}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-on-accent hover:bg-accent-hover cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
            {busy ? t("chat.hold.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
