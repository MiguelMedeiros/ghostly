import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { decodeBolt11, isFederationId, type BitcoinNetwork, type PaymentTarget } from "@ghostly/core";
import { store, STORES, transact, wrap } from "../../shared/idb";
import type { WalletMode } from "../../shared/mints";
import { fedimintDatabase, loadFedimintSdk, type FederationInfo, type FedimintClient, type FedimintOperation, type FedimintSdk, type RedeemState, type SpendState } from "./fedimintSdk";
import { ModeChanged, ModeGate } from "./modeGate";
import { intentRepository, newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "./persistence";

/**
 * The Fedimint wallet of a profile: federations joined with an invite code, per wallet mode, each holding ecash
 * of its own. Joining a federation is trusting its guardians with the sats (custodial, like a Cashu mint, but
 * run by several guardians who must agree), so the person joins each one themselves; nothing is joined by default.
 *
 * One mnemonic per profile and mode, sealed with a device key like the other wallets' seeds, set on the database
 * of every federation of that mode (the client derives a secret per federation from it). A federation is never
 * joined fresh twice with the same mnemonic: joining one again, or restoring, goes through the federation's own
 * recovery, which rebuilds the ecash from the backup the client keeps with the guardians.
 */
export interface StoredFederation extends Omit<FederationInfo, "federationId"> {
  id: string;
  /** Its client database (a file of the origin-private file system). */
  database: string;
  invite: string;
  joinedAt: number;
}
interface StoredFedimint { seed: EncryptedSeed; deviceKey: string; federations: StoredFederation[] }

export interface FedimintFederationView extends Omit<StoredFederation, "database" | "invite"> {
  /** Sats (the client counts msats; what is below a sat is not shown). */
  balance: number;
  status: "connecting" | "ready" | "error";
  error?: string;
  /** It has a Lightning gateway module (`ln`): invoices in and out through a gateway. */
  lightning: boolean;
  invite: string;
}
export type FedimintTxKind = "notes-out" | "notes-in" | "lightning-in" | "lightning-out" | "onchain";
export interface FedimintTx {
  id: string;
  federation: string;
  kind: FedimintTxKind;
  /** Sats; absent when the client did not say. */
  amount?: number;
  fee?: number;
  state: "pending" | "done" | "failed" | "taken-back";
  createdAt: number;
  /** The chat payment it belongs to. */
  paymentId?: string;
}
export interface FedimintWalletView {
  /** Why there is no Fedimint wallet in this mode (Mainnet today), shown instead of one. */
  unavailable?: string;
  federations: FedimintFederationView[];
  /** Sats, every federation of the mode. */
  balance: number;
  history: FedimintTx[];
  error?: string;
}

/**
 * Ghostly's Fedimint wallet has only been exercised on test networks, with the SDK's canary build: Mainnet joins
 * no federation yet. Setting this is the whole switch.
 */
export const FEDIMINT_MAINNET = false;
export const FEDIMINT_MAINNET_UNAVAILABLE = "Fedimint on Mainnet is not available yet. Switch the wallets to Testnet to join a test federation.";
export const MAX_FEDERATIONS = 8;
/** How long to wait before asking again about an invoice the client answered about at once (tests shorten it). */
export const fedimintTiming = { pollMs: 10_000 };
/** Notes nobody redeemed come back by themselves after this (the SDK's refund timer), whatever happens to the chat. */
export const NOTES_REFUND_SECS = 7 * 24 * 60 * 60;
const MAX_SATS = 10_000_000;
export const fedimintMode = (network: BitcoinNetwork): WalletMode => network === "bitcoin" ? "mainnet" : "testnet";
const key = (mode: WalletMode) => `fedimintWallet-${mode}`;
const sats = (msats: number) => Math.floor(msats / 1000);
export function assertFedimintAmount(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter an amount in sats");
  if (amount > MAX_SATS) throw new Error(`Amounts above ${MAX_SATS.toLocaleString()} sats are not supported`);
}
/** An invite code as the client takes it: bech32m with the prefix `fed1` (so `fed11…`), one line, bounded. */
export function normalizeInvite(text: string): string {
  const invite = text.trim();
  if (!/^fed11[02-9ac-hj-np-z]{20,2000}$/i.test(invite)) throw new Error("That is not a Fedimint invite code: it starts with fed1");
  return invite.toLowerCase();
}

/** A client operation as a line of history. */
export function historyEntry(federation: string, op: FedimintOperation): FedimintTx | undefined {
  const outcome = op.outcome;
  const text = typeof outcome === "string" ? outcome : outcome && typeof outcome === "object" ? Object.keys(outcome)[0] : undefined;
  const base = { id: op.id, federation, createdAt: op.createdAt, paymentId: op.ghostly };
  const invoiceSats = () => { const decoded = op.invoice ? decodeBolt11(op.invoice) : null; return decoded?.amountMsat ? sats(Number(decoded.amountMsat)) : undefined; };
  if (op.kind === "mint" && op.variant === "spend_o_o_b") {
    const state = text === "UserCanceledSuccess" || text === "Refunded" ? "taken-back" : text === "UserCanceledFailure" || text === "Success" ? "done" : "pending";
    return { ...base, kind: "notes-out", amount: op.amountMsats !== undefined ? sats(op.amountMsats) : undefined, state };
  }
  if (op.kind === "mint" && op.variant === "reissuance") {
    return { ...base, kind: "notes-in", amount: op.amountMsats !== undefined ? sats(op.amountMsats) : undefined, state: text === "Done" ? "done" : text === "Failed" ? "failed" : "pending" };
  }
  if (op.kind === "ln" && op.variant === "receive") {
    return { ...base, kind: "lightning-in", amount: invoiceSats(), state: text === "claimed" ? "done" : text === "canceled" ? "failed" : "pending" };
  }
  if (op.kind === "ln" && op.variant === "pay") {
    const state = text === "success" || text === "preimage" ? "done" : text === "refunded" || text === "canceled" || text === "refund_success" || text === "funding_failed" ? "failed" : "pending";
    return { ...base, kind: "lightning-out", amount: invoiceSats(), fee: op.feeMsats !== undefined ? Math.ceil(op.feeMsats / 1000) : undefined, state };
  }
  if (op.kind === "wallet") return { ...base, kind: "onchain", amount: op.amountMsats !== undefined ? sats(op.amountMsats) : undefined, state: "pending" };
  return undefined;
}

interface Receive { federation: string; operationId: string; paymentId: string; expiresAt: number }
export interface FedimintEvents {
  changed(): void;
  /** An invoice made for a chat request was paid into the federation. */
  received(paymentId: string, federation: string): void;
}

export class FedimintWallet {
  private mode: WalletMode = "mainnet";
  private saved?: StoredFedimint;
  private readonly clients = new Map<string, FedimintClient>();
  private readonly opening = new Map<string, Promise<FedimintClient>>();
  private readonly problems = new Map<string, string>();
  private readonly balances = new Map<string, number>();
  private readonly unsubscribe = new Map<string, () => void>();
  private history: FedimintTx[] = [];
  private readonly watching = new Set<string>();
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly gate = new ModeGate();
  view: FedimintWalletView = { federations: [], balance: 0, history: [] };

  constructor(private readonly events: FedimintEvents, private readonly sdk: () => Promise<FedimintSdk> = loadFedimintSdk) {}
  /** Joining, leaving and restoring never interleave: two joins could each think the profile had no mnemonic. */
  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next; }

  async start() { this.saved = await this.load(this.mode); this.render(); }
  private async load(mode: WalletMode) { return wrap<StoredFedimint | undefined>((await store(STORES.settings, "readonly")).get(key(mode))); }
  private unavailable() { return this.mode === "mainnet" && !FEDIMINT_MAINNET ? FEDIMINT_MAINNET_UNAVAILABLE : undefined; }

  /** Opens every federation of this mode. One that does not answer is tried again, the others work meanwhile. */
  ensureReady(): Promise<void> {
    clearTimeout(this.retry);
    if (this.stopped || this.unavailable()) return Promise.resolve();
    const mode = this.mode;
    return Promise.all((this.saved?.federations ?? []).map((f) => this.open(f).catch(() => undefined))).then(() => {
      if (this.stopped || mode !== this.mode) return;
      void this.refresh();
      if (this.saved?.federations.some((f) => !this.clients.has(f.id))) this.retry = setTimeout(() => void this.ensureReady(), 30_000);
    });
  }

  private open(federation: StoredFederation): Promise<FedimintClient> {
    const ready = this.clients.get(federation.id);
    if (ready) return Promise.resolve(ready);
    let opening = this.opening.get(federation.id);
    if (!opening) {
      opening = (async () => {
        try {
          const mnemonic = await unsealSeed(this.saved!.seed, this.saved!.deviceKey);
          const client = await this.gate.within((await this.sdk()).open({ database: federation.database, mnemonic }), (c) => c.close());
          if (client.federationId !== federation.id) { await client.close(); throw new Error("This federation's database belongs to another federation"); }
          this.attach(federation.id, client);
          return client;
        } catch (error) {
          if (!(error instanceof ModeChanged)) { this.problems.set(federation.id, error instanceof Error ? error.message : String(error)); this.render(); }
          throw error;
        } finally { this.opening.delete(federation.id); }
      })();
      this.opening.set(federation.id, opening);
    }
    return opening;
  }

  private attach(id: string, client: FedimintClient) {
    this.clients.set(id, client);
    this.problems.delete(id);
    this.unsubscribe.set(id, client.onBalance((msats) => { this.balances.set(id, msats); this.render(); }));
    void this.resumeReceives();
    this.render();
  }

  /** Closes this mode's clients and opens the other mode's record. Nothing is replaced: each mode keeps its own. */
  setMode(mode: WalletMode): Promise<void> {
    this.gate.switching(mode);
    return this.serial(async () => {
      this.mode = mode; this.gate.entered(mode);
      await this.closeAll();
      this.saved = await this.load(mode);
      this.history = [];
      this.render();
    });
  }
  async stop() { this.stopped = true; clearTimeout(this.retry); await this.serial(() => this.closeAll()); }
  private async closeAll() {
    clearTimeout(this.retry);
    for (const stop of this.unsubscribe.values()) stop();
    this.unsubscribe.clear();
    const clients = [...this.clients.values()];
    this.clients.clear(); this.balances.clear(); this.problems.clear(); this.watching.clear();
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  }

  private render() {
    const unavailable = this.unavailable();
    const federations: FedimintFederationView[] = (this.saved?.federations ?? []).map(({ database: _database, ...f }) => ({
      ...f,
      balance: sats(this.balances.get(f.id) ?? 0),
      status: this.clients.has(f.id) ? "ready" : this.problems.has(f.id) ? "error" : "connecting",
      error: this.problems.get(f.id),
      lightning: f.modules.includes("ln"),
    }));
    this.view = { unavailable, federations, balance: federations.reduce((sum, f) => sum + f.balance, 0), history: this.history, error: this.view.error };
    this.events.changed();
  }

  /** Balances and history, read again from every open client. */
  async refresh(): Promise<void> {
    const history: FedimintTx[] = [];
    for (const [id, client] of this.clients) {
      try {
        this.balances.set(id, await client.balance());
        for (const op of await client.operations(50)) { const entry = historyEntry(id, op); if (entry) history.push(entry); }
      } catch (error) { this.problems.set(id, error instanceof Error ? error.message : String(error)); }
    }
    history.sort((a, b) => b.createdAt - a.createdAt);
    this.history = history.slice(0, 100);
    this.render();
  }

  // ── Federations ──────────────────────────────────────────────────────────────────────────────────────────

  /** What an invite code leads to, before anything is joined: name, guardians, version, network, modules. */
  async preview(invite: string): Promise<FederationInfo> {
    const info = await (await this.sdk()).preview(normalizeInvite(invite));
    this.checkFederation(info);
    return info;
  }
  private checkFederation(info: FederationInfo) {
    const unavailable = this.unavailable();
    if (unavailable) throw new Error(unavailable);
    if (!isFederationId(info.federationId)) throw new Error("The federation answered with an invalid id");
    if (!info.modules.includes("mint")) throw new Error("This federation has no ecash module this app can use (the v1 mint module)");
    if (!info.network) throw new Error("Could not tell which Bitcoin network this federation is on");
    if (fedimintMode(info.network) !== this.mode) throw new Error(this.mode === "mainnet" ? `This federation is on ${info.network}, a test network: switch the wallets to Testnet to join it` : "This federation holds real bitcoin: switch the wallets to Mainnet to join it");
  }

  /**
   * Joins a federation. `recover`: the mnemonic was used with this federation before (a restore): the client rebuilds
   * its ecash from the federation's backup instead of starting empty.
   */
  join(invite: string, { recover = false }: { recover?: boolean } = {}): Promise<FedimintFederationView> { return this.serial(async () => {
    const code = normalizeInvite(invite);
    const sdk = await this.sdk();
    const info = await this.gate.within(sdk.preview(code));
    this.checkFederation(info);
    const saved = this.saved ?? await this.newSeed();
    if (saved.federations.some((f) => f.id === info.federationId)) throw new Error("You already joined this federation");
    if (saved.federations.length >= MAX_FEDERATIONS) throw new Error(`At most ${MAX_FEDERATIONS} federations per wallet`);
    const database = fedimintDatabase(crypto.randomUUID());
    const mnemonic = await unsealSeed(saved.seed, saved.deviceKey);
    // Joined once before on this profile (left, then joined again): the same keys, so it must recover.
    const again = recover || (await this.retiredIds()).includes(info.federationId);
    let client: FedimintClient | undefined;
    try {
      client = await this.gate.within(sdk.join({ database, mnemonic, invite: code, recover: again }), (c) => c.close());
      if (client.federationId !== info.federationId) throw new Error("The federation changed its id while joining");
      const { federationId: _id, ...rest } = await client.info().catch(() => info);
      const federation: StoredFederation = { ...info, ...rest, network: info.network, id: info.federationId, database, invite: code, joinedAt: Date.now() };
      delete (federation as Partial<FederationInfo>).federationId;
      const next = { ...saved, federations: [...saved.federations, federation] };
      await transact([STORES.settings], (stores) => { stores[STORES.settings].put(next, key(this.mode)); });
      this.saved = next;
      this.attach(federation.id, client);
      void this.refresh();
      return this.view.federations.find((f) => f.id === federation.id)!;
    } catch (error) {
      await client?.close().catch(() => {});
      // Never saved: its database goes, or every failed attempt leaves one behind.
      await sdk.remove(database).catch(() => {});
      throw error;
    }
  }); }

  private async newSeed(): Promise<StoredFedimint> {
    const deviceKey = newDeviceKey();
    const saved: StoredFedimint = { seed: await sealSeed(generateMnemonic(wordlist), deviceKey), deviceKey, federations: [] };
    await transact([STORES.settings], (stores) => { stores[STORES.settings].put(saved, key(this.mode)); });
    this.saved = saved;
    return saved;
  }
  private async retiredIds(): Promise<string[]> {
    const keys = await wrap<IDBValidKey[]>((await store(STORES.settings, "readonly")).getAllKeys());
    const retired = keys.filter((k): k is string => typeof k === "string" && k.startsWith(`fedimintRetired-${this.mode}-`));
    return retired.map((k) => k.slice(`fedimintRetired-${this.mode}-`.length));
  }

  /**
   * Leaves a federation that holds nothing and has nothing in flight. Its record is archived (its database stays),
   * so joining it again recovers instead of reusing the same keys fresh.
   */
  leave(federationId: string): Promise<void> { return this.serial(async () => {
    const saved = this.saved, federation = saved?.federations.find((f) => f.id === federationId);
    if (!saved || !federation) throw new Error("Unknown federation");
    const client = this.clients.get(federationId);
    if (!client) throw new Error("Wait for this federation to connect: its balance must be read before leaving it");
    if (sats(await client.balance()) > 0) throw new Error("This federation still holds your sats: spend or move them first");
    if ((await intentRepository.list()).some((i) => i.review.method === "fedimint" && i.review.provider === federationId && ["pending", "submitted", "unknown"].includes(i.review.state))) throw new Error("A payment through this federation is not finished yet");
    // Notes handed out stay "sent" until their refund timer, redeemed or not: taking them back is the only way to
    // know. Redeemed ones stay with whoever redeemed them; the others come back, and then there is money here.
    const out = (await client.operations(100)).filter((op) => historyEntry(federationId, op)?.kind === "notes-out" && historyEntry(federationId, op)?.state === "pending");
    for (const op of out) if (await this.takeBack(federationId, op.id, 15_000) === "pending") throw new Error("Notes you sent from this federation are still being settled: try again in a moment");
    if (sats(await client.balance()) > 0) throw new Error("Notes nobody redeemed came back to this federation: spend or move them first");
    this.unsubscribe.get(federationId)?.(); this.unsubscribe.delete(federationId);
    this.clients.delete(federationId); this.balances.delete(federationId);
    await client.close().catch(() => {});
    const next = { ...saved, federations: saved.federations.filter((f) => f.id !== federationId) };
    await transact([STORES.settings], (stores) => {
      stores[STORES.settings].put(federation, `fedimintRetired-${this.mode}-${federationId}`);
      stores[STORES.settings].put(next, key(this.mode));
    });
    this.saved = next;
    this.history = this.history.filter((tx) => tx.federation !== federationId);
    this.render();
  }); }

  /** The open client of a federation of this mode. */
  client(federationId: string): FedimintClient {
    const client = this.clients.get(federationId);
    if (client) return client;
    if (!this.saved?.federations.some((f) => f.id === federationId)) throw new Error("You have not joined this federation in this wallet mode");
    throw new Error(this.problems.get(federationId) ?? "Wait for the federation to connect");
  }
  federation(federationId: string): StoredFederation | undefined { return this.saved?.federations.find((f) => f.id === federationId); }
  /** Joined federations of this mode that are open now, in the order they were joined. */
  ready(): StoredFederation[] { return (this.saved?.federations ?? []).filter((f) => this.clients.has(f.id)); }
  /** The ones a chat request names: the payee takes ecash of any of them. */
  requestFederations(): string[] { return this.ready().map((f) => f.id); }

  // ── Money ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Notes out of the wallet, as text to hand over (the wallet page's Send). They come back by themselves if nobody redeems them. */
  async spendNotes(federationId: string, amount: number, ghostly = `wallet-${crypto.randomUUID()}`): Promise<{ notes: string; operationId: string }> {
    assertFedimintAmount(amount);
    const client = this.client(federationId);
    if (sats(await client.balance()) < amount) throw new Error("Not enough in this federation");
    const spent = await client.spend(amount * 1000, { cancelAfterSecs: NOTES_REFUND_SECS, ghostly });
    void this.refresh();
    return spent;
  }

  /** Which federation of this mode issued these notes, and how much they are worth (msats). Null: none we joined. */
  async inspectNotes(notes: string): Promise<{ federation: string; amountMsats: number } | null> {
    const text = notes.trim();
    if (!text || text.length > 32 * 1024) return null;
    for (const [id, client] of this.clients) {
      const parsed = await client.parseNotes(text).catch(() => null);
      if (!parsed) continue;
      if (parsed.federationId ? parsed.federationId === id : id.startsWith(parsed.federationIdPrefix.toLowerCase())) return { federation: id, amountMsats: parsed.amountMsats };
    }
    return null;
  }

  /** Redeems notes into the federation that issued them. `done` once the ecash is ours; `failed` when they were spent. */
  async redeemNotes(federationId: string, notes: string, ghostly: string, waitMs = 60_000): Promise<{ operationId: string; state: RedeemState | undefined }> {
    const client = this.client(federationId);
    const operationId = await client.redeem(notes.trim(), ghostly);
    const state = await client.redeemState(operationId, waitMs);
    void this.refresh();
    return { operationId, state };
  }
  async redeemState(federationId: string, operationId: string, waitMs: number) { return this.client(federationId).redeemState(operationId, waitMs); }

  /** Pasted on the wallet page: notes of any federation of this mode. */
  async receiveNotes(notes: string): Promise<{ federation: string; amount: number }> {
    const found = await this.inspectNotes(notes);
    if (!found) throw new Error(this.clients.size ? "These notes are not from a federation you joined in this wallet mode" : "Join the federation these notes are from first");
    const { state } = await this.redeemNotes(found.federation, notes, `wallet-${crypto.randomUUID()}`);
    if (state === "failed") throw new Error("These notes were already redeemed by someone");
    if (state !== "done") throw new Error("The federation is still redeeming these notes: they will show in the balance");
    return { federation: found.federation, amount: sats(found.amountMsats) };
  }

  /** Takes notes back. `canceled`: they are ours again; `taken`: the recipient redeemed them first; `pending`: not settled yet. */
  async takeBack(federationId: string, operationId: string, waitMs = 30_000): Promise<"canceled" | "taken" | "pending"> {
    const client = this.client(federationId);
    const before = await client.spendState(operationId, 1_500);
    if (before === undefined) throw new Error("This wallet has no record of those notes");
    if (!isFinal(before)) await client.cancelSpend(operationId);
    const state = isFinal(before) ? before : await client.spendState(operationId, waitMs);
    void this.refresh();
    return state === "canceled" || state === "refunded" ? "canceled" : state === "taken" ? "taken" : "pending";
  }
  spendState(federationId: string, operationId: string, waitMs: number) { return this.client(federationId).spendState(operationId, waitMs); }
  /** The spend Ghostly made for a payment, found by the id it put in the operation's meta (after an interruption). */
  async spendFor(federationId: string, paymentId: string): Promise<FedimintOperation | undefined> {
    return (await this.client(federationId).operations(100)).find((op) => op.kind === "mint" && op.variant === "spend_o_o_b" && op.ghostly === paymentId);
  }

  /**
   * An invoice paid into the federation (through its gateway). With `paymentId`, a chat request's: it is watched,
   * across restarts, until paid or expired, and `received` says so.
   */
  async createInvoice(federationId: string, amount: number, memo = "", paymentId?: string, expirySecs = 24 * 60 * 60): Promise<{ invoice: string; operationId: string }> {
    assertFedimintAmount(amount);
    const federation = this.federation(federationId);
    if (!federation?.modules.includes("ln")) throw new Error("This federation has no Lightning gateway module");
    const made = await this.client(federationId).createInvoice(amount * 1000, memo.slice(0, 140), expirySecs, paymentId ?? `wallet-${crypto.randomUUID()}`);
    if (paymentId) {
      const receive: Receive = { federation: federationId, operationId: made.operationId, paymentId, expiresAt: Date.now() + expirySecs * 1000 };
      await transact([STORES.settings], (stores) => { stores[STORES.settings].put(receive, `fedimintReceive-${made.operationId}`); });
      void this.watchReceive(receive);
    }
    return made;
  }
  /** The first federation of this mode with a gateway module: where a chat request's invoice is made. */
  invoiceFederation(): string | undefined { return this.ready().find((f) => f.modules.includes("ln"))?.id; }

  private async resumeReceives() {
    const all = await wrap<unknown[]>((await store(STORES.settings, "readonly")).getAll());
    for (const value of all) {
      const r = value as Partial<Receive>;
      if (r && typeof r.operationId === "string" && typeof r.paymentId === "string" && typeof r.federation === "string" && this.clients.has(r.federation)) void this.watchReceive(r as Receive);
    }
  }
  private async watchReceive(receive: Receive) {
    if (this.watching.has(receive.operationId)) return;
    this.watching.add(receive.operationId);
    try {
      for (;;) {
        const client = this.clients.get(receive.federation);
        if (!client || this.stopped) return;
        const asked = Date.now();
        const state = await client.receiveState(receive.operationId, 60_000).catch(() => undefined);
        if (state === "claimed") { this.events.received(receive.paymentId, receive.federation); break; }
        if (state === "canceled" || Date.now() > receive.expiresAt + 60 * 60_000) break;
        // The client waits for a change by itself; one that answers at once (not open, not reachable) is asked again later.
        if (Date.now() - asked < 5_000) await new Promise((resolve) => setTimeout(resolve, fedimintTiming.pollMs));
      }
      await transact([STORES.settings], (stores) => { stores[STORES.settings].delete(`fedimintReceive-${receive.operationId}`); });
      void this.refresh();
    } finally { this.watching.delete(receive.operationId); }
  }
  /** Asks about every chat invoice now ("I paid it from another wallet"). */
  async checkReceives(): Promise<void> {
    const all = await wrap<unknown[]>((await store(STORES.settings, "readonly")).getAll());
    for (const value of all) {
      const r = value as Partial<Receive>;
      if (!r || typeof r.operationId !== "string" || typeof r.paymentId !== "string" || typeof r.federation !== "string") continue;
      const state = await this.clients.get(r.federation)?.receiveState(r.operationId, 1_500).catch(() => undefined);
      if (state === "claimed") this.events.received(r.paymentId, r.federation);
    }
  }

  /** A target naming one of our federations, for a review (the chat's Send answers a request with one). */
  target(federationId: string, address: string): PaymentTarget {
    const federation = this.federation(federationId);
    if (!federation?.network) throw new Error("You have not joined this federation in this wallet mode");
    return { method: "fedimint", network: federation.network, provider: federationId, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
  }

  // ── Backup ────────────────────────────────────────────────────────────────────────────────────────────────

  async backup(): Promise<{ mnemonic: string; federations: { id: string; name?: string; invite: string }[] }> {
    if (!this.saved) throw new Error("No Fedimint wallet to back up: join a federation first");
    return { mnemonic: await unsealSeed(this.saved.seed, this.saved.deviceKey), federations: this.saved.federations.map((f) => ({ id: f.id, name: f.name, invite: f.invite })) };
  }
  /**
   * The mnemonic and the federations' invite codes, sealed with a password the person chooses. The ecash itself is
   * not in the file: restoring re-joins each federation with the mnemonic, and the federation's recovery gives it back.
   */
  async exportBackup(password: string): Promise<string> {
    if (password.length < 12) throw new Error("Use at least 12 characters for the backup password");
    const { mnemonic, federations } = await this.backup();
    const intents = (await intentRepository.list()).filter((i) => i.review.method === "fedimint");
    return JSON.stringify({ format: "ghostly-fedimint-encrypted", version: 1, mode: this.mode, vault: await sealSeed(JSON.stringify({ format: "ghostly-fedimint", version: 1, mnemonic, federations, intents }), password) });
  }
  /** Into a mode without a Fedimint wallet yet: the mnemonic is kept, and every federation is joined again through recovery. */
  restoreBackup(text: string, password: string): Promise<{ joined: number; failed: string[] }> {
    return this.restore(async () => {
      if (text.length > 1024 * 1024) throw new Error("Fedimint backup is too large");
      const envelope = JSON.parse(text);
      if (envelope.format !== "ghostly-fedimint-encrypted" || envelope.version !== 1) throw new Error("Unsupported Fedimint backup");
      if (envelope.mode !== this.mode) throw new Error(`This backup is a ${envelope.mode === "mainnet" ? "Mainnet" : "Testnet"} wallet: switch the wallets to it first`);
      const payload = JSON.parse(await unsealSeed(envelope.vault, password)) as { format: string; version: number; mnemonic: string; federations: { invite: string }[] };
      if (payload.format !== "ghostly-fedimint" || payload.version !== 1 || !Array.isArray(payload.federations)) throw new Error("Invalid Fedimint backup");
      return { mnemonic: payload.mnemonic, invites: payload.federations.map((f) => f.invite) };
    });
  }
  /** The mnemonic and the invite codes typed in: the same recovery. */
  restorePhrase(mnemonic: string, invites: string[]): Promise<{ joined: number; failed: string[] }> { return this.restore(async () => ({ mnemonic, invites })); }
  private async restore(read: () => Promise<{ mnemonic: string; invites: string[] }>): Promise<{ joined: number; failed: string[] }> {
    const { mnemonic, invites } = await read();
    const phrase = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
    if (!validateMnemonic(phrase, wordlist)) throw new Error("Invalid recovery phrase");
    if (!invites.length || invites.length > MAX_FEDERATIONS) throw new Error("Add the invite code of each federation to restore");
    await this.serial(async () => {
      const unavailable = this.unavailable();
      if (unavailable) throw new Error(unavailable);
      if (this.saved?.federations.length) throw new Error("Restore into a wallet mode that has joined no federation yet; this one will not be replaced");
      if (this.saved) await transact([STORES.settings], (stores) => { stores[STORES.settings].put(this.saved!, `fedimintWallet-retired-${this.mode}-${Date.now()}`); });
      const deviceKey = newDeviceKey();
      const saved: StoredFedimint = { seed: await sealSeed(phrase, deviceKey), deviceKey, federations: [] };
      await transact([STORES.settings], (stores) => { stores[STORES.settings].put(saved, key(this.mode)); });
      this.saved = saved;
    });
    const failed: string[] = [];
    let joined = 0;
    for (const invite of invites) {
      try { await this.join(invite, { recover: true }); joined++; } catch (error) { failed.push(`${invite.slice(0, 16)}…: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { joined, failed };
  }
}

const isFinal = (state: SpendState | undefined) => state === "canceled" || state === "taken" || state === "refunded";
