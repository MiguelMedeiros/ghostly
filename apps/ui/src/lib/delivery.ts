import { useI18n } from "../contexts/I18nContext";
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

/** The mark's short name (its accessible name) and the one line its tooltip says. */
export function useDeliveryWords() {
  const { t } = useI18n();
  return {
    label: (delivery: Delivery) =>
      delivery === "waiting" || delivery === "held" ? t("chat.delivery.waiting")
      : delivery === "sending" || delivery === "queued" ? t("chat.delivery.sending")
      : delivery === "failed" ? t("chat.delivery.failed")
      : delivery === "delivered" ? t("chat.delivery.delivered")
      : t("chat.delivery.sent"),
    hint: (delivery: Delivery) => t(`chat.delivery.hint.${delivery}`),
    retry: t("chat.delivery.retry"),
  };
}

