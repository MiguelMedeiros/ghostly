import { createHash } from "node:crypto";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { BreezWallet } from "../../packages/browser/src/engine/paymentAdapters/providers/breezSdk";
import { nodeBreezSdk } from "./breez";

/**
 * Spark to Spark on Breez's hosted regtest, from Node: the counterpart that funds the Ghostly peers in the gated
 * Spark tests (GHOSTLY_SPARK_REGTEST=1). Same SDK as the app (its Node build), no API key, worthless sats.
 *
 * Lightspark's regtest faucet now asks for a reCAPTCHA, so a person funds the counterpart once, by hand
 * (https://app.lightspark.com/regtest-faucet, to the address `counterpart()` prints when it has too little), and
 * the tests reuse it: GHOSTLY_SPARK_COUNTERPART holds its recovery phrase (GHOSTLY_BREEZ_COUNTERPART works too).
 * The phrase is never printed.
 */
export const SPARK_REGTEST = process.env.GHOSTLY_SPARK_REGTEST === "1";

export interface SparkCounterpart {
  wallet: BreezWallet;
  address: string;
  balance(): Promise<number>;
  /** Pays a Spark address (or invoice) of a Ghostly peer; resolves with the transfer id once it completed. */
  pay(to: string, amount: number): Promise<string>;
  close(): Promise<void>;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sparkCounterpart(floor = 10_000): Promise<SparkCounterpart> {
  const phrase = process.env.GHOSTLY_SPARK_COUNTERPART?.trim() || process.env.GHOSTLY_BREEZ_COUNTERPART?.trim();
  const mnemonic = phrase || generateMnemonic(wordlist);
  const storage = `spark-counterpart-${createHash("sha256").update(mnemonic).digest("hex").slice(0, 16)}`;
  const wallet = await nodeBreezSdk().connect({ network: "regtest", mnemonic, storage });
  await wallet.syncWallet({});
  const address = (await wallet.receivePayment({ paymentMethod: { type: "sparkAddress" } })).paymentRequest;
  const balance = async () => (await wallet.getInfo({ ensureSynced: true })).balanceSats;
  const have = await balance();
  if (have < floor) {
    await Promise.race([wallet.disconnect(), wait(10_000)]);
    throw new Error(`The Spark counterpart holds ${have} sats (${floor} needed). Fund ${address} from https://app.lightspark.com/regtest-faucet${phrase ? "" : " and set GHOSTLY_SPARK_COUNTERPART to its phrase"}.`);
  }
  return {
    wallet, address, balance,
    async pay(to, amount) {
      const prepared = await wallet.prepareSendPayment({ paymentRequest: { type: "input", input: to }, amount: BigInt(amount) });
      if (prepared.paymentMethod.type !== "sparkAddress" && prepared.paymentMethod.type !== "sparkInvoice") throw new Error(`Not a Spark payment: ${prepared.paymentMethod.type}`);
      const { payment } = await wallet.sendPayment({ prepareResponse: prepared, idempotencyKey: crypto.randomUUID() });
      for (let i = 0; payment.status !== "completed" && i < 60; i++) {
        await wait(2_000);
        if ((await wallet.getPayment({ paymentId: payment.id })).payment.status === "completed") break;
      }
      return payment.id;
    },
    async close() { await Promise.race([wallet.disconnect(), wait(10_000)]); },
  };
}
