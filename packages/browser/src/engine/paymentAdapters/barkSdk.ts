/**
 * The part of Second's Bark SDK (`@secondts/bark`, WebAssembly) Ghostly uses, behind an interface small
 * enough to fake in tests. The SDK keeps its wallet in IndexedDB and reaches the Ark server over gRPC-web,
 * so the same build runs in the web app, the extension's offscreen page and Desktop's WebView.
 */
export type BarkNetwork = "bitcoin" | "signet" | "regtest";

export interface BarkBalance {
  spendableSats: number;
  pendingInRoundSats: number;
  pendingExitSats: number;
  pendingLightningSendSats: number;
  claimableLightningReceiveSats: number;
  pendingBoardSats: number;
}
/** One entry of the wallet's history. Addresses come as JSON `{"type":"ark","value":"tark1…"}`. */
export interface BarkMovement {
  id: number;
  status: string;
  subsystemKind: string;
  intendedBalanceSats: number;
  effectiveBalanceSats: number;
  offchainFeeSats: number;
  sentToAddresses: string[];
  receivedOnAddresses: string[];
  outputVtxoIds: string[];
  createdAt: string;
}
export interface BarkWalletHandle {
  /** Empty until the wallet has reached its server (right after an open, for a few seconds). */
  arkInfo(): Promise<{ network: string; serverPubkey: string } | undefined>;
  refreshServer(): Promise<void>;
  balance(): Promise<BarkBalance>;
  peekAddress(index: number): Promise<string>;
  newAddressWithIndex(): Promise<{ address: string; index: number }>;
  validateArkoorAddress(address: string): Promise<boolean>;
  estimateArkoorPaymentFee(amountSats: number): Promise<{ feeSats: number }>;
  sendArkoorPayment(address: string, amountSats: number): Promise<void>;
  history(): Promise<BarkMovement[]>;
  sync(): Promise<void>;
  maintenance(): Promise<void>;
  boardAll(): Promise<{ amountSats: number; txid: string }>;
  stopDaemonWait(): Promise<void>;
  free(): void;
}
export interface BarkOnchainHandle {
  newAddress(): Promise<string>;
  balance(): Promise<{ confirmedSats: number; pendingSats: number; totalSats: number }>;
  sync(): Promise<number>;
  initialScan(birthdayHeight?: number | null): Promise<number>;
  free(): void;
}
export interface BarkOpen {
  network: BarkNetwork;
  mnemonic: string;
  server: string;
  esplora: string;
  /** IndexedDB name of this wallet; its on-chain part lives next to it. */
  database: string;
}
export interface BarkSdk {
  open(params: BarkOpen): Promise<{ wallet: BarkWalletHandle; onchain: BarkOnchainHandle }>;
  /** Parses as a Bark address at all (any server). An Arkade address does not. */
  isArkAddress(address: string): boolean;
}

const NETWORK = { bitcoin: "Bitcoin", signet: "Signet", regtest: "Regtest" } as const;
let loading: Promise<BarkSdk> | undefined;

/** Loads the WebAssembly once, on first use: profiles that never open a Bark wallet never fetch its 7.7 MB. */
export function loadBarkSdk(): Promise<BarkSdk> {
  return loading ??= (async () => {
    const [bark, wasm] = await Promise.all([import("@secondts/bark/web"), import("@secondts/bark/web/bark_ffi_wasm_bg.wasm?url")]);
    await bark.default({ module_or_path: wasm.default });
    const sdk: BarkSdk = {
      async open({ network, mnemonic, server, esplora, database }) {
        const config = { serverAddress: server, esploraAddress: esplora };
        const onchain = await bark.OnchainWallet.default({ network: NETWORK[network], mnemonic, config, dbName: `${database}-onchain` });
        try {
          // The daemon receives Ark payments (mailbox), follows rounds and syncs while Ghostly is open.
          const wallet = await bark.Wallet.openWithOnchain(NETWORK[network], mnemonic, config, onchain, { runDaemon: true, indexedDbName: database, createIfNotExists: true });
          return { wallet, onchain };
        } catch (error) { onchain.free(); throw error; }
      },
      isArkAddress(address) { try { return bark.validateArkAddress(address); } catch { return false; } },
    };
    return sdk;
  })().catch((error) => { loading = undefined; throw error; });
}
