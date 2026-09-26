import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { SPARK_NETWORKS, SPARK_PROVIDER, type PaymentTarget, type SparkNetwork, type WalletNetwork } from "@ghostly/core";
import { store, STORES, transact, wrap } from "../../shared/idb";
import type { WalletMode } from "../../shared/mints";
import { ModeChanged, ModeGate, WrongNetworkError, networkLabel } from "./modeGate";
import { walletKey } from "./walletNetworks";
import { intentRepository, newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "./persistence";
import { loadBreezSdk, type BreezSdkModule } from "./providers/breezSdk";
import { SPARK_INVOICE_SECS, SparkAdapter, type SparkHistoryEntry } from "./spark";
import type { SavedIntent } from "./coordinator";

export interface SparkWalletView {
  configured: boolean; locked: boolean;
  /** Why there is no Spark wallet on this network yet (Mainnet without a Breez API key), shown instead of one. */
  unavailable?: string;
  /** Mainnet: a Breez API key would make one. */
  needsKey?: boolean;
  network?: SparkNetwork;
  /** The wallet's Spark address (`spark1…`, `sparkrt1…`): the same every time. */
  address?: string;
  balance: number;
  history?: SparkHistoryEntry[];
  error?: string;
}
interface StoredSpark { network: SparkNetwork; seed: EncryptedSeed; deviceKey: string; apiKey?: EncryptedSeed; createdAt: number }
export interface SparkCreate { network: SparkNetwork; mnemonic?: string; apiKey?: string }

export const SPARK_MAINNET_NEEDS_KEY = "Spark on Mainnet needs a Breez API key (free, from Breez). Mainnet moves real bitcoin.";
export const sparkMode = (network: SparkNetwork): WalletMode => network === "bitcoin" ? "mainnet" : "testnet";
export const sparkNetworkFor = (network: WalletNetwork): SparkNetwork => network === "mainnet" ? "bitcoin" : "regtest";
/** How often the page's balance and history are read while the wallet is open. */
export const sparkTiming = { pollMs: 10_000, retryMs: 30_000 };

/**
 * The Spark wallet of one network, under its own key: Testnet's runs on Breez's regtest with no key; Mainnet's needs
 * a Breez API key.
 */
export class SparkWallet {
  private readonly key: string;
  private saved?: StoredSpark;
  private timer?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private readying?: Promise<void>;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private gate = new ModeGate();
  adapter?: SparkAdapter;
  view: SparkWalletView = { configured: false, locked: true, balance: 0 };
  constructor(readonly network: WalletNetwork, private changed: () => void, private sdk: () => Promise<BreezSdkModule> = loadBreezSdk) { this.key = walletKey("sparkWallet", network); }
  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next; }
  private idle(saved?: StoredSpark): SparkWalletView {
    const needsKey = !saved && this.network === "mainnet";
    return { configured: !!saved, locked: true, balance: 0, network: saved?.network ?? sparkNetworkFor(this.network), ...(needsKey ? { needsKey, unavailable: SPARK_MAINNET_NEEDS_KEY } : {}) };
  }
  async start() { this.saved = await wrap<StoredSpark | undefined>((await store(STORES.settings, "readonly")).get(this.key)); this.view = this.idle(this.saved); }
  get configured() { return !!this.saved; }
  /** A creation waiting on Spark gives up now, saving nothing. */
  cutShort() { this.gate.interrupt(); }
  resume() { this.gate.resume(); }

  /** Opens the wallet; `create`: makes Testnet's regtest wallet first when there is none. Retries while Spark is unreachable. */
  ensureReady(create = false): Promise<void> {
    if (this.readying) return this.readying.then(() => this.needsReady(create) ? this.startReady(create) : undefined);
    return this.startReady(create);
  }
  private startReady(create: boolean): Promise<void> { return this.readying ??= this.ready(create).finally(() => { this.readying = undefined; }); }
  private needsReady(create: boolean) { return !this.stopped && (this.saved ? !this.adapter : create && this.network === "testnet"); }
  private async ready(create: boolean) {
    clearTimeout(this.retry);
    try {
      if (!this.saved) { if (create) await this.serial(async () => { if (!this.saved && this.network === "testnet") await this.createNow({ network: "regtest" }); }); }
      else if (!this.adapter) await this.serial(() => this.stopped ? Promise.resolve() : this.open());
    } catch (error) {
      if (this.stopped || error instanceof ModeChanged) return;
      this.view = { ...this.view, error: `Connecting to Spark… ${error instanceof Error ? error.message : ""}`.trim() }; this.changed();
      this.retry = setTimeout(() => void this.ensureReady(create), sparkTiming.retryMs);
    }
  }

  /** A new wallet (or one restored from `mnemonic`) on `network`; Mainnet only with an API key. */
  create(params: SparkCreate) { return this.serial(() => this.createNow(params)); }
  private async createNow(params: SparkCreate) {
    if (!SPARK_NETWORKS.includes(params.network)) throw new Error("Unsupported Spark network");
    if (sparkMode(params.network) !== this.network) throw new WrongNetworkError(sparkMode(params.network), `${params.network === "bitcoin" ? "Bitcoin" : params.network} is a ${networkLabel(sparkMode(params.network))} network: this is the ${networkLabel(this.network)} Spark wallet`);
    const apiKey = params.apiKey?.trim() || undefined;
    if (params.network === "bitcoin" && !apiKey) throw new Error(SPARK_MAINNET_NEEDS_KEY);
    const mnemonic = params.mnemonic?.trim().toLowerCase().split(/\s+/).join(" ") || generateMnemonic(wordlist);
    if (!validateMnemonic(mnemonic, wordlist)) throw new Error("Invalid recovery phrase");
    const replaced = this.saved && await this.retirable("This Spark wallet already has funds or payments; it will not be replaced");
    let adapter: SparkAdapter | undefined;
    try {
      // Opened before it is saved: a key Breez refuses, or no Spark at all, leaves nothing behind.
      adapter = await this.gate.within(SparkAdapter.connect({ network: params.network, mnemonic, apiKey }, this.sdk), (a) => a.close());
      const deviceKey = newDeviceKey();
      const saved: StoredSpark = { network: params.network, seed: await sealSeed(mnemonic, deviceKey), deviceKey, apiKey: apiKey ? await sealSeed(apiKey, deviceKey) : undefined, createdAt: Date.now() };
      await this.save(saved, replaced || undefined);
      this.saved = saved;
    } catch (error) {
      await adapter?.close();
      if (replaced) void this.ensureReady();
      throw error;
    }
    this.adapter = adapter; this.view = { ...this.idle(this.saved), locked: false }; await this.refresh();
  }
  private async open() {
    if (!this.saved || this.adapter) return;
    const { mnemonic, apiKey } = await this.secrets();
    this.adapter = await this.gate.within(SparkAdapter.connect({ network: this.saved.network, mnemonic, apiKey }, this.sdk), (a) => a.close());
    this.view = { ...this.view, locked: false }; await this.refresh();
  }
  private async secrets() {
    const saved = this.saved!;
    return { mnemonic: await unsealSeed(saved.seed, saved.deviceKey), apiKey: saved.apiKey ? await unsealSeed(saved.apiKey, saved.deviceKey) : undefined };
  }

  async stop() { this.stopped = true; this.gate.close(); await this.serial(() => this.lock()); }
  /** The person removes this wallet (see ArkWallet.remove): closed and its record, with its sealed seed, deleted. */
  remove(): Promise<void> {
    this.gate.interrupt();
    return this.serial(async () => {
      await this.lock();
      await transact([STORES.settings], (s) => { s[STORES.settings].delete(this.key); });
      this.saved = undefined;
      this.view = this.idle(); this.changed();
    }).finally(() => this.gate.resume());
  }
  async lock() { clearTimeout(this.timer); clearTimeout(this.retry); const adapter = this.adapter; this.adapter = undefined; this.view = { ...this.view, locked: true }; this.changed(); await adapter?.close(); }

  async refresh() { await this.poll().catch((error) => { if (!(error instanceof ModeChanged)) throw error; }); }
  private async poll() {
    clearTimeout(this.timer);
    const adapter = this.adapter;
    if (!adapter) return;
    const failed: string[] = [];
    const read = async <T>(what: string, work: () => Promise<T>, previous: T): Promise<T> => { try { return await this.gate.within(work()); } catch (error) { if (error instanceof ModeChanged) throw error; failed.push(what); console.warn(`Spark ${what}:`, error instanceof Error ? error.message : error); return previous; } };
    const address = await read("address", () => adapter.address(), this.view.address);
    if (this.adapter !== adapter) return;
    if (address !== this.view.address) { this.view = { ...this.view, locked: false, address }; this.changed(); }
    const balance = await read("balance", () => adapter.balance(), this.view.balance);
    const history = await read("history", () => adapter.history(), this.view.history);
    if (this.adapter !== adapter) return;
    this.view = { ...this.idle(this.saved), locked: false, address, balance, history, error: failed.length ? `Could not read the ${failed.join(", ")} from Spark. Last values may be stale.` : undefined };
    this.changed();
    if (this.adapter) this.timer = setTimeout(() => void this.refresh(), sparkTiming.pollMs);
  }

  /** Where a contact pays one request: a Spark invoice made for it (its amount, its memo, a quarter of an hour). */
  async target(amount: number, memo?: string): Promise<PaymentTarget> {
    const adapter = this.require();
    const expiresAt = Date.now() + SPARK_INVOICE_SECS * 1000;
    return { method: "spark", network: adapter.network, provider: SPARK_PROVIDER, asset: "BTC", unit: "sat", address: await adapter.invoice(amount, memo, expiresAt), expiresAt };
  }
  require() { if (!this.adapter) throw new Error(this.view.unavailable ?? "Wait for your Spark wallet to connect"); return this.adapter; }
  /** The phrase (and Mainnet's API key): what the Breez Lightning source needs to be this same wallet. */
  async backup(): Promise<{ mnemonic: string; network: SparkNetwork; apiKey?: string }> {
    if (!this.saved) throw new Error("No Spark wallet to back up");
    return { ...await this.secrets(), network: this.saved.network };
  }
  /** The phrase and the Spark payments, sealed with a password. Spark keeps the coins: the phrase brings them back. */
  async exportBackup(password: string): Promise<string> {
    if (password.length < 12) throw new Error("Use at least 12 characters for the backup password");
    const { mnemonic, network } = await this.backup();
    const intents = (await intentRepository.list()).filter((i) => i.review.method === "spark" && sparkMode(i.review.network as SparkNetwork) === this.network);
    return JSON.stringify({ format: "ghostly-spark-encrypted", version: 1, vault: await sealSeed(JSON.stringify({ format: "ghostly-spark", version: 1, mnemonic, network, intents }), password) });
  }
  /** The API key is not in the file: it is Breez's to Ghostly's user, asked again on Mainnet. */
  restoreBackup(text: string, password: string, apiKey?: string): Promise<void> { return this.serial(async () => {
    if (text.length > 16 * 1024 * 1024) throw new Error("Spark backup is too large");
    const envelope = JSON.parse(text);
    if (envelope.format !== "ghostly-spark-encrypted" || envelope.version !== 1) throw new Error("Unsupported Spark backup");
    const payload = JSON.parse(await unsealSeed(envelope.vault, password)) as { format: string; version: number; mnemonic: string; network: SparkNetwork; intents: SavedIntent[] };
    if (payload.format !== "ghostly-spark" || payload.version !== 1 || !validateMnemonic(payload.mnemonic, wordlist) || !Array.isArray(payload.intents)) throw new Error("Invalid Spark backup");
    if (!SPARK_NETWORKS.includes(payload.network)) throw new Error("Unsupported Spark network in backup");
    if (sparkMode(payload.network) !== this.network) throw new WrongNetworkError(sparkMode(payload.network), `This backup is a ${networkLabel(sparkMode(payload.network))} Spark wallet`);
    if (payload.intents.some((i) => i.review.method !== "spark" || i.review.network !== payload.network)) throw new Error("Backup payments do not match its wallet");
    const key = apiKey?.trim() || (this.saved?.apiKey ? await unsealSeed(this.saved.apiKey, this.saved.deviceKey) : undefined);
    if (payload.network === "bitcoin" && !key) throw new Error(SPARK_MAINNET_NEEDS_KEY);
    const replaced = this.saved && await this.retirable("Restore into a fresh profile or an unused wallet; this wallet will not be replaced");
    const deviceKey = newDeviceKey();
    const saved: StoredSpark = { network: payload.network, seed: await sealSeed(payload.mnemonic, deviceKey), deviceKey, apiKey: key ? await sealSeed(key, deviceKey) : undefined, createdAt: Date.now() };
    await this.save(saved, replaced || undefined, payload.intents.map((intent) => ({ ...intent, review: { ...intent.review, state: ["pending", "submitted", "unknown"].includes(intent.review.state) ? "unknown" : intent.review.state } })));
    this.saved = saved; this.view = this.idle(saved); this.changed();
  }); }
  /**
   * The current wallet may make way for a restore only while it has never paid or been paid and holds nothing. It
   * is archived, not deleted, so its phrase survives a mistake.
   */
  private async retirable(refusal: string): Promise<StoredSpark> {
    const saved = this.saved!;
    if ((await intentRepository.list()).some((i) => i.review.method === "spark" && i.review.network === saved.network)) throw new Error(refusal);
    if (this.adapter && (await this.gate.within(this.adapter.balance()) > 0 || (await this.gate.within(this.adapter.history(1))).length)) throw new Error(refusal);
    await this.lock();
    return saved;
  }
  private async save(saved: StoredSpark, retired?: StoredSpark, intents: SavedIntent[] = []) {
    await transact([STORES.settings, STORES.intents], (stores) => {
      if (retired) stores[STORES.settings].put(retired, `sparkWallet-retired-${Date.now()}`);
      stores[STORES.settings].put(saved, this.key);
      for (const intent of intents) stores[STORES.intents].add(intent);
    });
  }
}
