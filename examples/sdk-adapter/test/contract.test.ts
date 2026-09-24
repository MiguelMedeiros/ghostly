import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describeIdentityProof, describeLightningProvider, fakeInvoice } from "@ghostly/sdk/testing";
import { exampleSchnorr, schnorrSign, schnorrSubject } from "../src/identity";
import { PaperLightning, paperLightning } from "../src/lightning";
// covers: sdk.package, wallet.lightning.provider-contract, proofs.contract

/** The contract suites from the SDK, against the example adapters. Provider-specific tests go next to these. */
describeLightningProvider("Paper Lightning", async () => {
  const provider = new PaperLightning({ balance: 10_000, settleAfterMs: 60_000 });
  return {
    provider, descriptor: paperLightning, network: "regtest",
    payIncoming: async (invoice) => provider.settle(invoice.paymentHash),
    payable: async (amount) => fakeInvoice(amount, sha256(crypto.getRandomValues(new Uint8Array(32)))),
    refused: async () => fakeInvoice(1_000_000, sha256(crypto.getRandomValues(new Uint8Array(32)))),
  };
});

describeIdentityProof("Schnorr key", async () => {
  const other = schnorr.utils.randomSecretKey();
  return { provider: exampleSchnorr, subject: schnorrSubject(), prove: async (s) => schnorrSign(s), proveAsOther: async (s) => schnorrSign(s, other) };
});
