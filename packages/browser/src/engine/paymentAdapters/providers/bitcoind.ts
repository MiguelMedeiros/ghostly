import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import type { WalletMode } from "../../../shared/mints";
import type { OnchainBalance, OnchainInfo, OnchainPrepared, OnchainProvider, OnchainProviderDescriptor, OnchainSendRequest, OnchainTx, OnchainTxStatus } from "./onchain";
import { NothingSpentError, networkMode, type ProviderHost, type ProviderNetwork, type ProviderSettings } from "./types";

/**
 * On-chain Bitcoin from a wallet of the person's own Bitcoin Core node, over its JSON-RPC.
 *
 * bitcoind answers no CORS preflight, so a page cannot call it: this runs on Desktop only, where the
 * `bitcoind_rpc` Tauri command (src-tauri/src/bitcoind_rpc.rs, reached through `ProviderHost.invoke`)
 * makes the call. That command forwards only the methods below, to the URL configured here, and says
 * whether a failed call could have reached the node (`kind`), which is what lets `broadcast` tell
 * "nothing spent" from "unknown".
 *
 * A payment: `walletcreatefundedpsbt` picks and locks the coins, `walletprocesspsbt` signs, `finalizepsbt`
 * finalizes, and the result is checked here (outputs, fee, txid) before it is shown for review. Nothing is
 * broadcast until approval (`sendrawtransaction`); a cancelled review unlocks the coins (`lockunspent`).
 */

export interface BitcoindCall {
  url: string;
  /** Empty: the node's default wallet. */
  wallet: string;
  user: string;
  password: string;
  method: string;
  params: unknown[];
}
/** Resolves with the JSON-RPC `result`; rejects with a `BitcoindRpcError`-shaped object. */
export type BitcoindTransport = (call: BitcoindCall) => Promise<unknown>;

/** What the Tauri command rejects with. See `RpcError` in bitcoind_rpc.rs for what each `kind` proves. */
export interface BitcoindRpcFailure { kind: "refused" | "connect" | "auth" | "rpc" | "transport"; code?: number; message: string }

export class BitcoindRpcError extends Error {
  constructor(readonly kind: BitcoindRpcFailure["kind"], message: string, readonly code?: number) { super(message); this.name = "BitcoindRpcError"; }
  /** The node never ran the call: it was not sent, could not connect, or the credentials were refused. */
  get neverRan() { return this.kind === "refused" || this.kind === "connect" || this.kind === "auth"; }
}

/** The Tauri command, through the Desktop host. */
export function tauriTransport(invoke: ProviderHost["invoke"]): BitcoindTransport {
  if (!invoke) throw new Error("Bitcoin Core needs the Ghostly desktop app: a browser cannot reach its RPC");
  return (call) => invoke("bitcoind_rpc", { ...call });
}

/** Bitcoin Core's JSON-RPC error codes this module acts on (src/rpc/protocol.h). */
const RPC = { INVALID_ADDRESS_OR_KEY: -5, VERIFY_ERROR: -25, VERIFY_REJECTED: -26, VERIFY_ALREADY_IN_CHAIN: -27, DESERIALIZATION_ERROR: -22 } as const;

const CHAINS: Record<string, ProviderNetwork> = { main: "bitcoin", test: "testnet", testnet4: "testnet", signet: "signet", regtest: "regtest" };
/** A fee rate for the test networks when the node has too few blocks to estimate one (regtest always). */
const TEST_FALLBACK_FEE_RATE = 2;
const TXID = /^[0-9a-f]{64}$/;
const WALLET_NAME = /^[A-Za-z0-9._-]{0,64}$/;
/** Address encodings, for btc-signer to read the outputs back as addresses. */
const TESTNET_ENCODING = { bech32: "tb", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const BTC_NETWORKS: Record<ProviderNetwork, typeof TESTNET_ENCODING> = {
  bitcoin: { bech32: "bc", pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 },
  testnet: TESTNET_ENCODING, signet: TESTNET_ENCODING, mutinynet: TESTNET_ENCODING,
  regtest: { ...TESTNET_ENCODING, bech32: "bcrt" },
};
const TX_OPTS = { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true, allowLegacyWitnessUtxo: true };

/** Whole sats as the exact decimal string bitcoind reads as BTC (never a float). */
export const satsToBtc = (sats: number) => {
  if (!Number.isSafeInteger(sats) || sats < 0) throw new Error("Amounts are whole sats");
  const digits = sats.toString().padStart(9, "0");
  return `${digits.slice(0, -8)}.${digits.slice(-8)}`;
};
/** A BTC amount from bitcoind (a JSON number with at most 8 decimals) as whole sats. */
export const btcToSats = (btc: unknown) => {
  if (typeof btc !== "number" || !Number.isFinite(btc)) throw new Error("The node returned an amount that is not a number");
  return Math.round(btc * 1e8);
};

const object = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`The node returned no ${what}`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, what: string) => { if (typeof value !== "string" || !value) throw new Error(`The node returned no ${what}`); return value; };

interface Outpoint { txid: string; vout: number }

export interface BitcoindConfig { url: string; wallet: string; user: string; password: string }

export class BitcoindOnchain implements OnchainProvider {
  private closed = false;
  private network?: ProviderNetwork;

  constructor(private readonly config: BitcoindConfig, private readonly transport: BitcoindTransport) {}

  /** Connects and checks the wallet is there and the node is on a network of `mode`. */
  static async connect(config: BitcoindConfig, mode: WalletMode, transport: BitcoindTransport, signal?: AbortSignal): Promise<BitcoindOnchain> {
    const provider = new BitcoindOnchain(config, transport);
    signal?.addEventListener("abort", () => void provider.close(), { once: true });
    const { network } = await provider.info();
    if (networkMode(network) !== mode) throw new Error(mode === "mainnet" ? `This node is on ${network}, not Bitcoin mainnet` : "This node is on Bitcoin mainnet: use it in the Mainnet mode");
    const wallet = object(await provider.call("getwalletinfo"), "wallet information");
    if (wallet.private_keys_enabled === false) throw new Error("This wallet has no private keys: it cannot sign a payment");
    return provider;
  }

  private async call(method: string, ...params: unknown[]): Promise<unknown> {
    if (this.closed) throw new BitcoindRpcError("refused", "This Bitcoin Core source is closed");
    try {
      return await this.transport({ ...this.config, method, params });
    } catch (error) {
      if (error instanceof BitcoindRpcError) throw error;
      const failure = error as Partial<BitcoindRpcFailure> | null;
      if (failure && typeof failure === "object" && typeof failure.kind === "string" && typeof failure.message === "string") throw new BitcoindRpcError(failure.kind, failure.message, failure.code);
      // Something that is not the command's answer (no Tauri, a crash): nothing proves the node did not run it.
      throw new BitcoindRpcError("transport", error instanceof Error ? error.message : String(error));
    }
  }

  async info(): Promise<OnchainInfo> {
    const chain = object(await this.call("getblockchaininfo"), "chain information").chain;
    const network = typeof chain === "string" ? CHAINS[chain] : undefined;
    if (!network) throw new Error(`Ghostly does not know the chain "${String(chain).slice(0, 20)}"`);
    this.network = network;
    return { network, alias: this.config.wallet || "Bitcoin Core" };
  }

  async receiveAddress(): Promise<string> {
    return text(await this.call("getnewaddress", "Ghostly"), "address");
  }

  async balance(): Promise<OnchainBalance> {
    const mine = object(object(await this.call("getbalances"), "balances").mine, "balances");
    // `trusted` is spendable: confirmed coins plus the change of our own transactions.
    return { confirmed: btcToSats(mine.trusted), unconfirmed: btcToSats(mine.untrusted_pending) };
  }

  private async feeRate(request: OnchainSendRequest): Promise<number> {
    if (request.feeRate !== undefined) {
      if (!Number.isFinite(request.feeRate) || request.feeRate < 1 || request.feeRate > 10_000) throw new Error("The fee rate must be between 1 and 10,000 sat/vB");
      return request.feeRate;
    }
    const estimate = object(await this.call("estimatesmartfee", 6), "fee estimate");
    if (typeof estimate.feerate === "number" && estimate.feerate > 0) return Math.max(1, Math.ceil(estimate.feerate * 1e5 * 1000) / 1000);
    if ((this.network ?? (await this.info()).network) === "bitcoin") throw new Error("Your node cannot estimate a fee yet. Nothing was sent.");
    return TEST_FALLBACK_FEE_RATE;
  }

  async prepareSend(request: OnchainSendRequest): Promise<OnchainPrepared> {
    if (!Number.isSafeInteger(request.amount) || request.amount <= 0) throw new Error("Amounts are whole sats");
    const network = this.network ?? (await this.info()).network;
    const feeRate = await this.feeRate(request);
    const funded = object(await this.call("walletcreatefundedpsbt", [], [{ [request.address]: satsToBtc(request.amount) }], 0, { fee_rate: feeRate, lockUnspents: true, replaceable: true }), "funded transaction");
    const inputs = this.outpoints(Transaction.fromPSBT(base64.decode(text(funded.psbt, "funded transaction")), TX_OPTS));
    try {
      const fee = btcToSats(funded.fee);
      if (fee > request.feeCap) throw new Error(`The fee (${fee} sats) is above your limit of ${request.feeCap}`);
      const signed = object(await this.call("walletprocesspsbt", funded.psbt, true, "ALL"), "signed transaction");
      if (signed.complete !== true) throw new Error("The wallet could not sign this payment (is it locked, or watch-only?)");
      const final = object(await this.call("finalizepsbt", signed.psbt, false), "finalized transaction");
      if (final.complete !== true) throw new Error("The wallet could not finalize this payment");
      return this.check(Transaction.fromPSBT(base64.decode(text(final.psbt, "finalized transaction")), TX_OPTS), request, inputs, feeRate, network);
    } catch (error) {
      // Nothing was broadcast: what the node locked for this payment goes back.
      await this.unlock(inputs).catch(() => {});
      throw error;
    }
  }

  /** The transaction the node signed is exactly the one asked for, before anyone reviews it. */
  private check(tx: Transaction, request: OnchainSendRequest, funded: Outpoint[], feeRate: number, network: ProviderNetwork): OnchainPrepared {
    const same = (a: Outpoint[], b: Outpoint[]) => a.length === b.length && a.every((o, i) => o.txid === b[i].txid && o.vout === b[i].vout);
    if (!same(this.outpoints(tx), funded)) throw new Error("The node signed other coins than it funded the payment with");
    let paid = 0;
    for (let i = 0; i < tx.outputsLength; i++) {
      const output = tx.getOutput(i);
      const address = (() => { try { return tx.getOutputAddress(i, BTC_NETWORKS[network]); } catch { return undefined; } })();
      if (address === request.address) paid += Number(output.amount ?? 0n);
    }
    if (paid !== request.amount) throw new Error("The node built a transaction that does not pay the address and amount asked for");
    const fee = Number(tx.fee);
    if (!Number.isSafeInteger(fee) || fee < 0 || fee > request.feeCap) throw new Error(`The fee (${fee} sats) is above your limit of ${request.feeCap}`);
    const txid = tx.id;
    if (!TXID.test(txid)) throw new Error("The node returned a transaction without a valid id");
    return { txid, address: request.address, amount: request.amount, fee, feeRate, signed: hex.encode(tx.extract()) };
  }

  private outpoints(tx: Transaction): Outpoint[] {
    const out: Outpoint[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      if (!input.txid || input.index === undefined) throw new Error("The node returned a transaction with an unreadable input");
      out.push({ txid: hex.encode(input.txid), vout: input.index });
    }
    return out;
  }

  private async unlock(outpoints: Outpoint[]) {
    if (outpoints.length) await this.call("lockunspent", true, outpoints);
  }

  private signedTx(prepared: OnchainPrepared) {
    if (!/^[0-9a-f]+$/.test(prepared.signed)) throw new Error("This prepared payment has no signed transaction");
    const tx = Transaction.fromRaw(hex.decode(prepared.signed), TX_OPTS);
    if (tx.id !== prepared.txid) throw new Error("This prepared payment's transaction is not the one reviewed");
    return tx;
  }

  async broadcast(prepared: OnchainPrepared): Promise<string> {
    const tx = this.signedTx(prepared);
    let txid: unknown;
    try {
      txid = await this.call("sendrawtransaction", prepared.signed);
    } catch (error) {
      if (!(error instanceof BitcoindRpcError)) throw error;
      if (error.kind === "rpc" && error.code === RPC.VERIFY_ALREADY_IN_CHAIN) return prepared.txid;
      const rejected = error.kind === "rpc" && ([RPC.VERIFY_ERROR, RPC.VERIFY_REJECTED, RPC.DESERIALIZATION_ERROR] as number[]).includes(error.code ?? 0);
      if (!error.neverRan && !rejected) throw error; // A time-out, a cut connection: it may have gone out.
      // Refused, or never sent. The wallet learns of a transaction only once its node accepted it: if it has
      // never seen this one, nobody has, and nothing was spent. If it has (this is a re-broadcast of one that
      // went out before), other nodes may still hold it: the outcome stays unknown and its coins locked.
      const seen = rejected ? await this.known(prepared.txid) : await this.known(prepared.txid).catch(() => undefined);
      if (seen) {
        if (["mempool", "confirmed"].includes((await this.status(prepared)).state)) return prepared.txid;
        throw error; // Not a NothingSpentError: an unknown outcome, reconciled by txid.
      }
      if (seen === false) await this.unlock(this.outpoints(tx)).catch(() => {});
      throw new NothingSpentError(`Your node did not send it: ${error.message}`);
    }
    if (txid !== prepared.txid) throw new Error("The node broadcast a different transaction than the one reviewed");
    return prepared.txid;
  }

  /** Whether the wallet knows this transaction (it does once its node accepted it, even if it was dropped since). */
  private async known(txid: string): Promise<boolean> {
    try { await this.call("gettransaction", txid); return true; }
    catch (error) { if (error instanceof BitcoindRpcError && error.kind === "rpc" && error.code === RPC.INVALID_ADDRESS_OR_KEY) return false; throw error; }
  }

  async status(prepared: OnchainPrepared): Promise<OnchainTxStatus> {
    if (!TXID.test(prepared.txid)) throw new Error("Not a transaction id");
    let tx: Record<string, unknown>;
    try {
      tx = object(await this.call("gettransaction", prepared.txid), "transaction");
    } catch (error) {
      if (error instanceof BitcoindRpcError && error.kind === "rpc" && error.code === RPC.INVALID_ADDRESS_OR_KEY) return { state: "missing", confirmations: 0 };
      throw error;
    }
    const confirmations = typeof tx.confirmations === "number" ? tx.confirmations : 0;
    if (confirmations > 0) return { state: "confirmed", confirmations };
    // Negative: a transaction in a block spent the same coins.
    if (confirmations < 0) return { state: "conflicted", confirmations: 0 };
    if (Array.isArray(tx.mempoolconflicts) && tx.mempoolconflicts.length > 0) return { state: "conflicted", confirmations: 0 };
    try {
      await this.call("getmempoolentry", prepared.txid);
      return { state: "mempool", confirmations: 0 };
    } catch (error) {
      if (error instanceof BitcoindRpcError && error.kind === "rpc" && error.code === RPC.INVALID_ADDRESS_OR_KEY) return { state: "missing", confirmations: 0 };
      throw error;
    }
  }

  async release(prepared: OnchainPrepared): Promise<void> {
    await this.unlock(this.outpoints(this.signedTx(prepared)));
  }

  async history(limit: number): Promise<OnchainTx[]> {
    const count = Math.max(1, Math.min(200, Math.floor(limit) * 3));
    const entries = await this.call("listtransactions", "*", count, 0, true);
    if (!Array.isArray(entries)) throw new Error("The node returned no transaction list");
    const byTxid = new Map<string, OnchainTx>();
    // Oldest first: one entry per output of ours, so a payment with change or to ourselves has several.
    for (const raw of entries as Record<string, unknown>[]) {
      if (!raw || typeof raw.txid !== "string" || !TXID.test(raw.txid) || raw.category === "orphan") continue;
      const tx = byTxid.get(raw.txid) ?? { txid: raw.txid, amount: 0, confirmations: typeof raw.confirmations === "number" ? Math.max(0, raw.confirmations) : 0 };
      tx.amount += btcToSats(raw.amount);
      if (raw.category === "send" && typeof raw.fee === "number" && tx.fee === undefined) tx.fee = Math.abs(btcToSats(raw.fee));
      if (typeof raw.time === "number") tx.timestamp = raw.time * 1000;
      byTxid.delete(raw.txid);
      byTxid.set(raw.txid, tx);
    }
    return [...byTxid.values()].reverse().slice(0, Math.max(0, limit));
  }

  async close(): Promise<void> { this.closed = true; }
}

/** `user:password` in the password field (the .cookie file's contents) when no user is given. */
export function credentials({ config, secrets }: ProviderSettings) {
  const password = secrets.password ?? "";
  const user = config.user?.trim() ?? "";
  if (!user && password.includes(":")) {
    const at = password.indexOf(":");
    return { user: password.slice(0, at), password: password.slice(at + 1) };
  }
  return { user, password };
}

export const bitcoindRpc: OnchainProviderDescriptor = {
  id: "bitcoind",
  label: "Bitcoin Core",
  kind: "onchain",
  description: "A wallet on your own Bitcoin Core node, over its RPC. Your node holds the keys and signs. Needs the desktop app.",
  networks: ["bitcoin", "testnet", "signet", "regtest"],
  platforms: ["desktop"],
  experimental: true,
  fields: [
    { name: "url", label: "RPC address", kind: "url", placeholder: "http://127.0.0.1:8332", defaults: { mainnet: "http://127.0.0.1:8332", testnet: "http://127.0.0.1:38332" },
      help: "Your node's rpcbind and rpcport: 8332 mainnet, 38332 signet, 48332 testnet4, 18443 regtest." },
    { name: "wallet", label: "Wallet name", kind: "text", optional: true, placeholder: "ghostly", help: "A wallet loaded in the node (bitcoin-cli listwallets). Empty: its default wallet." },
    { name: "user", label: "RPC user", kind: "text", optional: true, help: "Leave empty to paste the .cookie file below." },
    { name: "password", label: "RPC password or cookie", kind: "secret", help: "rpcpassword, or the contents of the node's .cookie file (it changes when bitcoind restarts)." },
  ],
  validate(settings) {
    const url = (() => { try { return new URL(settings.config.url?.trim() ?? ""); } catch { return undefined; } })();
    if (!url || !["http:", "https:"].includes(url.protocol)) throw new Error("Enter the node's RPC address, like http://127.0.0.1:8332");
    if (url.username || url.password) throw new Error("Put the RPC user and password in their own fields, not in the address");
    if (url.search || url.hash) throw new Error("The RPC address cannot have a query or fragment");
    if (!WALLET_NAME.test(settings.config.wallet?.trim() ?? "") || [".", ".."].includes(settings.config.wallet?.trim() ?? "")) throw new Error("A wallet name has only letters, digits, '-', '_' and '.'");
    const { user, password } = credentials(settings);
    if (!user || !password) throw new Error("Enter the RPC user and password, or paste the .cookie file");
  },
  async create(settings, host) {
    return BitcoindOnchain.connect({ url: settings.config.url.trim(), wallet: settings.config.wallet?.trim() ?? "", ...credentials(settings) }, host.mode, tauriTransport(host.invoke), host.signal);
  },
};
