import type { PairedTransport } from "@ghostly/core";

/**
 * The words an argument takes, for the API's methods and the command table both: the command line refuses any other
 * before the profile opens (`commands/index.ts` positionals), and the socket keeps its own refusal for its callers.
 * Its own module, with no code from the package: the command table is read by every command.
 */

export const WALLET_TYPES = ["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"] as const;
/** The wallets that have an address to be paid on (`wallet address`). */
export const ADDRESS_TYPES = ["bitcoin", "arkade", "spark", "usdt"] as const;
/** What a payment request may name as its way of paying (`chat request --method`). */
export const PAY_METHODS = ["cashu", "arkade", "usdt", "bark", "bitcoin", "fedimint", "spark"] as const;
/** The ways of paying a chat takes (`chat accept`). */
export const CHAT_METHODS = ["cashu", "lightning", ...PAY_METHODS.filter((m) => m !== "cashu")] as const;

/** A chat's transport by the name the command line gives it (`chat transport`). */
export const TRANSPORT_NAMES: Record<string, PairedTransport | "auto" | "dht"> = {
  auto: "auto", dht: "dht", webrtc: "webrtc/1", iroh: "iroh/1", hyperdht: "hyperdht/1",
  "webrtc/1": "webrtc/1", "iroh/1": "iroh/1", "hyperdht/1": "hyperdht/1",
};
