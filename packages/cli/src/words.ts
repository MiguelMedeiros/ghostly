/**
 * The words the wallet, payment and chat commands take, in a module of their own: the command table (read by every
 * command) checks them before the profile opens, without loading wallets.ts and the engine behind it, and the API
 * checks the same lists for socket callers.
 */
export const NETWORKS = ["mainnet", "testnet"] as const;
export const WALLET_TYPES = ["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"] as const;
/** The ways a request may ask to be paid besides Lightning. */
export const PAYMENT_METHODS = ["cashu", "arkade", "usdt", "bark", "bitcoin", "fedimint", "spark"] as const;
/** The ways of paying a chat takes (`chat accept`). */
export const CHAT_METHODS = ["cashu", "lightning", ...PAYMENT_METHODS.filter((m) => m !== "cashu")] as const;
/** The wallets that give an address to be paid on. */
export const ADDRESS_TYPES = ["bitcoin", "arkade", "spark", "usdt"] as const;
/** What may carry a chat (`chat transport`). */
export const TRANSPORTS = ["auto", "dht", "webrtc", "iroh", "hyperdht"] as const;
