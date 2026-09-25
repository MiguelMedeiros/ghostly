import type { WalletNetwork } from "@ghostly/core";
/**
 * Mints a new wallet starts with, so nobody has to know what a mint is before
 * receiving sats. The first one that answers is where Lightning invoices are
 * created; ecash from any of them is accepted from contacts.
 *
 * A mint is a custodian: it holds the sats. This list is a product decision,
 * to be reviewed regularly. It was picked on 2026-09-18 from the community
 * auditor (https://audit.8333.space): mints with thousands of audited swaps,
 * the highest success rates and an OK state at the time.
 */
export const DEFAULT_MINTS = [
  "https://mint.minibits.cash/Bitcoin",
  "https://21mint.me",
  "https://mint.mountainlake.io",
];

/** Public test mint: worthless sats, invoices settle by themselves. */
export const TEST_MINT = "https://testnut.cashu.space";

/**
 * Mints whose sats are worth nothing: never counted as money, never mixed with real sats.
 * Mutinynet's mint (cashu.mutinynet.com) would belong here, but on 2026-09-22 it answered with a
 * duplicated Access-Control-Allow-Origin header that every browser and WebView rejects.
 */
export const TEST_MINTS: readonly string[] = [TEST_MINT];
export const isTestMint = (url: string) => TEST_MINTS.includes(url.replace(/\/+$/, ""));

/** A mint on this very machine (a local test server): whatever it issues is not money anyone else holds. */
export function isLocalMint(url: string): boolean {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname); } catch { return false; }
}

/**
 * Mints whose sats are worth nothing: the public test mints and mints on this machine. They belong to
 * the Testnet mode, and their ecash never settles a request for real sats. Only the public test mints
 * are ever added by themselves (a contact must not make this app contact a port on this machine).
 */
export const isWorthlessMint = (url: string) => isTestMint(url) || isLocalMint(url);

/** Real money, or test networks: each wallet has its own (see WalletNetwork in @ghostly/core). */
export type WalletMode = WalletNetwork;
/** The network a Cashu mint's ecash belongs to: test mints and mints on this machine are Testnet. */
export const mintNetwork = (url: string): WalletNetwork => isWorthlessMint(url) ? "testnet" : "mainnet";
