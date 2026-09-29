import { FakeLightningProvider, FakeOnchainProvider, fakeAddress, fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { describeLightningProvider, describeOnchainProvider } from "./helpers/providerContract";
// covers: wallet.lightning.provider-contract, wallet.onchain.provider-contract

// The fakes pass the same contract every real provider has to pass: that is what makes them good stand-ins.
describeLightningProvider("Fake Lightning", async () => {
  const provider = new FakeLightningProvider({ settleMs: 60_000 });
  const poor = new FakeLightningProvider({ balance: 0 });
  return {
    provider, network: "regtest",
    payIncoming: async (invoice) => provider.markPaid(invoice.paymentHash),
    payable: async (amount) => (await poor.createInvoice(amount)).invoice,
    refused: async () => fakeInvoice(10_000_000, crypto.getRandomValues(new Uint8Array(32))),
  };
});

describeOnchainProvider("Fake Bitcoin wallet", async () => ({ provider: new FakeOnchainProvider(), network: "regtest", recipient: fakeAddress }));
