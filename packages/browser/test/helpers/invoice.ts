import { bech32 } from "@scure/base";
import { fakeInvoice } from "../../src/engine/paymentAdapters/providers/testing";

/** An invoice that decodes as `sats` on the chain of `prefix` (lnbc, lntb, lntbs, lnbcrt): blank signature, nobody can pay it. */
export function invoiceFor(sats: number, prefix = "lnbc"): string {
  const { words } = bech32.decode(fakeInvoice(sats, new Uint8Array(32).fill(7)) as `${string}1${string}`, false);
  return bech32.encode(`${prefix}${sats * 10}n`, words, false);
}
