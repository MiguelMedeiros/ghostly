import { useState } from "react";
import { useI18n } from "../contexts/I18nContext";
import { ALL_METHODS_ON, type ChatPaymentMethods } from "../lib/chatPayments";
import type { PeerLinkState } from "../lib/platform";
import { CardDeck } from "./WalletDeck";
import { WALLET_RAILS, type WalletCard, type WalletRail } from "./walletCardTypes";

/**
 * The payment composer's Accept side (PaymentComposer.tsx): which ways of paying this chat accepts from the contact,
 * chosen on the same cards as paying, any number of them. A card that is on sits a little raised and wears a check;
 * a click (or Space) turns one on or off, and every card stays here, so one turned off can be turned on again.
 * Nothing is paid or asked for here. Save tells the contact: at once when the chat is connected, otherwise in the
 * next handshake. Only this chat changes.
 *
 * It is the same list the chat's ⋮ → Payments dialog edits (the engine's per-chat `paymentMethods`): a way works
 * only when both sides have it on, so one turned off here is not used to pay the contact either, and the hints say so.
 */
export function ChatPaymentAccept({ peer, contact, cards, onSave }: {
  peer: PeerLinkState | null | undefined;
  /** Who the chat is with, as the chat shows them. */
  contact: string;
  /** Every card of the wallet, in its order. */
  cards: WalletCard[];
  onSave: (methods: ChatPaymentMethods) => Promise<void>;
}) {
  const { t } = useI18n();
  const saved = peer?.paymentMethods ?? ALL_METHODS_ON;
  const [draft, setDraft] = useState<ChatPaymentMethods>(saved);
  // The deck starts on the first card that is on: the ones this chat uses come first to the eye.
  const [active, setActive] = useState<WalletRail>(() => cards.find((c) => saved[c.id])?.id ?? cards[0]?.id ?? "cashu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const changed = WALLET_RAILS.some((id) => draft[id] !== saved[id]);
  const connected = peer?.dataLink === "open";
  /** What the contact said, known only for a way this chat has on (the engine shows what both sides allow). */
  const theirs = (id: WalletRail): "on" | "off" | "unknown" => !saved[id] || !connected || !peer?.capabilities?.methods ? "unknown" : peer.capabilities.methods[id] ? "on" : "off";

  const shown = cards.map((card) => ({
    ...card,
    status: t(draft[card.id] ? "payments.accept.on" : "payments.accept.off"),
    detail: theirs(card.id) === "on" ? t("payments.accept.contactOn") : theirs(card.id) === "off" ? t("payments.accept.contactOff") : card.detail,
  }));
  const card = cards.find((c) => c.id === active);
  const hint = (id: WalletRail, name: string) => {
    const params = { card: name, name: contact };
    if (!draft[id]) return t("payments.accept.hint.off", params);
    if (!saved[id]) return t("payments.accept.hint.onceSaved", params);
    const said = theirs(id);
    return t(said === "on" ? "payments.accept.hint.both" : said === "off" ? "payments.accept.hint.theyOff" : "payments.accept.hint.unknown", params);
  };
  const status = error ? undefined
    : changed ? t("payments.accept.status.changed", { name: contact })
    : done ? t(connected ? "payments.accept.status.savedLive" : "payments.accept.status.savedLater", { name: contact })
    : t("payments.accept.status.idle");

  const toggle = (id: WalletRail) => {
    if (busy) return;
    setDraft((d) => ({ ...d, [id]: !d[id] }));
    setDone(false); setError("");
  };
  const save = () => {
    setBusy(true); setError("");
    void onSave(draft).then(() => { setDone(true); setBusy(false); }, (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setBusy(false); });
  };

  return <>
    <CardDeck compact kind="checks" label={t("payments.accept.deck", { name: contact })} name="payment-accept-deck" cards={shown} selected={active}
      onSelect={setActive} onChoose={toggle} checked={(c) => draft[c.id]} testId={(id) => `payment-accept-${id}`} size={{ max: 250, share: .62 }} />
    <p className="composer-sheet-hint" data-testid="payment-accept-hint">{card && hint(card.id, card.name)}</p>
    <p className="payment-accept-status" data-testid="payment-accept-status" role="status">{status}</p>
    {error && <p role="alert" className="text-danger text-xs m-0">{error}</p>}
    <button type="button" data-testid="payment-accept-save" className="composer-sheet-action" disabled={!changed || busy} onClick={save}>
      {t(busy ? "payments.accept.saving" : "payments.accept.save")}
    </button>
  </>;
}
