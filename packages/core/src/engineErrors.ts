/**
 * The engine's known errors: a stable code each, and its English text with the values in it. The engine throws
 * `engineError(code, values)`; the text is the one it always wrote, so the CLI and every log keep printing the same.
 * The app's pages get only the text (it crosses the engine's RPC and is kept on payments and operations as a string),
 * and `parseEngineError` finds the code and the values back in it, to say it in the app's language. A text that is
 * none of these (a mint's own words, a provider's) stays as it is.
 *
 * `{name}` in a template is a value: a host or domain (no spaces), a network ("Mainnet" or "Testnet"), a chain's name,
 * or an amount (digits, with the separators of whatever locale wrote it).
 */
export const ENGINE_ERRORS = {
  // Reaching a mint, a server, the network.
  mintUnreachable: "Could not reach {host}. Check the address: it should be a Cashu mint.",
  lnurlUnreachable: "Could not reach {host}. It may be down, or not allow web apps to read it (CORS).",
  hostUnreachable: "Could not reach {host}",
  networkUnreachable: "Could not reach the network",
  hostTimedOut: "{host} did not answer in time",
  networkTimedOut: "The network did not answer in time",
  // Cashu mints.
  testMintOnMainnet: "This is a test mint, and its sats are worth nothing: add it to a Testnet Cashu wallet",
  realMintOnTestnet: "This mint holds real sats: add it to a Mainnet Cashu wallet",
  mintHoldsSats: "Move your sats out of this mint before removing it",
  lastMint: "This is the last mint of your {network} Cashu wallet: remove the wallet to remove it",
  invalidMintUrl: "That is not a valid mint URL",
  mintNotHttps: "Mints must use https",
  notEnoughSats: "Not enough sats in your wallet",
  noSharedMint: "You share no mint with this contact",
  ecashAlreadySpent: "This ecash was already spent somewhere else",
  reviewedEcashSpent: "The ecash for this payment was already spent somewhere else. Nothing was sent, and your balance now shows what the mint still holds.",
  reviewedSatsGone: "The sats this payment was reviewed with went to another payment. Nothing was sent: review it again.",
  // Lightning.
  lightningFeeTooHigh: "The Lightning fee ({fee} sats) is too high",
  invoiceExpired: "That invoice has expired",
  lnurlExactly: "{domain} asks for exactly {amount} sats",
  lnurlRange: "{domain} takes between {min} and {max} sats",
  // A reviewed payment, from its review to its outcome (paymentAdapters/coordinator.ts, persistence.ts, node.ts).
  feeAboveLimit: "The fee exceeds your limit",
  cashuFeeAboveLimit: "Cashu fee exceeds your limit",
  invalidMaxFee: "Invalid maximum fee",
  methodUnavailable: "This payment method is unavailable",
  unknownPaymentIntent: "Unknown payment intent",
  paymentExpired: "Payment request expired or has an invalid expiry",
  requestHasPayment: "This request already has a payment. Reconcile it before trying again.",
  requestPaymentInFlight: "This request already has a payment; reconcile it instead",
  requestNotAwaiting: "This request is no longer awaiting payment. Check its status before spending.",
  reconnectBeforeApprove: "Reconnect the data link before approving. Your review was saved.",
  cannotSubmitAgain: "This payment cannot be submitted again. Reconcile its existing transaction.",
  alreadySubmitted: "This payment was already submitted or could not be saved",
  sentAfterReview: "A payment from this wallet was sent after this review was made. Create a new review",
  cannotCancelSubmitted: "A submitted payment cannot be cancelled; reconcile it instead",
  outcomeUnknown: "Outcome unknown. Check the existing payment; do not send another.",
  notYetConfirmed: "Not yet confirmed. No second payment was sent.",
  couldNotVerify: "Could not verify this payment yet. No second payment was sent.",
  paymentTakenBack: "This payment was taken back. The sats are in your wallet.",
  parkedSigned: "Needs your decision: this payment was signed before this copy of your profile took over. It is never sent again from here. Check it before you pay again.",
  // Real money and test coins.
  realMoneyUnconfirmed: "This pays with real money: confirm it with Send real money first. Nothing was sent.",
  mainnetPaymentOnTestnet: "This is a Mainnet payment (real money): a Testnet wallet never pays it. Use a Mainnet wallet.",
  testnetPaymentOnMainnet: "This is a Testnet payment (test coins): a Mainnet wallet never pays it. Use a Testnet wallet.",
  // USDT.
  usdtRpcUnavailable: "USDT RPC unavailable",
  usdtNotEnoughTokens: "Insufficient token balance",
  usdtNotEnoughGas: "Insufficient ETH for gas",
  usdtGasAboveLimit: "Estimated maximum gas exceeds your limit",
  usdtNeedsSepoliaGas: "This needs a little Sepolia ETH for gas first",
  // Fedimint.
  fedimintNotInvite: "That is not a Fedimint invite code: it starts with fed1",
  fedimintAlreadyJoined: "You already joined this federation",
  fedimintConnecting: "Wait for the federation to connect",
  fedimintNotEnough: "Not enough in this federation",
  fedimintRealOnTestnet: "This federation holds real bitcoin: it belongs in a Mainnet Fedimint wallet",
  fedimintTestOnMainnet: "This federation is on {chain}, a test network: it belongs in a Testnet Fedimint wallet",
  walletAway: "{wallet} can't be used here. Use it on {device}.",
  walletAwayUnnamed: "{wallet} can't be used here: its home is another device.",
  // One profile on several devices (WISP 06).
  groupTurnUnconfirmed: "Can't check which device is active, so the group was not changed. Try again in a moment.",
} as const;

export type EngineErrorCode = keyof typeof ENGINE_ERRORS;
export type EngineErrorValues = Record<string, string | number>;

/**
 * An error the engine knows: `engineCode` travels with it inside the engine, the text everywhere. Not `code`: the
 * CLI reads a `code` as its own exit code, and Node's errors carry one of theirs.
 */
export class EngineError extends Error {
  constructor(readonly engineCode: EngineErrorCode, readonly values: EngineErrorValues = {}) {
    super(engineText(engineCode, values));
  }
}

/** The English text of `code` with its values in it, exactly as the engine writes it. */
export function engineText(code: EngineErrorCode, values: EngineErrorValues = {}): string {
  return ENGINE_ERRORS[code].replace(/\{(\w+)\}/g, (_, name: string) => (name in values ? String(values[name]) : `{${name}}`));
}

export const engineError = (code: EngineErrorCode, values?: EngineErrorValues): EngineError => new EngineError(code, values);

/** What each kind of value looks like in a text: never a space in a host, a network by its name, an amount as digits. */
const VALUE: Record<string, string> = {
  host: "(\\S+)", domain: "(\\S+)", chain: "(\\S+)", network: "(Mainnet|Testnet)",
  amount: "(\\d[\\d.,\\u00a0\\u202f' ]*?)", fee: "(\\d[\\d.,\\u00a0\\u202f' ]*?)", min: "(\\d[\\d.,\\u00a0\\u202f' ]*?)", max: "(\\d[\\d.,\\u00a0\\u202f' ]*?)",
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS = (Object.keys(ENGINE_ERRORS) as EngineErrorCode[]).map((code) => {
  const names: string[] = [];
  const source = ENGINE_ERRORS[code].split(/(\{\w+\})/).map((part) => {
    const value = /^\{(\w+)\}$/.exec(part);
    if (!value) return escape(part);
    names.push(value[1]);
    return VALUE[value[1]] ?? "(.+?)";
  }).join("");
  return { code, names, pattern: new RegExp(`^${source}$`) };
});

/** The code and values of a text the engine wrote, or null for any other text (it is then shown as it is). */
export function parseEngineError(text: string): { code: EngineErrorCode; values: Record<string, string> } | null {
  const trimmed = text.trim();
  for (const { code, names, pattern } of PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) return { code, values: Object.fromEntries(names.map((name, i) => [name, match[i + 1]])) };
  }
  return null;
}
