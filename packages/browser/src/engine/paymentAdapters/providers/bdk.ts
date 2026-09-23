import { sha256 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { ChangeSet, Network, Transaction, Wallet } from "@bitcoindevkit/bdk-wallet-web";
import { isBitcoinAddress } from "@ghostly/core";
import type { WalletMode } from "../../../shared/mints";
import { STORES, store, transact, wrap } from "../../../shared/idb";
import { loadBdk, type Bdk } from "./bdkSdk";
import type { OnchainBalance, OnchainInfo, OnchainPrepared, OnchainProvider, OnchainProviderDescriptor, OnchainSendRequest, OnchainTx, OnchainTxStatus } from "./onchain";
import { NothingSpentError, type ProviderHost, type ProviderSettings } from "./types";

/**
 * On-chain Bitcoin through BDK (bitcoindevkit) in WebAssembly: a descriptor wallet whose keys come from a
 * recovery phrase Ghostly generates (or the person restores), sealed like every source secret. It syncs
 * from an Esplora server over HTTPS, signs in the page and broadcasts through the same Esplora.
 *
 * What is stored besides the sealed phrase: BDK's `ChangeSet` (public descriptors, revealed indexes, the
 * transactions and blocks it saw; no key) and the coins a pending review reserved, under `bdkWallet-<id>`
 * in the settings store.
 */

export type BdkNetwork = "regtest" | "signet" | "mutinynet";
export const BDK_NETWORKS: readonly BdkNetwork[] = ["signet", "mutinynet", "regtest"];
/** Mutinynet is a signet (its own challenge, the same genesis and addresses). */
const CHAIN: Record<BdkNetwork, Network> = { regtest: "regtest", signet: "signet", mutinynet: "signet" };
const GENESIS: Record<BdkNetwork, string> = {
  regtest: "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206",
  signet: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",
  mutinynet: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",
};
/** Public Esplora servers that answer browsers (CORS). Regtest has none: it is always your own. */
export const DEFAULT_ESPLORA: Partial<Record<BdkNetwork, string>> = { signet: "https://mempool.space/signet/api", mutinynet: "https://mutinynet.com/api" };
export type BdkScript = "bip84" | "bip86";
const SCRIPT: Record<BdkScript, { type: "p2wpkh" | "p2tr"; label: string }> = { bip84: { type: "p2wpkh", label: "BIP84" }, bip86: { type: "p2tr", label: "BIP86" } };

export interface BdkConfig { network: BdkNetwork; esplora: string; script: BdkScript }

const STOP_GAP = 20;
const PARALLEL = 4;
const SYNC_TIMEOUT = 90_000;
const HTTP_TIMEOUT = 20_000;
/** A reservation outlives an app restart, but not forever: a review saved and then lost cannot lock coins. */
const RESERVATION_MS = 24 * 3600_000;

interface Reservation { txid: string; outpoints: string[]; at: number }
interface StoredBdk { changeset: string; reserved: Reservation[]; scanned: boolean }

export interface BdkStore {
  load(key: string): Promise<StoredBdk | undefined>;
  save(key: string, value: StoredBdk): Promise<void>;
}
export const idbBdkStore: BdkStore = {
  async load(key) { return wrap<StoredBdk | undefined>((await store(STORES.settings, "readonly")).get(key)); },
  async save(key, value) { await transact([STORES.settings], (s) => { s[STORES.settings].put(value, key); }); },
};

export interface BdkDeps { bdk?: () => Promise<Bdk>; store?: BdkStore; fetch?: typeof fetch }

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text: string) => { if (!/^([0-9a-f]{2})+$/.test(text)) throw new Error("Not hex"); return Uint8Array.from(text.match(/../g)!, (h) => parseInt(h, 16)); };
const sats = (amount: { to_sat(): bigint }) => Number(amount.to_sat());
const message = (error: unknown) => error instanceof Error ? error.message : typeof error === "string" ? error : (error as { message?: unknown })?.message ? String((error as { message: unknown }).message) : String(error);

/** Checks the settings before anything is contacted. */
export function parseBdkSettings({ config, secrets }: ProviderSettings): BdkConfig & { mnemonic: string } {
  const network = config.network as BdkNetwork;
  if (!BDK_NETWORKS.includes(network)) throw new Error("Choose a test network: Signet, Mutinynet or Regtest");
  const script = (config.script || "bip84") as BdkScript;
  if (!(script in SCRIPT)) throw new Error("Choose BIP84 or BIP86");
  const esplora = (config.esplora || DEFAULT_ESPLORA[network] || "").trim().replace(/\/+$/, "");
  if (!esplora) throw new Error("Regtest needs the address of your own Esplora server");
  let url: URL;
  try { url = new URL(esplora); } catch { throw new Error("The Esplora address is not a URL"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("The Esplora server must use HTTPS (plain HTTP only on this computer)");
  if (url.username || url.password) throw new Error("Put no credentials in the Esplora address");
  const mnemonic = (secrets.mnemonic ?? "").trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("That recovery phrase is not valid (BIP39, English)");
  return { network, esplora, script, mnemonic };
}

/** Where a reviewed transaction went: the answer an Esplora gives about it and its inputs. */
class Esplora {
  constructor(readonly url: string, private readonly signal: AbortSignal, private readonly fetcher: typeof fetch) {}

  /** Bounded: a time limit, and at most `limit` characters read. */
  async request(path: string, init: RequestInit = {}, limit = 64 * 1024): Promise<{ status: number; body: string }> {
    // Not AbortSignal.any: the WebKit of Desktop's WebView may be older than it.
    const controller = new AbortController(), abort = () => controller.abort();
    const timer = setTimeout(abort, HTTP_TIMEOUT);
    this.signal.addEventListener("abort", abort, { once: true });
    if (this.signal.aborted) abort();
    try {
      const response = await this.fetcher(`${this.url}${path}`, { ...init, signal: controller.signal });
      const reader = response.body?.getReader();
      let body = "";
      if (reader) {
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
          if (body.length > limit) { await reader.cancel().catch(() => {}); throw new Error("The Esplora server sent too much"); }
        }
      }
      return { status: response.status, body };
    } finally { clearTimeout(timer); this.signal.removeEventListener("abort", abort); }
  }
  async text(path: string) {
    const { status, body } = await this.request(path);
    if (status !== 200) throw new Error(`Esplora answered ${status} for ${path.split("/")[1]}`);
    return body.trim();
  }
  async json<T>(path: string): Promise<T> { return JSON.parse(await this.text(path)) as T; }
  /** Whether it knows the transaction, and where: undefined when it does not (404). */
  async txStatus(txid: string) {
    const { status, body } = await this.request(`/tx/${txid}/status`);
    if (status === 404) return undefined;
    if (status !== 200) throw new Error(`Esplora answered ${status} for the transaction`);
    return JSON.parse(body) as { confirmed: boolean; block_height?: number };
  }
}

export class BdkOnchain implements OnchainProvider {
  private reserved: Reservation[];
  private changeset?: ChangeSet;
  private syncing?: Promise<void>;
  private syncedAt = 0;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly bdk: Bdk,
    private readonly wallet: Wallet,
    readonly config: BdkConfig,
    private readonly key: string,
    private readonly esplora: Esplora,
    private readonly client: InstanceType<Bdk["EsploraClient"]>,
    private readonly store: BdkStore,
    private readonly fingerprint: string,
    stored: StoredBdk | undefined,
  ) {
    this.changeset = stored ? bdk.ChangeSet.from_json(stored.changeset) : undefined;
    this.reserved = (stored?.reserved ?? []).filter((r) => Date.now() - r.at < RESERVATION_MS);
    this.scanned = stored?.scanned ?? false;
  }
  private scanned: boolean;

  static async open(settings: ProviderSettings, host: Pick<ProviderHost, "signal">, deps: BdkDeps = {}): Promise<BdkOnchain> {
    const { mnemonic, ...config } = parseBdkSettings(settings);
    const fetcher = deps.fetch ?? globalThis.fetch.bind(globalThis);
    const esplora = new Esplora(config.esplora, host.signal, fetcher);
    // The server must be on the network the wallet is for: a regtest wallet never reads another chain.
    let genesis: string;
    try { genesis = await esplora.text("/block-height/0"); } catch (error) { throw Object.assign(new Error(`the Esplora server did not answer (${message(error)})`), { cause: error }); }
    if (genesis !== GENESIS[config.network]) throw new Error(`that Esplora server is not on ${config.network}`);
    const bdk = await (deps.bdk ?? loadBdk)();
    const chain = CHAIN[config.network];
    const pair = bdk.seed_to_descriptor(mnemonicToSeedSync(mnemonic), chain, SCRIPT[config.script].type);
    let wallet = bdk.Wallet.create(chain, pair.external, pair.internal);
    const publicDescriptor = wallet.public_descriptor("external");
    const fingerprint = /\[([0-9a-f]{8})\//.exec(publicDescriptor)?.[1] ?? "";
    const key = `bdkWallet-${config.network}-${hex(sha256(new TextEncoder().encode(publicDescriptor))).slice(0, 32)}`;
    const walletStore = deps.store ?? idbBdkStore;
    let stored = await walletStore.load(key);
    if (stored) {
      try { wallet = bdk.Wallet.load(bdk.ChangeSet.from_json(stored.changeset), pair.external, pair.internal); }
      // A state this version cannot read is rebuilt from the chain: it holds nothing the chain does not.
      catch { stored = undefined; }
    }
    const provider = new BdkOnchain(bdk, wallet, config, key, esplora, new bdk.EsploraClient(config.esplora, 2), walletStore, fingerprint, stored);
    host.signal.addEventListener("abort", () => { provider.closed = true; }, { once: true });
    provider.persist();
    return provider;
  }

  async info(): Promise<OnchainInfo> {
    return { network: this.config.network, alias: `BDK ${SCRIPT[this.config.script].label}${this.fingerprint ? ` · ${this.fingerprint}` : ""}` };
  }

  /** Reads the chain: a full scan the first time (a restored phrase may have history), then what it revealed. */
  sync(force = false): Promise<void> {
    if (this.closed) return Promise.reject(new Error("This wallet is closed"));
    if (!force && Date.now() - this.syncedAt < 3_000) return Promise.resolve();
    return this.syncing ??= (async () => {
      const work = this.scanned
        ? this.client.sync(this.wallet.start_sync_with_revealed_spks(), PARALLEL)
        : this.client.full_scan(this.wallet.start_full_scan(), STOP_GAP, PARALLEL);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const update = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The Esplora server is too slow")), SYNC_TIMEOUT); })]).finally(() => clearTimeout(timer));
      if (this.closed) return;
      this.wallet.apply_update(update);
      this.scanned = true;
      this.syncedAt = Date.now();
      this.persist();
    })().catch((error) => { throw Object.assign(new Error(`Could not sync from Esplora: ${message(error)}`), { cause: error }); }).finally(() => { this.syncing = undefined; });
  }

  async receiveAddress(): Promise<string> {
    // Always a new one: an address shown once (to a contact, in a request) is not shown to someone else.
    const address = this.wallet.reveal_next_address("external").address.toString();
    this.persist();
    return address;
  }

  async balance(): Promise<OnchainBalance> {
    await this.sync();
    const balance = this.wallet.balance;
    return { confirmed: sats(balance.confirmed), unconfirmed: sats(balance.trusted_pending) + sats(balance.untrusted_pending) };
  }

  async prepareSend(request: OnchainSendRequest): Promise<OnchainPrepared> {
    const { address, amount, feeCap } = request;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Send a whole number of sats");
    if (!Number.isSafeInteger(feeCap) || feeCap < 0) throw new Error("Invalid maximum fee");
    if (!isBitcoinAddress(address, this.config.network)) throw new Error(`That is not a ${this.config.network} address`);
    await this.sync(true);
    const bdk = this.bdk;
    const recipient = bdk.Address.from_string(address, CHAIN[this.config.network]);
    const feeRate = Math.ceil(request.feeRate ?? await this.estimateFeeRate());
    if (!Number.isSafeInteger(feeRate) || feeRate < 1 || feeRate > 5_000) throw new Error("Invalid fee rate");

    let builder = this.wallet.build_tx()
      .fee_rate(new bdk.FeeRate(BigInt(feeRate)))
      .add_recipient(new bdk.Recipient(recipient.script_pubkey, bdk.Amount.from_sat(BigInt(amount))));
    // Not spendable here: what another review reserved, and coins someone else sent that are not confirmed
    // (they could be replaced). This wallet's own unconfirmed change is fine to spend.
    const reserved = new Set(this.reserved.flatMap((r) => r.outpoints));
    for (const utxo of this.wallet.list_unspent()) {
      const outpoint = utxo.outpoint.toString();
      const confirmed = this.wallet.get_tx(utxo.outpoint.txid)?.chain_position.is_confirmed ?? false;
      if (reserved.has(outpoint) || (!confirmed && utxo.keychain === "external")) builder = builder.add_unspendable(utxo.outpoint);
    }
    let psbt;
    try { psbt = builder.finish(); }
    catch (error) {
      const data = (error as { data?: { needed?: number; available?: number } }).data;
      if ((error as { code?: number }).code === bdk.BdkErrorCode.InsufficientFunds && data) throw Object.assign(new Error(`Not enough confirmed sats: ${data.available ?? 0} available, ${data.needed ?? "more"} needed with the fee`), { cause: error });
      throw Object.assign(new Error(`Could not build the transaction: ${message(error)}`), { cause: error });
    }
    const fee = sats(psbt.fee());
    if (fee > feeCap) throw new Error(`The fee (${fee} sats) is above your limit of ${feeCap}`);
    if (!this.wallet.sign(psbt, new bdk.SignOptions())) throw new Error("Could not sign the transaction");
    const tx = psbt.extract_tx();
    this.check(tx, recipient.script_pubkey.to_hex_string(), amount, fee);
    const txid = tx.compute_txid().toString();
    this.reserved.push({ txid, outpoints: tx.input.map((input) => input.previous_output.toString()), at: Date.now() });
    this.persist();
    // The rate it was built at; the signatures may come out a byte shorter than BDK's estimate.
    return { txid, address, amount, fee, feeRate, signed: hex(tx.to_bytes()) };
  }

  /** What was signed is what was reviewed: one output of exactly the amount to the address, the rest ours. */
  private check(tx: Transaction, recipient: string, amount: number, fee: number) {
    let paid = 0, outgoing = 0;
    for (const output of tx.output) {
      const value = sats(output.value);
      if (output.script_pubkey.to_hex_string() === recipient && value === amount && !paid) { paid++; continue; }
      if (!this.wallet.is_mine(output.script_pubkey)) outgoing++;
    }
    if (paid !== 1 || outgoing !== 0 || sats(this.wallet.calculate_fee(tx)) !== fee) throw new Error("The signed transaction does not match the payment");
  }

  private async estimateFeeRate(): Promise<number> {
    try {
      const estimates = await this.esplora.json<Record<string, number>>("/fee-estimates");
      const rate = estimates["3"] ?? estimates["6"] ?? estimates["1"];
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) return Math.max(1, rate);
    } catch { /* A test network often has none: the minimum relays there. */ }
    return 1;
  }

  async broadcast(prepared: OnchainPrepared): Promise<string> {
    let tx: Transaction;
    try { tx = this.bdk.Transaction.from_bytes(unhex(prepared.signed)); }
    catch { throw new NothingSpentError("The prepared transaction is damaged: it was not sent"); }
    if (tx.compute_txid().toString() !== prepared.txid) throw new NothingSpentError("The prepared transaction is not the one reviewed: it was not sent");
    let answer: { status: number; body: string };
    // No answer (the network, a time-out): it may have arrived. Unknown, reconciled by txid.
    try { answer = await this.esplora.request("/tx", { method: "POST", body: prepared.signed, headers: { "content-type": "text/plain" } }); }
    catch (error) { throw Object.assign(new Error(`No answer from the Esplora server: ${message(error)}`), { cause: error }); }
    if (answer.status === 200 && answer.body.trim() === prepared.txid) return this.sent(tx, prepared.txid);
    if (answer.status === 200) throw new Error("The Esplora server answered with another transaction id");
    if (/already[ -](in|known)|outputs already in utxo set|-27\b/i.test(answer.body)) return this.sent(tx, prepared.txid);
    // Refused by the node (400): certain only if no one knows this transaction afterwards.
    if (answer.status === 400) {
      let known: Awaited<ReturnType<Esplora["txStatus"]>>;
      try { known = await this.esplora.txStatus(prepared.txid); }
      catch (error) { throw Object.assign(new Error(`The node refused the transaction, and it could not be checked: ${message(error)}`), { cause: error }); }
      if (known) return this.sent(tx, prepared.txid);
      this.unreserve(prepared.txid);
      throw new NothingSpentError(`The node refused the transaction: ${answer.body.slice(0, 160)}`);
    }
    throw new Error(`The Esplora server answered ${answer.status}`);
  }

  /** It is out: the wallet counts it at once (the balance, the history), and its coins are no longer reserved. */
  private sent(tx: Transaction, txid: string) {
    if (!this.wallet.get_tx(tx.compute_txid())) this.wallet.apply_unconfirmed_txs([new this.bdk.UnconfirmedTx(tx, BigInt(Math.floor(Date.now() / 1000)))]);
    this.unreserve(txid);
    this.persist();
    return txid;
  }

  async status(prepared: OnchainPrepared): Promise<OnchainTxStatus> {
    const known = await this.esplora.txStatus(prepared.txid);
    if (known?.confirmed && known.block_height !== undefined) {
      const tip = Number(await this.esplora.text("/blocks/tip/height"));
      return { state: "confirmed", confirmations: Math.max(1, tip - known.block_height + 1) };
    }
    if (known) return { state: "mempool", confirmations: 0 };
    // Unknown to the server: dropped or never arrived, unless another transaction spent the same coins.
    const tx = this.bdk.Transaction.from_bytes(unhex(prepared.signed));
    for (const input of tx.input.slice(0, 50)) {
      const { txid, vout } = input.previous_output;
      const spent = await this.esplora.json<{ spent: boolean; txid?: string }>(`/tx/${txid.toString()}/outspend/${vout}`);
      if (spent.spent && spent.txid && spent.txid !== prepared.txid) return { state: "conflicted", confirmations: 0 };
    }
    return { state: "missing", confirmations: 0 };
  }

  async release(prepared: OnchainPrepared): Promise<void> { this.unreserve(prepared.txid); }

  private unreserve(txid: string) {
    const before = this.reserved.length;
    this.reserved = this.reserved.filter((r) => r.txid !== txid);
    if (this.reserved.length !== before) this.persist();
  }

  async history(limit: number): Promise<OnchainTx[]> {
    await this.sync();
    const tip = this.wallet.latest_checkpoint.height;
    const txs = this.wallet.transactions().map((wtx) => {
      const [sent, received] = [sats(this.wallet.sent_and_received(wtx.tx)[0]), sats(this.wallet.sent_and_received(wtx.tx)[1])];
      let fee: number | undefined;
      if (sent > 0) try { fee = sats(this.wallet.calculate_fee(wtx.tx)); } catch { fee = undefined; }
      const anchor = wtx.chain_position.anchor;
      const height = anchor?.block_id.height;
      const seconds = anchor ? anchor.confirmation_time : wtx.chain_position.first_seen ?? wtx.chain_position.last_seen;
      return {
        txid: wtx.txid.toString(),
        amount: sent > 0 ? received - sent + (fee ?? 0) : received,
        ...(fee !== undefined ? { fee } : {}),
        confirmations: height !== undefined ? Math.max(1, tip - height + 1) : 0,
        ...(seconds !== undefined ? { timestamp: Number(seconds) * 1000 } : {}),
      };
    });
    // Unconfirmed first, then the newest block first.
    return txs.sort((a, b) => a.confirmations - b.confirmations || (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, limit);
  }

  async received(address: string): Promise<OnchainTx[]> {
    if (!isBitcoinAddress(address, this.config.network)) return [];
    const script = this.bdk.Address.from_string(address, CHAIN[this.config.network]).script_pubkey.to_hex_string();
    await this.sync();
    const tip = this.wallet.latest_checkpoint.height;
    const paid: OnchainTx[] = [];
    for (const wtx of this.wallet.transactions()) {
      const amount = wtx.tx.output.reduce((sum, output) => sum + (output.script_pubkey.to_hex_string() === script ? sats(output.value) : 0), 0);
      if (!amount) continue;
      const height = wtx.chain_position.anchor?.block_id.height;
      paid.push({ txid: wtx.txid.toString(), amount, confirmations: height !== undefined ? Math.max(1, tip - height + 1) : 0 });
    }
    return paid.sort((a, b) => a.confirmations - b.confirmations);
  }

  /** Writes BDK's changes (merged into what is stored) and the reservations, in order. */
  private persist() {
    const staged = this.wallet.take_staged();
    if (staged) { if (this.changeset) this.changeset.merge(staged); else this.changeset = staged; }
    if (!this.changeset) return;
    const value: StoredBdk = { changeset: this.changeset.to_json(), reserved: this.reserved, scanned: this.scanned };
    this.writes = this.writes.then(() => this.store.save(this.key, value)).catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
  }
}

const FIELDS = [
  { name: "network", label: "Network", kind: "select", options: [{ value: "signet", label: "Signet" }, { value: "mutinynet", label: "Mutinynet" }, { value: "regtest", label: "Regtest" }], defaults: { testnet: "signet" } },
  { name: "esplora", label: "Esplora server", kind: "url", optional: true, placeholder: "https://mempool.space/signet/api",
    help: "Blank: mempool.space for Signet, mutinynet.com for Mutinynet. Regtest needs your own; it must allow this app's origin (CORS)." },
  { name: "script", label: "Addresses", kind: "select", options: [{ value: "bip84", label: "Native SegWit (BIP84, bc1q…)" }, { value: "bip86", label: "Taproot (BIP86, bc1p…)" }] },
  { name: "mnemonic", label: "Recovery phrase", kind: "secret", placeholder: "twelve or twenty-four words", help: "BIP39, English. Leave it to Ghostly to make a new wallet, or type yours to restore one." },
] as const satisfies OnchainProviderDescriptor["fields"];

export const bdk: OnchainProviderDescriptor = {
  id: "bdk",
  label: "BDK wallet",
  kind: "onchain",
  description: "A Bitcoin wallet in this app (bitcoindevkit): you hold the keys, an Esplora server tells it the chain. Test networks only for now.",
  // Mainnet waits: no backup of the phrase from the app yet, and no RBF / fee bump for a stuck payment.
  networks: ["signet", "mutinynet", "regtest"],
  platforms: ["web", "extension", "desktop"],
  fields: FIELDS,
  experimental: true,
  validate(settings: ProviderSettings, mode: WalletMode) {
    if (mode !== "testnet") throw new Error("The BDK wallet runs on test networks only for now");
    parseBdkSettings(settings);
  },
  async create(settings, host) { return BdkOnchain.open(settings, host); },
};
