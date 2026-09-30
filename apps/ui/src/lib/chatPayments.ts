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

/**
 * The network tab a chat's payment sheet showed last (Mainnet | Testnet), remembered per chat (and per profile). The
 * tab only chooses which cards the sheet shows: every card pays on its own network whichever tab is open.
 */
const networkKey = (chat: string) => `${getPrefix()}payment_network_${chat}`;

export function rememberNetwork(chat: string | undefined, network: WalletNetwork): void {
  if (!chat) return;
  try { localStorage.setItem(networkKey(chat), network); } catch { /* storage unavailable: nothing is remembered */ }
}

/**
 * The tab a chat's payment sheet opens on, among the networks of your wallets (`cards`, in the deck's order):
 * - the one this chat used last (its tab, or the network of its last card; a rail from before networks, the network
 *   of that rail's first card), while you still have a wallet there;
 * - else the one network the contact takes that you have a wallet on (`theirs`: for each way of paying, the contact's
 *   networks; `accepted`: the ways it takes in this chat, when known);
 * - else Mainnet when you have a Mainnet wallet, else Testnet.
 */
export function startNetwork(chat: string | undefined, cards: readonly { rail: string; network: WalletNetwork }[], theirs?: Partial<Record<string, readonly WalletNetwork[]>>, accepted?: Partial<Record<string, boolean>>): WalletNetwork {
  const mine = new Set(cards.map((c) => c.network));
  let tab: string | null = null;
  if (chat) try { tab = localStorage.getItem(networkKey(chat)); } catch { /* storage unavailable */ }
  const [rail, network] = rememberedRail(chat)?.split(":") ?? [];
  const last = tab ?? network ?? cards.find((c) => c.rail === rail)?.network;
  const used = [...mine].find((n) => n === last);
  if (used) return used;
  const taken = new Set(Object.entries(theirs ?? {}).filter(([method]) => accepted?.[method] !== false).flatMap(([, networks]) => networks ?? []));
  const both = [...mine].filter((n) => taken.has(n));
  if (both.length === 1) return both[0];
  return mine.has("mainnet") ? "mainnet" : "testnet";
}
