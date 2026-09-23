import { useRef, useState } from "react";
import type { PaymentMethodName } from "@ghostly/core";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDismiss";
import type { PeerLinkState } from "../lib/platform";
import { WalletMark } from "./WalletCards";
import { Switch } from "./wallet/ui";
import "./wallet-cards.css";

const METHODS: { id: PaymentMethodName; name: string; what: string }[] = [
  { id: "cashu", name: "Cashu", what: "Ecash in the chat" },
  { id: "lightning", name: "Lightning", what: "Invoices" },
  { id: "arkade", name: "Ark", what: "Ark requests" },
  { id: "usdt", name: "USDT", what: "USDT requests" },
];

/**
 * Which ways of paying one contact may use, chosen per chat. A way works only when both sides allow
 * it; a connected contact is told at once, and later sessions offer it in the handshake.
 */
export function ChatPaymentsDialog({ peer, name, onSave, onClose }: { peer: PeerLinkState; name: string; onSave: (methods: Record<PaymentMethodName, boolean>) => Promise<void>; onClose: () => void }) {
  const initial = peer.paymentMethods ?? { cashu: true, lightning: true, arkade: true, usdt: true };
  const [methods, setMethods] = useState(initial);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, onClose);
  const backdrop = useBackdropDismiss(onClose);
  const changed = METHODS.some((m) => methods[m.id] !== initial[m.id]);
  const connected = peer.dataLink === "open";
  const contact = (id: PaymentMethodName) => {
    if (!initial[id]) return "Off in this chat";
    if (!connected) return "Contact: shown when connected";
    return peer.capabilities?.methods?.[id] ? "Contact: allows it" : "Contact: has it off";
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in" {...backdrop}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="chat-payments-title" data-testid="chat-payments" className="focus:outline-none w-full max-w-md bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-4">
        <div>
          <h2 id="chat-payments-title" className="text-lg font-medium text-text-primary">Payments with {name}</h2>
          <p className="text-xs text-text-muted mt-1">A way works only when both of you allow it.</p>
        </div>
        <div className="bg-surface rounded-xl divide-y divide-border">
          {METHODS.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-3">
              <span className={`wallet-card-${m.id === "arkade" ? "arkade" : m.id} shrink-0 grid place-items-center w-9 h-9 rounded-lg`} style={{ color: "rgb(var(--card-rgb))", background: "rgba(var(--card-rgb),.14)" }}><WalletMark rail={m.id} /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary">{m.name}</p>
                <p className="text-xs text-text-muted">{m.what}</p>
                <p className="text-[11px] text-text-secondary" data-testid={`chat-payments-${m.id}-contact`}>{contact(m.id)}</p>
              </div>
              <Switch testId={`chat-payments-${m.id}`} label={`${m.name} in this chat`} checked={methods[m.id]} disabled={busy} onChange={(on) => setMethods({ ...methods, [m.id]: on })} />
            </div>
          ))}
        </div>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm bg-surface-alt text-text-primary border border-border hover:bg-surface-hover cursor-pointer">Cancel</button>
          <button type="button" data-testid="chat-payments-save" disabled={!changed || busy}
            onClick={() => { setBusy(true); setError(""); void onSave(methods).then(onClose, (e) => { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }); }}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-[#111b21] hover:bg-accent-hover cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
