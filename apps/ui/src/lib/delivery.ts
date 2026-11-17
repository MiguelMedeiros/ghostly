import { useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n, type Translate } from "../contexts/I18nContext";
import { useOnline } from "../hooks/useOnline";
import type { PeerLinkState } from "./platform";
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
 * About the longest ASCII text, and edit, the DHT packet carries once sealed: within its 256 bytes, the envelope's
 * authentication (and an edit's element) takes the rest. The CLI says the same (packages/cli/src/api.ts DHT_TEXT_FITS,
 * DHT_EDIT_FITS); quotes, backslashes and new lines take more once escaped, so it is "about".
 */
export const DHT_FITS = { text: 248, edit: 214 } as const;

/**
 * What the engine does with a text, or an edit, past what the DHT packet carries (engine/node.ts sendChatText,
 * editMessage), said on the composer's count before Send and in place of its refusal (DHT_PACKET_BUDGET) after it.
 * A text goes held where both sides allow it; a chat on DHT only by choice refuses it, or keeps it for a live connection
 * it never makes, until the side that chose leaves it; otherwise a text past 256 bytes waits for live, one within them is
 * refused, and an edit waits for live.
 */
export function dhtOverLine(t: Translate, link: Pick<PeerLinkState, "deliveryMode" | "textDelivery" | "dhtDelivery"> | null | undefined, bytes: number, edit: boolean): string {
  const fits = edit ? DHT_FITS.edit : DHT_FITS.text;
  if (!edit && link?.textDelivery === "hold") return t("composer.dhtFits.held", { fits });
  if (link?.deliveryMode === "dht") return t("composer.dhtFits.you", { fits });
  if (link?.dhtDelivery?.peerMode === "dht") return t("composer.dhtFits.contact", { fits });
  if (edit) return t("composer.dhtFits.editLive", { fits });
  return bytes > (link?.dhtDelivery?.maxTextBytes ?? 256) ? t("composer.overSoft", { bytes: fits }) : t("composer.dhtFits.live", { fits });
}

/**
 * The mark's short name (its accessible name) and the one line its tooltip says. `live`: the message waits for a live
 * connection this DHT-only chat does not make (see `waitsForLive`), not for the contact to be online. With this device
 * offline, a message not sent yet waits for this device, not the contact: it says so (one the contact's hold keeps
 * already went).
 */
export function useDeliveryWords() {
  const { t } = useI18n();
  const online = useOnline();
  const offline = (delivery: Delivery, live?: DhtOnlyBy) => !online && !live && (delivery === "waiting" || delivery === "sending" || delivery === "queued");
  return {
    label: (delivery: Delivery, live?: DhtOnlyBy) =>
      offline(delivery, live) ? t("chat.delivery.offline")
      : delivery === "waiting" && live ? t("chat.delivery.waitingLive")
      : delivery === "waiting" || delivery === "held" ? t("chat.delivery.waiting")
      : delivery === "sending" || delivery === "queued" ? t("chat.delivery.sending")
      : delivery === "failed" ? t("chat.delivery.failed")
      : delivery === "delivered" ? t("chat.delivery.delivered")
      : t("chat.delivery.sent"),
    /** `group`: a group's message, which no member's app confirms (WISP 902: a group has no receipts). */
    hint: (delivery: Delivery, live?: DhtOnlyBy, group?: boolean) =>
      offline(delivery, live) ? t("chat.delivery.hint.offline")
      : group && delivery === "sent" ? t("chat.delivery.hint.sentGroup")
      : delivery === "waiting" && live ? t(live === "you" ? "chat.delivery.hint.waitingLiveYou" : "chat.delivery.hint.waitingLiveContact")
      : t(`chat.delivery.hint.${delivery}`),
    retry: t("chat.delivery.retry"),
  };
}

