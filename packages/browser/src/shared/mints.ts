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
