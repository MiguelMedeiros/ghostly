import { afterAll, it, vi } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { BreezLightning } from "../src/engine/paymentAdapters/providers/breez";
import { BREEZ_TESTNET, counterpart, nodeBreezSdk, type Counterpart } from "../../../e2e/support/breez";
import { describeLightningProvider } from "./helpers/providerContract";
// covers-gated: wallet.lightning.breez.pay, wallet.lightning.provider-contract

/**
 * The Breez source against Breez's real regtest (hosted by Breez and Lightspark: no API key, worthless
 * sats), with the SDK's Node build: an invoice of ours paid by a counterpart wallet, one of the
 * counterpart's paid by us, and an invoice too big for our balance refused before anything leaves.
 * GHOSTLY_BREEZ_TESTNET=1 runs it; see e2e/README.md.
 */
vi.setConfig({ testTimeout: 5 * 60_000, hookTimeout: 5 * 60_000 });

if (BREEZ_TESTNET) {
  // One wallet for the whole suite (each test opens it again, as the engine would after a restart).
  const mnemonic = generateMnemonic(wordlist);
  const sdk = async () => nodeBreezSdk();
  let others: Promise<Counterpart> | undefined;
  let funded = false;
  afterAll(async () => { await (await others?.catch(() => undefined))?.close(); });

  describeLightningProvider("Breez on regtest", async () => {
    const other = await (others ??= counterpart());
    const provider = await BreezLightning.connect({ network: "regtest", mnemonic }, sdk);
    if (!funded) {
      // Enough for the payments below and their fees: paid by the counterpart, like any incoming invoice.
      const invoice = await provider.createInvoice(500, "fund");
      await other.pay(invoice.invoice);
      await vi.waitFor(async () => { if ((await provider.invoiceStatus(invoice)).state !== "paid") throw new Error("not yet"); }, { timeout: 120_000, interval: 2_000 });
      funded = true;
    }
    const peer = other;
    return {
      provider, network: "regtest",
      payIncoming: (invoice) => peer.pay(invoice.invoice),
      payable: (amount) => peer.invoice(amount),
      refused: () => peer.invoice(1_000_000),
    };
  }, { timeout: 120_000 });
} else {
  it.skip("Breez on regtest (GHOSTLY_BREEZ_TESTNET=1)", () => {});
}
