import { describe, expect, it, vi } from "vitest";
import { decodeBolt11 } from "@ghostly/core";
import { NothingSpentError } from "../src/engine/paymentAdapters/providers/types";
import { WeblnLightning } from "../src/engine/paymentAdapters/providers/webln";
import { LndRest, lndWebln } from "./helpers/lndWebln";
import { describeLightningProvider } from "./helpers/providerContract";
// covers-gated: wallet.lightning.webln.pay, wallet.lightning.provider-contract

/**
 * The WebLN provider against a real regtest Lightning node: a WebLN wallet in front of LND "alice", and
 * LND "bob" at the other end of her channel. Needs e2e/infra up (npm run e2e:infra:up,
 * see e2e/README.md). Worthless regtest sats only.
 */
const enabled = process.env.GHOSTLY_WEBLN_REGTEST === "1";
// A real node answers in its own time: a payment that outlives a timed-out test lands in the next one.
vi.setConfig({ testTimeout: 60_000 });

if (enabled) {
  describeLightningProvider("WebLN in front of regtest LND", async () => {
    const bob = new LndRest("bob");
    const provider = await WeblnLightning.connect(lndWebln("alice"), "testnet");
    return {
      provider, network: "regtest",
      payIncoming: async (invoice) => { await bob.pay(invoice.invoice); },
      payable: (amount) => bob.invoice(amount),
      // More than her whole channel: refused before the wallet is asked to pay.
      refused: () => bob.invoice(5_000_000),
    };
  }, { timeout: 30_000 });
}

describe.skipIf(!enabled)("WebLN in front of regtest LND: a lost answer", () => {
  it("is unknown, then seen paid by looking it up, and the sats moved once", async () => {
    const bob = new LndRest("bob");
    const wallet = lndWebln("alice");
    const send = wallet.sendPayment!.bind(wallet);
    // The wallet pays, and its answer never reaches Ghostly.
    wallet.sendPayment = async (invoice) => { await send(invoice); throw new Error("Connection reset"); };
    const provider = await WeblnLightning.connect(wallet, "testnet");
    const [aliceBefore, bobBefore] = [await wallet.lnd.channelBalance(), await bob.channelBalance()];
    const invoice = await bob.invoice(77);
    const error = await provider.payInvoice(invoice).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NothingSpentError);
    expect(await provider.paymentStatus({ invoice, paymentHash: decodeBolt11(invoice)!.paymentHash! })).toMatchObject({ state: "paid" });
    // Each node books the settled HTLC on its own time.
    await vi.waitFor(async () => expect(await bob.channelBalance()).toBe(bobBefore + 77), { timeout: 10_000, interval: 250 });
    await vi.waitFor(async () => expect(await wallet.lnd.channelBalance()).toBe(aliceBefore - 77), { timeout: 10_000, interval: 250 });
    await provider.close();
  }, 60_000);
});
