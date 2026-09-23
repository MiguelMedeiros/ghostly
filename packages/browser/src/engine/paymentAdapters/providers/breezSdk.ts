import type { BreezSdk } from "@breeztech/breez-sdk-spark/web";

/**
 * The part of the Breez SDK (nodeless, on Spark: `@breeztech/breez-sdk-spark`, WebAssembly) the Breez
 * Lightning source uses, behind an interface small enough to fake in tests. The SDK keeps its wallet in
 * IndexedDB and reaches the Spark operators and the Breez services over HTTPS, so the same build runs
 * in the web app, the extension's offscreen document and Desktop's WebView.
 */
export type BreezNetwork = "mainnet" | "regtest";
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
