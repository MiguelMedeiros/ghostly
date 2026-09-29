/**
 * "Get test coins": a Testnet wallet asks its own faucet for a small fixed amount, only when the person presses the
 * button. Receive never does (see StoredQuote `held`). A faucet behind a login or a CAPTCHA is never automated: the
 * page links to it instead (src/components/wallet/testCoins.ts).
 */

/** What one press asks a test mint for: small, fixed, worth nothing. */
export const TEST_COINS_SATS = 10_000;

/** A faucet's failure in words a person can act on: rate limited says to wait, anything else says what failed. */
export function faucetError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number } | null)?.status;
  if (status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message)) return new Error("Rate limited: the faucet is busy. Try again in a minute.");
  if (/failed to fetch|networkerror|did not answer|load failed/i.test(message)) return new Error(`The faucet did not answer: ${message}`);
  return new Error(`The faucet did not pay: ${message}`);
}
