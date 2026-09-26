import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { PaymentTarget, WalletNetwork } from "@ghostly/core";
import { store, STORES, transact, wrap } from "../../shared/idb";
import type { WalletMode } from "../../shared/mints";
import { BARK_NETWORKS, BarkAdapter, barkDatabase, serverInfo, type BarkConfig, type BarkExpiry } from "./bark";
import { loadBarkSdk, type BarkNetwork, type BarkSdk } from "./barkSdk";
import { ModeChanged, ModeGate, WrongNetworkError, networkLabel } from "./modeGate";
import { walletKey } from "./walletNetworks";
import { intentRepository, newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "./persistence";
import type { SavedIntent } from "./coordinator";

export interface BarkWalletView {
  configured: boolean; locked: boolean;
  network?: BarkNetwork; provider?: string; address?: string; onchainAddress?: string;
  /** The server's terms of service, when it publishes them (Second's Bitcoin server does). */
  terms?: string;
  /** Blocks until this wallet's first coin expires (none without coins), and a coin's whole life on this server. */
  expiry?: BarkExpiry;
  /** Spendable now. */
  balance: number;
  /** In a round, a board or a Lightning send: this wallet's, not spendable yet. */
  pending?: number;
  /** On its way back on-chain through a unilateral exit. */
  exiting?: number;
  /** On-chain coins of this wallet not moved into Ark yet. */
  onchain?: number;
  error?: string;
}
interface StoredBark { config: BarkConfig; seed: EncryptedSeed; deviceKey: string }
export interface BarkCreate { network: BarkNetwork; provider: string; explorer: string; mnemonic?: string }

/**
 * Second's public servers and their Esplora (https://second.tech/docs/connection-details; their docs ask not to swap
 * the Esplora: it relays packages). Bitcoin since 2026-06-09.
 */
export const TESTNET_BARK = { network: "signet", provider: "https://ark.signet.2nd.dev", explorer: "https://esplora.signet.2nd.dev" } as const satisfies BarkCreate;
export const MAINNET_BARK = { network: "bitcoin", provider: "https://ark.second.tech", explorer: "https://mempool.second.tech/api" } as const satisfies BarkCreate;
/** The terms Second's Bitcoin server links to from its own server information (`tos_link`). */
export const SECOND_TERMS = "https://second.tech/terms";
const TERMS: Record<string, string> = { [MAINNET_BARK.provider]: SECOND_TERMS };
/** The defaults a new wallet of this network is made with, in one click. */
export const barkDefaults = (network: WalletNetwork): BarkCreate => network === "testnet" ? TESTNET_BARK : MAINNET_BARK;
export const barkMode = (network: BarkNetwork): WalletMode => network === "bitcoin" ? "mainnet" : "testnet";
/**
 * An SDK error as a person reads it: the WebAssembly's own words up to where it starts quoting JavaScript values and
 * stack frames ("…: JsValue(TypeError: Failed to fetch at __wbg_fetch… wasm-function[3134]…"), bounded.
 */
export function readableBarkError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (message === undefined) return error;
  const text = message.split(/:?\s*JsValue\(|\s+at\s+\S+\s+\(/)[0].trim();
  if (error instanceof Error && text === message && text.length <= 240) return error;
  return new Error(text.length > 240 ? `${text.slice(0, 239)}…` : text || "The Bark SDK failed");
}
const forget = async (walletId: string) => {
  for (const name of [barkDatabase(walletId), `${barkDatabase(walletId)}-onchain`]) {
    await new Promise<void>((resolve) => { try { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); } catch { resolve(); } });
  }
};

/** The Bark wallet of one network, under its own key (see walletNetworks.ts). */
export class BarkWallet {
  private readonly key: string;
  private saved?: StoredBark;
  private timer?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private readying?: Promise<void>;
  private stopped = false;
  private lastMaintenance = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private gate = new ModeGate();
  adapter?: BarkAdapter;
  view: BarkWalletView = { configured: false, locked: true, balance: 0 };
  constructor(readonly network: WalletNetwork, private changed: () => void, private sdk: () => Promise<BarkSdk> = loadBarkSdk) { this.key = walletKey("barkWallet", network); }
  /** Creating, replacing and restoring never interleave: two of them could each think the profile is empty. */
  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next; }
  private idle(config?: BarkConfig): BarkWalletView {
    return { configured: !!config, locked: true, balance: 0, network: config?.network, provider: config?.provider, terms: config && TERMS[config.provider] };
  }
  async start() { this.saved = await wrap<StoredBark | undefined>((await store(STORES.settings, "readonly")).get(this.key)); this.view = this.idle(this.saved?.config); }
  get configured() { return !!this.saved; }
  /** A creation waiting on its server gives up now, saving nothing. */
  cutShort() { this.gate.interrupt(); }
  resume() { this.gate.resume(); }

  /** Opens the wallet; `create`: makes this network's default one first when there is none. Retries while the server is unreachable. */
  ensureReady(create = false): Promise<void> {
    if (this.readying) return this.readying.then(() => this.needsReady(create) ? this.startReady(create) : undefined);
    return this.startReady(create);
  }
  private startReady(create: boolean): Promise<void> { return this.readying ??= this.ready(create).finally(() => { this.readying = undefined; }); }
  private needsReady(create: boolean) { return !this.stopped && (this.saved ? !this.adapter : create); }
  private async ready(create: boolean) {
    clearTimeout(this.retry);
    try {
      if (!this.saved) { if (create) await this.serial(async () => { if (!this.saved) await this.createNow({ ...barkDefaults(this.network) }); }); }
      else if (!this.adapter) await this.serial(() => this.stopped ? Promise.resolve() : this.open());
    } catch (error) {
      if (this.stopped || error instanceof ModeChanged) return;
      const readable = readableBarkError(error);
      this.view = { ...this.view, error: `Connecting to Bark… ${readable instanceof Error ? readable.message : ""}`.trim() }; this.changed();
      this.retry = setTimeout(() => void this.ensureReady(create), 30000);
    }
  }
  /** A wallet of this network on its default server, made now: it answers first, or nothing is saved. */
  createDefaultNow() {
    return this.serial(async () => {
      if (this.saved) throw new Error(`There is already a ${networkLabel(this.network)} Bark wallet`);
      await this.createNow({ ...barkDefaults(this.network) });
    });
  }
  create(params: BarkCreate) { return this.serial(() => this.createNow(params)); }
  private async createNow(params: BarkCreate) {
    if (!BARK_NETWORKS.includes(params.network)) throw new Error("Unsupported Bark network");
    if (barkMode(params.network) !== this.network) throw new WrongNetworkError(barkMode(params.network), `${params.network === "bitcoin" ? "Bitcoin" : params.network} is a ${networkLabel(barkMode(params.network))} network: this is the ${networkLabel(this.network)} Bark wallet`);
    const provider = params.provider.replace(/\/$/, ""), explorer = params.explorer.replace(/\/$/, "");
    BarkAdapter.checkConfig({ network: params.network, provider, explorer });
    const mnemonic = params.mnemonic?.trim() || generateMnemonic(wordlist);
    if (!validateMnemonic(mnemonic, wordlist)) throw new Error("Invalid recovery phrase");
    const replaced = this.saved && await this.retirable("This Bark wallet already has funds or payments; it will not be replaced");
    const deviceKey = newDeviceKey();
    const draft: BarkConfig = { network: params.network, provider, explorer, serverKey: "", walletId: crypto.randomUUID() };
    let adapter: BarkAdapter | undefined;
    try {
      // The server key is learnt once, here, and pinned: every later open and payment checks it.
      const serverKey = await this.gate.within(this.serverKey(draft, mnemonic));
      const config = { ...draft, serverKey };
      adapter = await this.gate.within(BarkAdapter.connect(config, mnemonic, { sdk: await this.sdk(), restore: !!params.mnemonic }), (a) => a.dispose());
      const saved: StoredBark = { config, seed: await sealSeed(mnemonic, deviceKey), deviceKey };
      await this.save(saved, replaced || undefined);
      this.saved = saved;
    } catch (error) {
      await adapter?.dispose();
      // Never saved, never shown: its local database goes, or every retry while the server is away leaves one.
      if (this.saved?.config.walletId !== draft.walletId) await forget(draft.walletId);
      if (replaced) void this.ensureReady();
      throw readableBarkError(error);
    }
    this.adapter = adapter; this.view = { ...this.idle(this.saved.config), locked: false }; await this.refresh();
  }
  /** Opens the wallet (made just for this) with no key pinned yet, to read the server's. */
  private async serverKey(config: BarkConfig, mnemonic: string) {
    const { wallet, onchain } = await (await this.sdk()).open({ network: config.network, mnemonic, server: config.provider, esplora: config.explorer, database: barkDatabase(config.walletId) });
    try {
      const info = await serverInfo(wallet);
      const expected = { bitcoin: "Bitcoin", signet: "Signet", regtest: "Regtest" }[config.network];
      if (info.network !== expected) throw new Error(`That Bark server does not run on ${config.network}`);
      return info.serverPubkey;
    } finally { await wallet.stopDaemonWait().catch(() => {}); wallet.free(); onchain.free(); }
  }
  private async open() {
    if (!this.saved || this.adapter) return;
    const mnemonic = await unsealSeed(this.saved.seed, this.saved.deviceKey);
    this.adapter = await this.gate.within(BarkAdapter.connect(this.saved.config, mnemonic, { sdk: await this.sdk() }), (a) => a.dispose());
    this.view = { ...this.view, locked: false }; await this.refresh();
  }
  /** Shutting down: nothing reconnects afterwards. */
  async stop() { this.stopped = true; this.gate.close(); await this.serial(() => this.lock()); }
  /** The person removes this wallet (see ArkWallet.remove): closed, its record and its databases deleted. */
  remove(): Promise<void> {
    this.gate.interrupt();
    return this.serial(async () => {
      const saved = this.saved;
      await this.lock();
      await transact([STORES.settings], (s) => { s[STORES.settings].delete(this.key); });
      this.saved = undefined;
      if (saved) await forget(saved.config.walletId);
      this.view = this.idle(); this.changed();
    }).finally(() => this.gate.resume());
  }
  async lock() { clearTimeout(this.timer); clearTimeout(this.retry); const adapter = this.adapter; this.adapter = undefined; this.view = { ...this.view, locked: true, address: undefined }; this.changed(); await adapter?.dispose(); }

  /** Stopping ends it where it is: a wallet shutting down needs no balance. */
  async refresh() { await this.poll().catch((error) => { if (!(error instanceof ModeChanged)) throw error; }); }
  private async poll() {
    clearTimeout(this.timer);
    const adapter = this.adapter;
    if (!adapter) return;
    const failed: string[] = [];
    const read = async <T>(what: string, work: () => Promise<T>, previous: T): Promise<T> => { try { return await this.gate.within(work()); } catch (error) { if (error instanceof ModeChanged) throw error; failed.push(what); console.warn(`Bark ${what}:`, error instanceof Error ? error.message : error); return previous; } };
    // The address is this wallet's own: show it before asking the server anything.
    const address = await read("address", () => adapter.address(), this.view.address);
    const onchainAddress = this.view.onchainAddress ?? await read("on-chain address", () => adapter.onchainAddress(), undefined);
    if (this.adapter !== adapter) return;
    if (address !== this.view.address || onchainAddress !== this.view.onchainAddress) { this.view = { ...this.view, locked: false, address, onchainAddress }; this.changed(); }
    await read("sync", () => adapter.sync(), undefined);
    const balance = await read("balance", () => adapter.balance(), undefined);
    const onchain = await read("on-chain balance", () => adapter.onchainBalance(), undefined);
    const expiry = await read("coin expiry", () => adapter.expiry(), this.view.expiry);
    // Renewing what is close to expiry keeps money left alone spendable: every few minutes is plenty.
    if (Date.now() - this.lastMaintenance > 5 * 60_000) { this.lastMaintenance = Date.now(); void adapter.maintain().catch((error) => console.warn("Bark maintenance:", error instanceof Error ? error.message : error)); }
    if (this.adapter !== adapter) return;
    this.view = {
      ...this.idle(adapter.config), locked: false, address, onchainAddress,
      balance: balance?.spendableSats ?? this.view.balance,
      pending: balance ? balance.pendingInRoundSats + balance.pendingBoardSats + balance.pendingLightningSendSats + balance.claimableLightningReceiveSats : this.view.pending,
      exiting: balance?.pendingExitSats ?? this.view.exiting,
      onchain: onchain?.totalSats ?? this.view.onchain,
      expiry,
      error: failed.length ? `Could not read the ${failed.join(", ")} from the Bark server. Last values may be stale.` : undefined,
    };
    this.changed();
    if (this.adapter) this.timer = setTimeout(() => void this.refresh(), 10000);
  }
  /** On-chain coins into Ark: the board confirms on-chain, then they are spendable. */
  async board(): Promise<string> { const pending = await this.require().board(); await this.refresh(); return pending.txid; }
  async target(): Promise<PaymentTarget> { const adapter = this.require(); return { method: "bark", network: adapter.config.network, provider: adapter.config.provider, asset: "BTC", unit: "sat", address: await adapter.requestAddress(), expiresAt: Date.now() + 15 * 60 * 1000 }; }
  require() { if (!this.adapter) throw new Error("Wait for your Bark wallet to connect"); return this.adapter; }
  async backup() { if (!this.saved) throw new Error("No Bark wallet to back up"); return { mnemonic: await unsealSeed(this.saved.seed, this.saved.deviceKey), config: this.saved.config }; }
  /**
   * The phrase, the server and the payments, sealed with a password the person chooses. Bark keeps no copy of
   * the wallet's coins to restore from: with the phrase, the server hands back what it holds for this wallet.
   */
  async exportBackup(password: string): Promise<string> {
    if (password.length < 12) throw new Error("Use at least 12 characters for the backup password");
    const { mnemonic, config } = await this.backup();
    const intents = (await intentRepository.list()).filter((i) => this.ours(i));
    return JSON.stringify({ format: "ghostly-bark-encrypted", version: 1, vault: await sealSeed(JSON.stringify({ format: "ghostly-bark", version: 1, mnemonic, config, intents }), password) });
  }
  restoreBackup(text: string, password: string): Promise<void> { return this.serial(async () => {
    if (text.length > 16 * 1024 * 1024) throw new Error("Bark backup is too large");
    const envelope = JSON.parse(text);
    if (envelope.format !== "ghostly-bark-encrypted" || envelope.version !== 1) throw new Error("Unsupported Bark backup");
    const payload = JSON.parse(await unsealSeed(envelope.vault, password)) as { format: string; version: number; mnemonic: string; config: BarkConfig; intents: SavedIntent[] };
    if (payload.format !== "ghostly-bark" || payload.version !== 1 || !validateMnemonic(payload.mnemonic, wordlist) || !Array.isArray(payload.intents)) throw new Error("Invalid Bark backup");
    if (!BARK_NETWORKS.includes(payload.config.network)) throw new Error("Unsupported Bark network in backup");
    if (barkMode(payload.config.network) !== this.network) throw new WrongNetworkError(barkMode(payload.config.network), `This backup is a ${networkLabel(barkMode(payload.config.network))} Bark wallet`);
    if (payload.intents.some((i) => i.review.method !== "bark" || i.review.provider !== payload.config.provider || i.review.network !== payload.config.network)) throw new Error("Backup payments do not match its wallet");
    BarkAdapter.checkConfig(payload.config);
    const replaced = this.saved && await this.retirable("Restore into a fresh profile or an unused wallet; this wallet will not be replaced");
    // A new local database: the server's recovery scan fills it from the phrase on first open.
    const config: BarkConfig = { ...payload.config, walletId: crypto.randomUUID() };
    const deviceKey = newDeviceKey();
    const saved: StoredBark = { config, seed: await sealSeed(payload.mnemonic, deviceKey), deviceKey };
    await this.save(saved, replaced || undefined, payload.intents.map((intent) => ({ ...intent, review: { ...intent.review, state: ["pending", "submitted", "unknown"].includes(intent.review.state) ? "unknown" : intent.review.state } })));
    this.saved = saved; this.view = this.idle(config); this.changed();
  }); }
  /**
   * The current wallet may make way for another server or a restore only while it has never paid or been paid
   * and holds nothing. It is archived, not deleted, so its phrase survives a mistake.
   */
  private async retirable(refusal: string): Promise<StoredBark> {
    const saved = this.saved!;
    if ((await intentRepository.list()).some((i) => this.ours(i))) throw new Error(refusal);
    if (this.adapter) { const b = await this.gate.within(this.adapter.balance()); if (b.spendableSats + b.pendingInRoundSats + b.pendingBoardSats + b.pendingExitSats + b.pendingLightningSendSats + b.claimableLightningReceiveSats > 0) throw new Error(refusal); }
    await this.lock();
    return saved;
  }
  /** A payment of this wallet's network (the other network's wallet has its own). */
  private ours(intent: SavedIntent) { return intent.review.method === "bark" && barkMode(intent.review.network as BarkNetwork) === this.network; }
  private async save(saved: StoredBark, retired?: StoredBark, intents: SavedIntent[] = []) {
    await transact([STORES.settings, STORES.intents], (stores) => {
      if (retired) stores[STORES.settings].put(retired, `barkWallet-retired-${Date.now()}`);
      stores[STORES.settings].put(saved, this.key);
      for (const intent of intents) stores[STORES.intents].add(intent);
    });
  }
}
