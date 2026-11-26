import { useSyncExternalStore } from "react";
import { DHT_PACKET_BUDGET, MESSAGE_PACED } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { NotSent } from "@ghostly/browser/engine/outbox";
import { useI18n, type Translate } from "../contexts/I18nContext";
import { useOnline } from "../hooks/useOnline";
import { rawError } from "./errorText";
import { problemLine, sentences } from "./problemText";
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
 * Whether this chat opens no live session because one side chose DHT only, and whose choice, by the engine's rule
 * (`GhostLink.streamBlocked`): mine first, else the contact's, whatever way the chat's texts go meanwhile (held ones
 * too, which the header names instead). What goes on the live session only waits for that side: my removal of a
 * message (Delete for everyone) is neither held nor said on the DHT.
 */
export function useLiveBlocked(peerPubKey?: string): DhtOnlyBy | undefined {
  return useSyncExternalStore(subscribe, () => {
    const link = peerPubKey ? engine.linkByPeer(peerPubKey) : undefined;
    return link?.deliveryMode === "dht" ? "you" : link?.dhtDelivery?.peerMode === "dht" ? "contact" : undefined;
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

/**
 * A send or an edit the engine refused, as one line (`problemLine`). A text the DHT packet cannot carry (core
 * `DHT_PACKET_BUDGET`) in a chat on DHT only says what ends DHT only: "once you're connected peer to peer" never comes
 * there until the side that chose it leaves it.
 */
export function refusalLine(cause: unknown, t: Translate, dhtOnly: DhtOnlyBy | undefined): string {
  if (!dhtOnly || rawError(cause) !== DHT_PACKET_BUDGET) return problemLine(cause, t);
  return sentences(t("errors.chat.dhtTooLong"), t(dhtOnly === "you" ? "errors.chat.dhtTooLongYouNext" : "errors.chat.dhtTooLongContactNext"), t);
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

