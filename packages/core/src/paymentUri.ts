/**
 * Payment URIs for a wallet that is not Ghostly: what a QR code shows and what a `lightning:` or
 * `bitcoin:` link opens. Building them is all this does; whether the payment arrives is watched by the
 * payee's own source, never assumed from the link having been opened.
 *
 * - `lightning:<invoice>` ([BOLT 11](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md)).
 * - `bitcoin:<address>?amount=<btc>&lightning=<invoice>` ([BIP 21](https://github.com/bitcoin/bips/blob/master/bip-0021.mediawiki)),
 *   with the `lightning` parameter of the unified QR convention when an invoice exists too.
 * - `bitcoin:?ark=<address>&amount=<btc>` for an Ark address, the BIP 21 form Ark wallets read.
 */
export type PaymentUriInput =
  | { kind: "lightning"; invoice: string }
  | { kind: "bitcoin"; address: string; amountSat?: number; label?: string; message?: string; lightning?: string }
  | { kind: "ark"; address: string; amountSat?: number };

/** Whole sats as the decimal BTC amount BIP 21 wants (`21` → `0.00000021`), never in exponent form. */
export function satsToBtc(sats: number): string {
  if (!Number.isSafeInteger(sats) || sats < 0) throw new Error("Amount must be a whole number of sats");
  const whole = Math.floor(sats / 100_000_000);
  const fraction = String(sats % 100_000_000).padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

const cleanInvoice = (invoice: string) => invoice.trim().toLowerCase().replace(/^lightning:/, "");

/** The URI to open in another wallet. Throws on an input that cannot be one. */
export function paymentUri(input: PaymentUriInput): string {
  if (input.kind === "lightning") {
    const invoice = cleanInvoice(input.invoice);
    if (!/^ln[a-z0-9]+$/.test(invoice)) throw new Error("That is not a Lightning invoice");
    return `lightning:${invoice}`;
  }
  const params = new URLSearchParams();
  if (input.kind === "ark") {
    if (!/^[a-z0-9]+$/i.test(input.address)) throw new Error("That is not an Ark address");
    params.set("ark", input.address);
    if (input.amountSat) params.set("amount", satsToBtc(input.amountSat));
    return `bitcoin:?${params.toString()}`;
  }
  if (!/^[a-zA-Z0-9]+$/.test(input.address)) throw new Error("That is not a Bitcoin address");
  if (input.amountSat) params.set("amount", satsToBtc(input.amountSat));
  if (input.label) params.set("label", input.label.slice(0, 140));
  if (input.message) params.set("message", input.message.slice(0, 140));
  if (input.lightning) params.set("lightning", cleanInvoice(input.lightning));
  // `+` would be read as a space by some wallets; BIP 21 wants percent-encoding.
  const query = params.toString().replace(/\+/g, "%20");
  return query ? `bitcoin:${input.address}?${query}` : `bitcoin:${input.address}`;
}

/**
 * What to put in the QR code: a `lightning:` URI in upper case, so the code uses the smaller alphanumeric
 * mode every Lightning wallet reads; anything with characters outside that mode as it is.
 */
export function qrText(uri: string): string {
  const upper = uri.toUpperCase();
  return /^[A-Z0-9 $%*+\-./:]*$/.test(upper) ? upper : uri;
}
