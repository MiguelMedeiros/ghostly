import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { pairLinkId } from "@ghostly/browser/shared/payLinks";
import type { GroupMemberView, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useI18n } from "../contexts/I18nContext";
import { edgeDot, memberName } from "../lib/groups";
import { PaymentComposer } from "./PaymentComposer";
import type { ChatRail } from "./WalletCards";
import { errorText } from "../lib/errorText";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;
const EVERYONE = "*";
const GROUP_RAILS: readonly ChatRail[] = ["cashu", "lightning"];

/**
 * ⚡ in a group (WISP 9xx § Payments): first whom — one member, or the whole group for a request anyone may pay
 * once — then the chat's own cards, review and approval. With one member everything goes over the edge to them,
 * exactly as in a chat; in a community, through the group, sealed to them (hubs pass it on unread, and a member who
 * is away gets it on return). The group sees what happens as a note.
 */
export function GroupPaymentComposer({ group, onClose }: { group: GroupView; onClose(): void }) {
  const { t } = useI18n();
  const state = useSyncExternalStore(subscribe, snapshot);
  const wallet = useServicesPlatform()?.wallet;
  const [to, setTo] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideDismiss(ref, to === null, onClose);
  const others = group.members.filter(m => !m.me);
  const community = group.profile === "community";
  // A community member is reached through the group: a link the engine lists once their ways of paying are known.
  const linkIdOf = (m: GroupMemberView) => community ? pairLinkId(group.id, m.key) : m.edge?.linkId;
  const linkOf = (m: GroupMemberView): LinkView | undefined => { const id = linkIdOf(m); return id ? state?.edges?.find(l => l.id === id) : undefined; };
  // Their app is asked what it takes, so the cards say what the two of you share.
  useEffect(() => { if (community && to && to !== EVERYONE) void engine.call("groupPaymentHello", { groupId: group.id, member: to }).catch(() => {}); }, [community, group.id, to]);
  /** Why this member cannot be paid right now, if they cannot. */
  const why = (m: GroupMemberView): string | undefined => {
    const link = linkOf(m);
    // Through the group it goes now or when they are back; only a member who said it takes nothing cannot be paid.
    if (community) return link?.capabilities && !link.capabilities.payments ? t("payments.group.why.noWay") : undefined;
    if (!link || m.edge?.state !== "open") return t("payments.group.why.unreachable");
    if (!link.capabilities?.payments) return t("payments.group.why.noPayments");
    return undefined;
  };
  const balance = wallet?.getState()?.balance ?? 0;

  if (to === EVERYONE) return <PaymentComposer balance={balance} contact={t("payments.group.theGroup")} rails={GROUP_RAILS}
    reviewContext={wallet ? { wallet, peer: "", linkId: "" } : undefined} onBack={() => setTo(null)} onClose={onClose}
    sendUnavailable={t("payments.group.sendUnavailable")}
    describe={rail => rail === "lightning"
      ? t("payments.group.describe.lightning")
      : rail === "cashu" ? t("payments.group.describe.cashu") : t("payments.group.describe.other")}
    onSend={async () => t("payments.group.chooseOne")}
    onRequest={async (amount, memo, _method, rail, network, card) => {
      try { await engine.call("requestGroupPayment", { groupId: group.id, amount, memo: memo || undefined, timestamp: Date.now(), rail: rail === "lightning" ? "lightning" : "cashu", ...(network ? { network } : {}), ...(card ? { card } : {}) }); return null; }
      catch (e) { return errorText(e, t); }
    }} />;

  const member = to ? others.find(m => m.key === to) : undefined;
  const found = member && linkOf(member);
  const link = found ?? (member && community ? { id: pairLinkId(group.id, member.key), peerPubKeyZ32: member.key } : undefined);
  if (member && link) return <PaymentComposer balance={balance} contact={memberName(member, t)} onBack={() => setTo(null)} onClose={onClose}
    reviewContext={wallet ? { wallet, peer: link.peerPubKeyZ32, linkId: link.id } : undefined}
    onSend={async (amount, memo, network, confirmedReal) => {
      try { await engine.call("sendPayment", { linkId: link.id, amount, memo: memo || undefined, timestamp: Date.now(), ...(network ? { network } : {}), ...(confirmedReal ? { confirmedReal: true as const } : {}) }); return null; } catch (e) { return errorText(e, t); }
    }}
    onRequest={async (amount, memo, method, rail, network, card) => {
      // One way of paying per request, the card's: a Cashu request carries no invoice, a Lightning one no ecash.
      const only = rail === "lightning" ? "lightning" : rail === "cashu" ? "cashu" : undefined;
      try { await engine.call("requestPayment", { linkId: link.id, amount, memo: memo || undefined, timestamp: Date.now(), method, ...(only ? { rail: only } : {}), ...(network ? { network } : {}), ...(card ? { card } : {}) }); return null; }
      catch (e) { return errorText(e, t); }
    }} />;

  return <>
    <div className="sheet-backdrop" />
    <div ref={ref} data-testid="group-pay-recipients" onKeyDown={e => e.key === "Escape" && onClose()}
      className="sheet sheet-padded absolute bottom-full start-0 mb-2 z-50 animate-fade-in w-[360px] max-w-[calc(100vw-1.5rem)] max-md:max-w-none bg-panel-header border border-border rounded-2xl shadow-2xl p-3">
      <p className="m-0 px-1 text-sm font-semibold text-text-primary">{t("payments.mode.pay")}</p>
      <p className="m-0 px-1 text-xs text-text-muted">{community
        ? t("payments.group.hint.community")
        : t("payments.group.hint.mesh")}</p>
      <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
        {others.map(m => {
          const reason = why(m);
          return <li key={m.key}>
            <button type="button" data-testid="group-pay-recipient" data-key={m.key} disabled={!!reason} title={reason} onClick={() => setTo(m.key)}
              className="flex w-full min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50">
              <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${edgeDot(m)}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text-primary">{memberName(m, t)}</span>
                {reason && <span className="block truncate text-[11px] text-text-muted">{reason}</span>}
              </span>
            </button>
          </li>;
        })}
        <li className="border-t border-border pt-1">
          <button type="button" data-testid="group-pay-everyone" disabled={others.length === 0} onClick={() => setTo(EVERYONE)}
            className="flex w-full min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-surface-hover disabled:opacity-50">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-text-primary">{t("payments.group.everyone")}</span>
              <span className="block text-[11px] text-text-muted">{t("payments.group.everyoneHint")}</span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  </>;
}
