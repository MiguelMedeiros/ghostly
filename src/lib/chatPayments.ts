import type { PaymentMethodName, WalletNetwork } from "@ghostly/core";
import { getPrefix } from "./storage";

/** Which ways of paying one chat allows (the engine's per-chat `paymentMethods`). */
export type ChatPaymentMethods = Record<PaymentMethodName, boolean>;
/** A chat nobody has chosen for yet allows every way of paying. */
export const ALL_METHODS_ON: ChatPaymentMethods = { cashu: true, lightning: true, arkade: true, bark: true, spark: true, bitcoin: true, fedimint: true, usdt: true };
/** For each way of paying, the networks one chat takes it on (the engine's per-chat `paymentNetworks`). */
export type ChatPaymentNetworks = Partial<Record<PaymentMethodName, WalletNetwork[]>>;
/** What the Accept side saves: the ways of paying, and for each the networks, of the cards turned on. */
export interface ChatAccepts { methods: ChatPaymentMethods; networks: ChatPaymentNetworks }
/** A card (one way of paying on one network) is on in this chat: its way of paying, and its network, are. */
export const cardOn = (chat: { paymentMethods?: Partial<ChatPaymentMethods>; paymentNetworks?: Partial<Record<PaymentMethodName, readonly WalletNetwork[]>> } | undefined, method: PaymentMethodName, network: WalletNetwork) =>
  chat?.paymentMethods?.[method] !== false && (chat?.paymentNetworks?.[method]?.includes(network) ?? true);

/**
 * The card a chat's payment composer last turned over, remembered per chat (and per profile): the composer starts
 * there next time, when it can still be used in that chat. Another chat keeps its own. It is a wallet's id
 * (`cashu:testnet`); a chat from before wallets had networks remembers a rail (`cashu`), read as that rail's card.
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
