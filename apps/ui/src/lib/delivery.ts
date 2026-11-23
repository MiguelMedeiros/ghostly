import { useSyncExternalStore } from "react";
import { DHT_EDIT_FITS, DHT_PACKET_BUDGET, DHT_TEXT_FITS, MESSAGE_PACED } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { NotSent } from "@ghostly/browser/engine/outbox";
import { useI18n, type Translate } from "../contexts/I18nContext";
import { useOnline } from "../hooks/useOnline";
import { rawError } from "./errorText";
import type { PeerLinkState } from "./platform";
import { problemLine } from "./problemText";
import type { ChatMessage } from "./types";

export type Delivery = NonNullable<ChatMessage["delivery"]>;

/** The four marks a message of mine can carry, WhatsApp's: a clock, one tick, two ticks, a red circle. */
export type DeliveryShape = "pending" | "sent" | "delivered" | "failed";

/**
 * Where a message of mine is, as one mark. Without a delivery state (older messages), the contact's receipt
 * (`acked`) says whether it has two ticks or one.
 */
export function deliveryShape(delivery: ChatMessage["delivery"], acked = false): DeliveryShape {
  switch (delivery) {
    case "sending": case "queued": case "waiting": case "held": return "pending";
    case "failed": return "failed";
    case "delivered": return "delivered";
    case "sent": return "sent";
    default: return acked ? "delivered" : "sent";
  }
}

/** Who set a chat to DHT only: this side, or the contact. Such a chat does not go live until that side leaves it. */
export type DhtOnlyBy = "you" | "contact";

const subscribe = (listener: () => void) => engine.subscribe(listener);

/**
 * Whether this chat is on DHT only by choice, and whose, by the rule the chat's header says it with (lib/contactStatus):
 * this side's choice first, the one to change here; the contact's while the chat's texts go through the DHT for it.
 */
export function useDhtOnly(peerPubKey?: string): DhtOnlyBy | undefined {
  return useSyncExternalStore(subscribe, () => {
    const link = peerPubKey ? engine.linkByPeer(peerPubKey) : undefined;
    return link?.deliveryMode === "dht" ? "you" : link?.textDelivery === "dht" && link.dhtDelivery?.peerMode === "dht" ? "contact" : undefined;
  });
}

/**
 * What a waiting message of mine waits for when it is not the contact: a file in a DHT-only chat needs a live
 * connection, which the chat does not make until the side that chose DHT only leaves it. Online or not changes nothing.
 */
export function waitsForLive(message: Pick<ChatMessage, "delivery" | "file"> | undefined, dhtOnly: DhtOnlyBy | undefined): DhtOnlyBy | undefined {
  return message?.delivery === "waiting" && message.file ? dhtOnly : undefined;
}

/**
 * What a waiting text of mine waits for when the contact is online, by why it waits (its `deliveryError`): room in the
 * contact's windows (`MESSAGE_PACED`), or the texts before it, which it never passes (`NotSent.BEHIND`). Its mark's
 * keys, named whole so the keys test sees them asked for.
 */
function waitsFor(delivery: Delivery, error?: string) {
  if (delivery !== "waiting") return undefined;
  return error === MESSAGE_PACED ? { label: "chat.delivery.waitingPaced", hint: "chat.delivery.hint.waitingPaced" } as const
    : error === NotSent.BEHIND ? { label: "chat.delivery.waitingBehind", hint: "chat.delivery.hint.waitingBehind" } as const
    : undefined;
}

type DhtLink = Pick<PeerLinkState, "deliveryMode" | "textDelivery" | "dhtDelivery"> | null | undefined;

/**
 * What the engine does with a text, or an edit, past what the DHT packet carries (engine/node.ts sendChatText,
 * editMessage), said on the composer's count before Send and in place of its refusal (`refusalLine`) after it. A text
 * goes held where both sides allow it, and waits for live with no DHT to carry it. On the DHT, in a chat on DHT only
 * by choice (either side's: `dhtByChoice`) a text within 256 bytes and an edit are refused, and a longer text waits for
 * a live connection that chat never makes: either way the next step is to shorten it or end DHT only, by whose choice
 * keeps it. In a chat that goes live, a text or an edit that long waits for live.
 */
export function dhtOverLine(t: Translate, link: DhtLink, edit: boolean): string {
  const fits = edit ? DHT_EDIT_FITS : DHT_TEXT_FITS;
  const mine = link?.deliveryMode === "dht", theirs = link?.dhtDelivery?.peerMode === "dht";
  if (!edit && link?.textDelivery === "hold") return t("composer.dhtFits.held", { fits });
  if (!edit && link?.textDelivery !== "dht") return t("composer.overSoft", { bytes: fits });
  if (mine && theirs) return t("composer.dhtFits.both", { fits });
  if (mine) return t("composer.dhtFits.you", { fits });
  if (theirs) return t("composer.dhtFits.contact", { fits });
  return edit ? t("composer.dhtFits.editLive", { fits }) : t("composer.overSoft", { bytes: fits });
}

/**
 * A send or an edit the engine refused, as one line (`problemLine`). A text or an edit the DHT packet cannot carry
 * (core `DHT_PACKET_BUDGET`), refused only in a chat on DHT only, says it as the composer's count said it before Send
 * (`dhtOverLine`): about how much fits, and what ends DHT only. "Once you're connected peer to peer" never comes there
 * until the side(s) that chose it leave it.
 */
export function refusalLine(cause: unknown, t: Translate, link: DhtLink, edit: boolean): string {
  const dhtOnly = link?.deliveryMode === "dht" || link?.dhtDelivery?.peerMode === "dht";
  // Refused, it went to the DHT whatever the view said a moment before (held, or no DHT yet).
  return dhtOnly && rawError(cause) === DHT_PACKET_BUDGET ? dhtOverLine(t, { ...link, textDelivery: "dht" }, edit) : problemLine(cause, t);
}

/**
 * The mark's short name (its accessible name) and the one line its tooltip says. `live`: the message waits for a live
 * connection this DHT-only chat does not make (see `waitsForLive`), not for the contact to be online. With this device
 * offline, a message not sent yet waits for this device, not the contact: it says so (one the contact's hold keeps
 * already went). `error`: why it waits (`waitsFor`), when the contact may well be online.
 */
export function useDeliveryWords() {
  const { t } = useI18n();
  const online = useOnline();
  const offline = (delivery: Delivery, live?: DhtOnlyBy) => !online && !live && (delivery === "waiting" || delivery === "sending" || delivery === "queued");
  return {
    label: (delivery: Delivery, live?: DhtOnlyBy, error?: string) =>
      offline(delivery, live) ? t("chat.delivery.offline")
      : delivery === "waiting" && live ? t("chat.delivery.waitingLive")
      : waitsFor(delivery, error) ? t(waitsFor(delivery, error)!.label)
      : delivery === "waiting" || delivery === "held" ? t("chat.delivery.waiting")
      : delivery === "sending" || delivery === "queued" ? t("chat.delivery.sending")
      : delivery === "failed" ? t("chat.delivery.failed")
      : delivery === "delivered" ? t("chat.delivery.delivered")
      : t("chat.delivery.sent"),
    /** `group`: a group's message, which no member's app confirms (WISP 902: a group has no receipts). */
    hint: (delivery: Delivery, live?: DhtOnlyBy, group?: boolean, error?: string) =>
      offline(delivery, live) ? t("chat.delivery.hint.offline")
      : group && delivery === "sent" ? t("chat.delivery.hint.sentGroup")
      : delivery === "waiting" && live ? t(live === "you" ? "chat.delivery.hint.waitingLiveYou" : "chat.delivery.hint.waitingLiveContact")
      : waitsFor(delivery, error) ? t(waitsFor(delivery, error)!.hint)
      : t(`chat.delivery.hint.${delivery}`),
    retry: t("chat.delivery.retry"),
  };
}

