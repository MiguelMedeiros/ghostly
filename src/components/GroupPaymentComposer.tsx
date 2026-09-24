import { useRef, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupMemberView, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { edgeDot, memberName } from "../lib/groups";
import { PaymentComposer } from "./PaymentComposer";
import type { ChatRail } from "./WalletCards";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;
const EVERYONE = "*";
const GROUP_RAILS: readonly ChatRail[] = ["cashu", "lightning"];
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/**
 * ⚡ in a group (WISP 9xx § Payments): first whom — one member, or the whole group for a request anyone may pay
 * once — then the chat's own cards, review and approval. With one member everything goes over the edge to them,
 * exactly as in a chat; the group sees what happens as a note.
 */
export function GroupPaymentComposer({ group, onClose }: { group: GroupView; onClose(): void }) {
  const state = useSyncExternalStore(subscribe, snapshot);
  const wallet = useServicesPlatform()?.wallet;
  const [to, setTo] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideDismiss(ref, to === null, onClose);
  const others = group.members.filter(m => !m.me);
  const linkOf = (m: GroupMemberView): LinkView | undefined => m.edge ? state?.edges?.find(l => l.id === m.edge!.linkId) : undefined;
  /** Why this member cannot be paid right now, if they cannot. */
  const why = (m: GroupMemberView): string | undefined => {
    const link = linkOf(m);
    if (!link || m.edge?.state !== "open") return "Not reachable right now";
    if (!link.capabilities?.payments) return "Their app takes no payments in groups (it needs an update), or they turned every way off";
    return undefined;
  };
  const balance = wallet?.getState()?.balance ?? 0;

  if (to === EVERYONE) return <PaymentComposer balance={balance} contact="the group" rails={GROUP_RAILS}
    reviewContext={wallet ? { wallet, peer: "", linkId: "" } : undefined} onBack={() => setTo(null)} onClose={onClose}
    sendUnavailable="A request to the group is paid by one member; to pay someone, choose them instead"
    describe={rail => rail === "lightning"
      ? "Request with one Lightning invoice. Any member may pay it, once: an invoice cannot be paid twice."
      : rail === "cashu" ? "Request ecash from a mint you use. The first member whose ecash arrives pays it; anyone later gets theirs back." : "Only Cashu or Lightning for the whole group."}
    onSend={async () => "Choose one member to send to"}
    onRequest={async (amount, memo, _method, rail) => {
      try { await engine.call("requestGroupPayment", { groupId: group.id, amount, memo: memo || undefined, timestamp: Date.now(), rail: rail === "lightning" ? "lightning" : "cashu" }); return null; }
      catch (e) { return message(e); }
    }} />;

  const member = to ? others.find(m => m.key === to) : undefined;
  const link = member && linkOf(member);
  if (member && link) return <PaymentComposer balance={balance} contact={memberName(member)} onBack={() => setTo(null)} onClose={onClose}
    reviewContext={wallet ? { wallet, peer: link.peerPubKeyZ32, linkId: link.id } : undefined}
    onSend={async (amount, memo) => {
      try { await engine.call("sendPayment", { linkId: link.id, amount, memo: memo || undefined, timestamp: Date.now() }); return null; } catch (e) { return message(e); }
    }}
    onRequest={async (amount, memo, method, rail) => {
      // One way of paying per request, the card's: a Cashu request carries no invoice, a Lightning one no ecash.
      const only = rail === "lightning" ? "lightning" : rail === "cashu" ? "cashu" : undefined;
      try { await engine.call("requestPayment", { linkId: link.id, amount, memo: memo || undefined, timestamp: Date.now(), method, ...(only ? { rail: only } : {}) }); return null; }
      catch (e) { return message(e); }
    }} />;

  return <>
    <div className="sheet-backdrop" />
    <div ref={ref} data-testid="group-pay-recipients" onKeyDown={e => e.key === "Escape" && onClose()}
      className="sheet sheet-padded absolute bottom-full left-0 mb-2 z-50 animate-fade-in w-[360px] max-w-[calc(100vw-1.5rem)] bg-panel-header border border-border rounded-2xl shadow-2xl p-3">
      <p className="m-0 px-1 text-sm font-semibold text-text-primary">Pay or request</p>
      <p className="m-0 px-1 text-xs text-text-muted">The payment goes only between the two of you; everyone in the group sees who paid whom and how much.</p>
      <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
        {others.map(m => {
          const reason = why(m);
          return <li key={m.key}>
            <button type="button" data-testid="group-pay-recipient" data-key={m.key} disabled={!!reason} title={reason} onClick={() => setTo(m.key)}
              className="flex w-full min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50">
              <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${edgeDot(m)}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text-primary">{memberName(m)}</span>
                {reason && <span className="block truncate text-[11px] text-text-muted">{reason}</span>}
              </span>
            </button>
          </li>;
        })}
        <li className="border-t border-border pt-1">
          <button type="button" data-testid="group-pay-everyone" disabled={others.length === 0} onClick={() => setTo(EVERYONE)}
            className="flex w-full min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-hover disabled:opacity-50">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-text-primary">Request from the group</span>
              <span className="block text-[11px] text-text-muted">Anyone in the group may pay it, once</span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  </>;
}
