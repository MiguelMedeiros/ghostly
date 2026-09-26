import { useRef, useState } from "react";
import { WALLET_NETWORKS, type PaymentMethodName } from "@ghostly/core";
import { useI18n } from "../contexts/I18nContext";
import { ALL_METHODS_ON, cardOn, type ChatAccepts, type ChatPaymentNetworks } from "../lib/chatPayments";
import type { PeerLinkState } from "../lib/platform";
import { CardDeck } from "./WalletDeck";
import type { InstanceCard } from "./walletCardData";

/** A card's test id on the Accept side: its kind and its network (`payment-accept-cashu-testnet`). */
export const acceptCardTestId = (id: string) => `payment-accept-${id.replace(":", "-")}`;

/**
 * The payment composer's Accept side (PaymentComposer.tsx): which ways of paying this chat accepts from the contact,
 * chosen on the same cards as paying, any number of them. Each card is one wallet on one network, so Testnet Cashu
 * can be on while Mainnet Cashu is off. A card that is on sits a little raised and wears a check; a click (or Space)
 * turns one on or off, and every card stays here, so one turned off can be turned on again. Nothing is paid or asked
 * for here. Save tells the contact: at once when the chat is connected, otherwise in the next handshake. Only this
 * chat changes.
 *
 * It edits the engine's per-chat lists (`paymentMethods`, and `paymentNetworks` for each way's networks): a way works
 * only when both sides have it on, on a network both have, so one turned off here is not used to pay the contact
 * either, and the hints say so.
 */
export function ChatPaymentAccept({ peer, contact, cards, onSave }: {
  peer: PeerLinkState | null | undefined;
  /** Who the chat is with, as the chat shows them. */
  contact: string;
  /** Every card of the wallet, in its order. */
  cards: InstanceCard[];
  onSave: (accepts: ChatAccepts) => Promise<void>;
}) {
  const { t } = useI18n();
  const saved = { paymentMethods: peer?.paymentMethods ?? ALL_METHODS_ON, paymentNetworks: peer?.paymentNetworks };
  const on = (card: InstanceCard, from: typeof saved) => cardOn(from, card.rail, card.network);
  /** The cards turned on, by id: what the deck shows checked. */
  const [draft, setDraft] = useState<Record<string, boolean>>(() => Object.fromEntries(cards.map((c) => [c.id, on(c, saved)])));
  // The deck starts on the first card that is on: the ones this chat uses come first to the eye.
  const [active, setActive] = useState<string>(() => cards.find((c) => on(c, saved))?.id ?? cards[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const changed = cards.some((c) => draft[c.id] !== on(c, saved));
  const connected = peer?.dataLink === "open";
  /** What the contact said, known only for a card this chat has on (the engine shows what both sides allow). */
  const theirs = (card: InstanceCard): "on" | "off" | "unknown" => {
    if (!on(card, saved) || !connected || !peer?.capabilities?.methods) return "unknown";
    const networks = peer.capabilities.networks;
    return peer.capabilities.methods[card.rail] && (!networks || (networks[card.rail] ?? []).includes(card.network)) ? "on" : "off";
  };

  const shown = cards.map((card) => ({
    ...card,
    status: t(draft[card.id] ? "payments.accept.on" : "payments.accept.off"),
    detail: theirs(card) === "on" ? t("payments.accept.contactOn") : theirs(card) === "off" ? t("payments.accept.contactOff") : card.detail,
  }));
  const card = cards.find((c) => c.id === active);
  const hint = (card: InstanceCard) => {
    const params = { card: card.network === "testnet" ? `Testnet ${card.name}` : card.name, name: contact };
    if (!draft[card.id]) return t("payments.accept.hint.off", params);
    if (!on(card, saved)) return t("payments.accept.hint.onceSaved", params);
    const said = theirs(card);
    return t(said === "on" ? "payments.accept.hint.both" : said === "off" ? "payments.accept.hint.theyOff" : "payments.accept.hint.unknown", params);
  };
  const state = error ? "error" : busy ? "saving" : changed ? "changed" : done ? "saved" : "idle";
  const status = state === "error" ? undefined
    : state === "changed" || state === "saving" ? t("payments.accept.status.changed", { name: contact })
    : state === "saved" ? t(connected ? "payments.accept.status.savedLive" : "payments.accept.status.savedLater", { name: contact })
    : t("payments.accept.status.idle");
  const saveRef = useRef<HTMLButtonElement>(null);

  const toggle = (id: string) => {
    if (busy) return;
    setDraft((d) => ({ ...d, [id]: !d[id] }));
    setDone(false); setError("");
  };
  /**
   * The draft as the engine keeps it: a way of paying is on when one of its cards is, and on the networks of the
   * cards that are. A network with no card here (no wallet of it yet) keeps its place in the list, for when the way
   * is on again; a way with no card at all keeps what the chat had.
   */
  const accepts = (): ChatAccepts => {
    const methods = { ...ALL_METHODS_ON, ...saved.paymentMethods };
    const networks: ChatPaymentNetworks = {};
    for (const method of new Set(cards.map((c) => c.rail))) {
      const mine = cards.filter((c) => c.rail === method);
      const kept = WALLET_NETWORKS.filter((n) => !mine.some((c) => c.network === n) && cardOn(saved, method, n));
      const onNow = mine.filter((c) => draft[c.id]).map((c) => c.network);
      methods[method as PaymentMethodName] = onNow.length > 0;
      networks[method as PaymentMethodName] = WALLET_NETWORKS.filter((n) => onNow.includes(n) || kept.includes(n));
    }
    return { methods, networks };
  };
  const save = () => {
    setBusy(true); setError("");
    void onSave(accepts()).then(() => {
      setDone(true); setBusy(false);
      // Save goes grey once saved: the keyboard goes back to the cards rather than out of the sheet.
      const at = document.activeElement;
      if (!at || at === document.body || at === saveRef.current) saveRef.current?.closest(".composer-sheet")?.querySelector<HTMLElement>('[role=checkbox][tabindex="0"]')?.focus({ preventScroll: true });
    }, (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setBusy(false); });
  };

  return <>
    <CardDeck<string> compact tagAll kind="checks" label={t("payments.accept.deck", { name: contact })} name="payment-accept-deck" cards={shown} selected={active}
      onSelect={setActive} onChoose={toggle} checked={(c) => !!draft[c.id]} testId={acceptCardTestId} size={{ max: 250, share: .62 }} />
    <p className="composer-sheet-hint" data-testid="payment-accept-hint">{card && hint(card)}</p>
    <p className="payment-accept-status" data-testid="payment-accept-status" data-state={state} role="status">{status}</p>
    {error && <p role="alert" className="text-danger text-xs m-0">{error}</p>}
    <button ref={saveRef} type="button" data-testid="payment-accept-save" className="composer-sheet-action" disabled={!changed || busy} onClick={save}>
      {t(busy ? "payments.accept.saving" : "payments.accept.save")}
    </button>
  </>;
}
