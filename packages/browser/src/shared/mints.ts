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

/**
 * A mint whose word "this invoice is paid" proves nobody paid it. The public test mint runs a fake Lightning backend
 * that marks every invoice paid by itself, and a mint on this machine is a test server that may do the same. Its
 * invoices are still shown to be paid, but the wallet mints one only once a payer says it paid it (see `held` on
 * StoredQuote); asking it for test coins on purpose is `CashuWallet.testCoins`.
 */
export const paysItsOwnInvoices = isWorthlessMint;

/**
 * Mints on this machine the operator declared test servers with a fake Lightning backend (the CLI's
 * `GHOSTLY_TEST_MINTS`, for regtest and e2e stacks). Nothing else declares one: the apps never do.
 */
const declaredTestMints = new Set<string>();
const bare = (url: string) => url.trim().replace(/\/+$/, "");
export function declareTestMints(urls: readonly string[]): void {
  for (const url of urls) if (isLocalMint(bare(url))) declaredTestMints.add(bare(url));
}

/**
 * Whether a Testnet wallet may pay a Bitcoin (`lnbc`) invoice through this mint. Test mints issue `lnbc` invoices,
 * but so does a real node: only a mint known to fake its Lightning moves nothing real when it pays one. That is the
 * public test mint, or a mint on this machine the operator declared a test server; never any other mint on this
 * machine, which may be a self-hosted mint with real sats behind it.
 */
export const fakesLightning = (url: string) => isTestMint(url) || declaredTestMints.has(bare(url));

/** Refused before any mint is asked: see `fakesLightning`. */
export const BITCOIN_INVOICE_ON_TESTNET = "This is a Bitcoin invoice (real money): test sats pay one only through the public test mint. Nothing was sent.";

/** Real money, or test networks: each wallet has its own (see WalletNetwork in @ghostly/core). */
export type WalletMode = WalletNetwork;
/** The network a Cashu mint's ecash belongs to: test mints and mints on this machine are Testnet. */
export const mintNetwork = (url: string): WalletNetwork => isWorthlessMint(url) ? "testnet" : "mainnet";
