import { expect, it } from "vitest";
import { FakeLightningProvider, FakeOnchainProvider, fakeAddress, fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { describeLightningProvider, describeOnchainProvider } from "./helpers/providerContract";
// covers: wallet.lightning.provider-contract, wallet.onchain.provider-contract

// The fakes pass the same contract every real provider has to pass: that is what makes them good stand-ins.
const lightning = async () => {
  const provider = new FakeLightningProvider({ settleMs: 60_000 });
  const poor = new FakeLightningProvider({ balance: 0 });
  return {
    provider, network: "regtest",
    payIncoming: async (invoice) => provider.markPaid(invoice.paymentHash),
    payable: async (amount) => (await poor.createInvoice(amount)).invoice,
    refused: async () => fakeInvoice(10_000_000, crypto.getRandomValues(new Uint8Array(32))),
  } as const;
};
const onchain = async () => ({ provider: new FakeOnchainProvider(), network: "regtest", recipient: fakeAddress }) as const;

describeLightningProvider("Fake Lightning", lightning);
describeOnchainProvider("Fake Bitcoin wallet", onchain);

// A harness on a real network says how long money takes there: its tests must not run on the default limit.
describeLightningProvider("Fake Lightning, as on a slow network", lightning, { timeout: 30_000 });
describeOnchainProvider("Fake Bitcoin wallet, as on a slow chain", onchain, { timeout: 20_000 });

it("gives a contract's tests the time its network needs, and the default limit to the others", ({ task }) => {
  const limits = Object.fromEntries(task.file.tasks.flatMap((suite) => (suite.type === "suite" ? [[suite.name, [...new Set(suite.tasks.map((test) => test.timeout))]]] : [])));
  expect(limits).toEqual({
    "Fake Lightning: the LightningProvider contract": [5_000],
    "Fake Bitcoin wallet: the OnchainProvider contract": [5_000],
    "Fake Lightning, as on a slow network: the LightningProvider contract": [90_000],
    "Fake Bitcoin wallet, as on a slow chain: the OnchainProvider contract": [60_000],
  });
});
