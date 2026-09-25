import { sha256 } from "@noble/hashes/sha2.js";
import type { BreezSdk } from "@breeztech/breez-sdk-spark/web";

/**
 * The part of the Breez SDK (nodeless, on Spark: `@breeztech/breez-sdk-spark`, WebAssembly) the Breez
 * Lightning source uses, behind an interface small enough to fake in tests. The SDK keeps its wallet in
 * IndexedDB and reaches the Spark operators and the Breez services over HTTPS, so the same build runs
 * in the web app, the extension's offscreen document and Desktop's WebView.
 */
export type BreezNetwork = "mainnet" | "regtest";
/** Ghostly's own name for the two networks: `bitcoin` (Mainnet, real sats) or `regtest` (Breez's test network). */
export type BreezChain = "bitcoin" | "regtest";
export type BreezWallet = Pick<BreezSdk, "getInfo" | "receivePayment" | "prepareSendPayment" | "sendPayment" | "getPayment" | "listPayments" | "syncWallet" | "disconnect">;

export interface BreezConnect {
  network: BreezNetwork;
  mnemonic: string;
  /** Breez's API key. Mainnet needs one; regtest works without. */
  apiKey?: string;
  /** Where the SDK keeps this wallet: an IndexedDB name in a browser, a directory in Node. */
  storage: string;
}

export interface BreezSdkModule {
  connect(params: BreezConnect): Promise<BreezWallet>;
}

let loading: Promise<BreezSdkModule> | undefined;

/** Loads the WebAssembly once, on first use: profiles that never pick Breez never fetch its 12.8 MB. */
export function loadBreezSdk(): Promise<BreezSdkModule> {
  return loading ??= (async () => {
    const breez = await import("@breeztech/breez-sdk-spark/web");
    // Loads the module and installs the SDK's IndexedDB storage.
    await breez.default();
    const sdk: BreezSdkModule = {
      async connect({ network, mnemonic, apiKey, storage }) {
        const config = breez.defaultConfig(network);
        if (apiKey) config.apiKey = apiKey;
        return breez.connect({ config, seed: { type: "mnemonic", mnemonic }, storageDir: storage });
      },
    };
    return sdk;
  })().catch((error) => { loading = undefined; throw error; });
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const breezNetwork = (network: string): BreezNetwork => (network === "bitcoin" ? "mainnet" : "regtest");

/**
 * The wallet's own storage: one per network and seed, named without revealing anything about the seed. The
 * Spark rail and the Breez Lightning source name it the same way, so one seed is one wallet whichever opens it.
 */
export const breezStorage = (network: string, mnemonic: string) =>
  `ghostly-breez-${breezNetwork(network)}-${hex(sha256(new TextEncoder().encode(`ghostly-breez:${breezNetwork(network)}:${mnemonic}`))).slice(0, 16)}`;

const DISCONNECT_MS = 10_000;
/** One SDK instance per wallet storage: two over one database would each think the leaves are theirs. */
const open = new Map<string, { wallet: Promise<BreezWallet>; refs: number }>();

/**
 * Opens the Breez wallet of this seed on this network, or shares the one already open (the Spark rail and the
 * Breez Lightning source of the same seed are one wallet). `release` gives this user's share back; the last one
 * disconnects the SDK.
 */
export async function openBreez(
  params: { network: string; mnemonic: string; apiKey?: string },
  sdk: () => Promise<BreezSdkModule> = loadBreezSdk,
  storage: (network: string, mnemonic: string) => string = breezStorage,
): Promise<{ wallet: BreezWallet; release: () => Promise<void> }> {
  const name = storage(params.network, params.mnemonic);
  const key = `${name}|${params.apiKey ? hex(sha256(new TextEncoder().encode(params.apiKey))).slice(0, 8) : ""}`;
  let entry = open.get(key);
  if (!entry) {
    const wallet = sdk().then((module) => module.connect({ network: breezNetwork(params.network), mnemonic: params.mnemonic, apiKey: params.apiKey, storage: name }));
    entry = { wallet, refs: 0 };
    open.set(key, entry);
    wallet.catch(() => { if (open.get(key) === entry) open.delete(key); });
  }
  entry.refs++;
  const held = entry;
  let wallet: BreezWallet;
  try { wallet = await held.wallet; }
  catch (error) { held.refs--; throw error; }
  let released = false;
  return {
    wallet,
    release: async () => {
      if (released) return;
      released = true;
      if (--held.refs > 0) return;
      if (open.get(key) === held) open.delete(key);
      await Promise.race([wallet.disconnect(), new Promise((resolve) => setTimeout(resolve, DISCONNECT_MS))]);
    },
  };
}
