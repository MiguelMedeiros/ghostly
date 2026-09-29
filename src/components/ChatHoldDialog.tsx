import { useRef, useState } from "react";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDismiss";
import type { PeerLinkState } from "../lib/platform";
import { Switch } from "./wallet/ui";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

/**
 * Store-and-forward for one chat (WISP 4xx): whether what is sent while the contact is away waits in
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
  const connected = peer.dataLink === "open";
  const contact = !initial ? "Off in this chat" : hold?.peerAllows === undefined ? (connected ? "Contact: shown once the session is up" : "Contact: shown when connected") : hold.peerAllows ? "Contact: allows it" : "Contact: has it off, or needs an updated Ghostly";
  const days = Math.round((hold?.ttlMs ?? 0) / 86_400_000);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in" {...backdrop}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="chat-hold-title" data-testid="chat-hold" className="focus:outline-none w-full max-w-md bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-4">
        <div>
          <h2 id="chat-hold-title" className="text-lg font-medium text-text-primary">Hold messages for {name}</h2>
          <p className="text-xs text-text-muted mt-1">While {name} is away, what you send waits in your own storage, sealed so only they can open it, for up to {days} days. Text, pictures and payment requests; never ecash. They need to allow it too.</p>
        </div>
        <div className="bg-surface rounded-xl divide-y divide-border">
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-text-primary">Hold messages while my contact is away</p>
              <p className="text-[11px] text-text-secondary" data-testid="chat-hold-contact">{contact}</p>
            </div>
            <Switch testId="chat-hold-toggle" label="Hold messages while my contact is away" checked={enabled} disabled={busy} onChange={setEnabled} />
          </div>
          <div className="px-4 py-3 space-y-1">
            <p className="text-[11px] text-text-secondary" data-testid="chat-hold-storage">{hold?.storage ? "Storage: your S3 storage (Profile → Backups)" : "Storage: not set up. Set up S3 storage under Profile → Backups to hold messages; picking up theirs needs none."}</p>
            <p className="text-[11px] text-text-secondary" data-testid="chat-hold-quota">
              {hold ? `Held for ${name}: ${hold.outstanding} of ${hold.maxItems} items · ${mb(hold.bytes)} of ${mb(hold.maxBytes)}` : "Held: nothing"}
            </p>
            {hold?.refused ? <p className="text-[11px] text-danger" data-testid="chat-hold-refused">{hold.refused} held {hold.refused === 1 ? "item" : "items"} from {name} could not be verified and {hold.refused === 1 ? "was" : "were"} refused.</p> : null}
            {hold?.error && <p className="text-[11px] text-danger" data-testid="chat-hold-error">{hold.error}</p>}
          </div>
        </div>
        <p className="text-[11px] text-text-muted">Your storage and the relays see only sealed items, their sizes and when they move. A held item can be picked up until seven days after you were last online.</p>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm bg-surface-alt text-text-primary border border-border hover:bg-surface-hover cursor-pointer">Cancel</button>
          <button type="button" data-testid="chat-hold-save" disabled={enabled === initial || busy}
            onClick={() => { setBusy(true); setError(""); void onSave(enabled).then(onClose, (e) => { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }); }}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-on-accent hover:bg-accent-hover cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
