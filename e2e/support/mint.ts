import type { BrowserContext } from "@playwright/test";

/**
 * The public Cashu test mint — or a mint of our own answering in its place.
 *
 * These tests need a real mint: worthless sats, and invoices that settle by
 * themselves. `testnut.cashu.space` is one, but it is a single volunteer's
 * server, and GitHub's runners cannot reach it: the wallet tests failed every
 * attempt of every run while the other mints on the same page loaded, and the
 * release ships nothing unless they pass. A release gate cannot depend on one
 * machine nobody here owns.
 *
 * So CI runs its own and points `E2E_MINT_URL` at it: `cashubtc/mintd` with
 * the fake Lightning backend, which is what the public test mint is (it
 * answers `cdk-mintd/0.17`). The implementation matters — a mint that refuses
 * to quote an invoice whose mint quote was already issued cannot stand in for
 * it, and Nutshell refuses.
 *
 * Requests to the public mint are then answered from there, the way
 * support/relay.ts answers the Pkarr relays. The app is never told: it still
 * adds, spends and quotes `testnut.cashu.space`, so what these tests exercise
 * is exactly what they exercised before. Without `E2E_MINT_URL` the public
 * mint answers for itself, as it always did.
 */

/** What the app knows as its test mint, and what a token minted for it says. */
export const TEST_MINT = "https://testnut.cashu.space";

const requests = /^https:\/\/testnut\.cashu\.space(\/|$)/;

/**
 * Where the bytes actually go. The test process talks to this; the browser
 * goes on addressing `TEST_MINT` and is redirected under it.
 */
export const mintEndpoint = (): string => (process.env.E2E_MINT_URL || TEST_MINT).replace(/\/+$/, "");

/** The mints a Mainnet Cashu wallet starts with (packages/browser/src/shared/mints.ts DEFAULT_MINTS). */
export const MAINNET_MINTS = ["https://mint.minibits.cash/Bitcoin", "https://21mint.me", "https://mint.mountainlake.io"];

/**
 * Mainnet creation without Mainnet: the default mints are answered by the suite's own mint (fake Lightning,
 * worthless sats), so a Mainnet Cashu wallet can be made and shown with no real mint, and no real money, reached.
 * The first one answers; the others are refused, as mints that are down.
 */
export async function mockMainnetMints(context: BrowserContext): Promise<void> {
  const endpoint = mintEndpoint();
  const [first, ...others] = MAINNET_MINTS;
  const base = new URL(first);
  await context.route((url) => url.origin === base.origin && url.pathname.startsWith(base.pathname), async (route) => {
    const { pathname, search } = new URL(route.request().url());
    const response = await route.fetch({ url: `${endpoint}${pathname.slice(base.pathname.length)}${search}`, timeout: 60_000 }).catch(() => null);
    if (response) await route.fulfill({ response }).catch(() => {});
    else await route.abort("timedout").catch(() => {});
  });
  for (const mint of others) await context.route((url) => url.origin === new URL(mint).origin, (route) => route.abort("connectionrefused"));
}

/** Answers this context's requests to the public test mint, when one of ours is running. */
export async function attachMint(context: BrowserContext): Promise<void> {
  const endpoint = mintEndpoint();
  if (endpoint === TEST_MINT) return;
  await context.route(requests, async (route) => {
    const { pathname, search } = new URL(route.request().url());
    // A mint slow to answer (mintd under load takes seconds for /v1/info now and then) is a slow mint to the
    // app, which retries: not an error of the test that happened to be running while the app polled it.
    const response = await route.fetch({ url: `${endpoint}${pathname}${search}`, timeout: 60_000 }).catch(() => null);
    if (response) await route.fulfill({ response }).catch(() => {});
    else await route.abort("timedout").catch(() => {});
  });
}
