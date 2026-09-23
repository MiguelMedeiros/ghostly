import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { BreezSdkModule, BreezWallet } from "../../packages/browser/src/engine/paymentAdapters/providers/breezSdk";

/**
 * Breez's regtest, from Node: the same SDK as the app (its Node build), for the counterpart that pays
 * and bills the Ghostly side in the gated tests (GHOSTLY_BREEZ_TESTNET=1). Regtest is Breez and
 * Lightspark's hosted Spark regtest: no API key, nothing to run locally, worthless sats.
 *
 * The counterpart is funded from Lightspark's public regtest faucet (the one behind
 * https://app.lightspark.com/regtest-faucet, no login), only when it runs low. Set
 * GHOSTLY_BREEZ_COUNTERPART to a recovery phrase to reuse one wallet across runs; it is never printed.
 */
export const BREEZ_TESTNET = process.env.GHOSTLY_BREEZ_TESTNET === "1";
const FAUCET = "https://app.lightspark.com/graphql/frontend?n=RequestRegtestFunds";
const FAUCET_SATS = 10_000;

type NodeBreez = typeof import("@breeztech/breez-sdk-spark/nodejs");

/** The SDK's Node build, with wallets kept in a directory of the system's temp folder. */
export function nodeBreezSdk(): BreezSdkModule {
  // The Node build is CommonJS: required, not imported, so its named exports are all there.
  const breez = createRequire(import.meta.url)("@breeztech/breez-sdk-spark/nodejs") as NodeBreez;
  return {
    async connect({ network, mnemonic, apiKey, storage }) {
      const dir = join(tmpdir(), "ghostly-breez-e2e", storage);
      mkdirSync(dir, { recursive: true });
      const config = breez.defaultConfig(network);
      if (apiKey) config.apiKey = apiKey;
      return breez.connect({ config, seed: { type: "mnemonic", mnemonic }, storageDir: dir });
    },
  };
}

export interface Counterpart { wallet: BreezWallet; balance(): Promise<number>; invoice(amount: number, memo?: string): Promise<string>; pay(invoice: string): Promise<void>; close(): Promise<void> }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(what: string, check: () => Promise<T | undefined>, timeout = 180_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await wait(3_000);
  }
}

/** Asks the public regtest faucet for sats, to a Spark (`sparkrt1…`) or regtest Bitcoin address. */
export async function faucet(address: string, sats = FAUCET_SATS): Promise<void> {
  const response = await fetch(FAUCET, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ operationName: "RequestRegtestFunds", variables: { address, amount_sats: sats },
      query: "mutation RequestRegtestFunds($address: String!, $amount_sats: Long!) { request_regtest_funds(input: {address: $address, amount_sats: $amount_sats}) { transaction_hash } }" }),
  });
  const body = await response.json().catch(() => ({})) as { errors?: { message: string }[] };
  if (!response.ok || body.errors?.length) throw new Error(`The regtest faucet refused: ${body.errors?.map((e) => e.message).join(", ") ?? response.status}`);
}

/** A regtest wallet outside Ghostly, holding at least `floor` sats (funded from the faucet when it has fewer). */
export async function counterpart(floor = 3_000): Promise<Counterpart> {
  const mnemonic = process.env.GHOSTLY_BREEZ_COUNTERPART?.trim() || generateMnemonic(wordlist);
  const storage = `counterpart-${createHash("sha256").update(mnemonic).digest("hex").slice(0, 16)}`;
  const wallet = await nodeBreezSdk().connect({ network: "regtest", mnemonic, storage });
  const balance = async () => (await wallet.getInfo({ ensureSynced: true })).balanceSats;
  if (await balance() < floor) {
    const { paymentRequest } = await wallet.receivePayment({ paymentMethod: { type: "sparkAddress" } });
    await faucet(paymentRequest);
    await until("the faucet's sats", async () => (await balance()) >= floor ? true : undefined);
  }
  return {
    wallet, balance,
    async invoice(amount, memo = "Ghostly e2e") { return (await wallet.receivePayment({ paymentMethod: { type: "bolt11Invoice", description: memo, amountSats: amount } })).paymentRequest; },
    async pay(invoice) {
      const prepared = await wallet.prepareSendPayment({ paymentRequest: { type: "input", input: invoice } });
      const { payment } = await wallet.sendPayment({ prepareResponse: prepared, options: { type: "bolt11Invoice", preferSpark: false, completionTimeoutSecs: 60 } });
      if (payment.status !== "completed") await until("the counterpart's payment", async () => (await wallet.getPayment({ paymentId: payment.id })).payment.status === "completed" ? true : undefined);
    },
    async close() { await Promise.race([wallet.disconnect(), wait(10_000)]); },
  };
}
