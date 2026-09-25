import type { PaymentMethodName } from "@ghostly/core";
import { getPrefix } from "./storage";

/** Which ways of paying one chat allows (the engine's per-chat `paymentMethods`). */
export type ChatPaymentMethods = Record<PaymentMethodName, boolean>;
/** A chat nobody has chosen for yet allows every way of paying. */
export const ALL_METHODS_ON: ChatPaymentMethods = { cashu: true, lightning: true, arkade: true, bark: true, spark: true, bitcoin: true, fedimint: true, usdt: true };

/**
 * The card a chat's payment composer last turned over, remembered per chat (and per profile): the composer starts
 * there next time, when it can still be used in that chat. Another chat keeps its own.
 */
const railKey = (chat: string) => `${getPrefix()}payment_rail_${chat}`;

export function rememberedRail(chat: string | undefined): string | null {
  if (!chat) return null;
  try { return localStorage.getItem(railKey(chat)); } catch { return null; }
}

export function rememberRail(chat: string | undefined, rail: string): void {
  if (!chat) return;
  try { localStorage.setItem(railKey(chat), rail); } catch { /* storage unavailable: nothing is remembered */ }
}
