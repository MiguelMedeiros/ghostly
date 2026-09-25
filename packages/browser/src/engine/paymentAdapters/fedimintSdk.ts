import type { BitcoinNetwork } from "@ghostly/core";

/**
 * The part of the Fedimint web SDK (`@fedimint/core`, WebAssembly client in a worker) Ghostly uses, behind an
 * interface small enough to fake in tests: the client needs a worker and the origin-private file system, which
 * Node has neither of.
 *
 * One client database per joined federation (`ghostly-fedimint-<id>.db`, a file of the origin-private file
 * system): the SDK's services are bound to one client per database, and each database is held by one worker.
 * Every database of a profile and mode is given the same mnemonic; the client derives a different secret per
 * federation from it. Amounts are millisatoshis, as the SDK counts them.
 */
export interface FederationGuardian { name: string; url: string }
export interface FederationInfo {
  federationId: string;
  /** `meta.federation_name`, when the guardians set one. */
  name?: string;
  guardians: FederationGuardian[];
  /** Core consensus version, `major.minor`. */
  consensusVersion: string;
  /** The Bitcoin network of its wallet module. Unknown when the federation has no v1 wallet module. */
  network?: BitcoinNetwork;
  /** Module kinds (`mint`, `ln`, `wallet`, `meta`…). The SDK uses `mint`, `ln` and `wallet` (v1). */
  modules: string[];
  /** `meta.welcome_message`, shortened. */
  welcome?: string;
}

/** Out-of-band notes, parsed offline (signatures and prefix only: whether they are spent is the federation's to say). */
export interface ParsedNotes { amountMsats: number; federationIdPrefix: string; federationId?: string }

/** Where a spend of notes stands. `canceled` = taken back (reissued to us); `taken` = the recipient redeemed them. */
export type SpendState = "created" | "canceling" | "canceled" | "taken" | "refunded";
/** A redeem (reissue) of notes we were given. */
export type RedeemState = "created" | "issuing" | "done" | "failed";
export type ReceiveState = "open" | "funded" | "claimed" | "canceled";
export interface PayOutcome { state: "pending" | "paid" | "failed"; preimage?: string; error?: string }

export interface FedimintOperation {
  id: string;
  /** Module: `mint`, `ln`, `wallet`. */
  kind: string;
  /** What it was: `spend_oob`, `reissuance`, `receive`, `pay`… as the SDK names it. */
  variant?: string;
  createdAt: number;
  amountMsats?: number;
  /** The SDK's final outcome, once there is one. */
  outcome?: unknown;
  /** What Ghostly asked to be kept with it (`extra_meta`): the payment id it belongs to. */
  ghostly?: string;
  /** Lightning: the invoice it paid or was paid on, and the fee it paid (msats). */
  invoice?: string;
  feeMsats?: number;
}

export interface FedimintClient {
  readonly federationId: string;
  info(): Promise<FederationInfo>;
  balance(): Promise<number>;
  /** Called with every new balance, until the returned function is called. */
  onBalance(listener: (msats: number) => void): () => void;
  parseNotes(notes: string): Promise<ParsedNotes>;
  /** Takes notes out of the wallet, as a bearer string. Unredeemed after `cancelAfterSecs`, they come back by themselves. */
  spend(amountMsats: number, options: { cancelAfterSecs: number; ghostly: string }): Promise<{ notes: string; operationId: string }>;
  /** Asks to take notes back: they are reissued to us unless the recipient redeemed them first. */
  cancelSpend(operationId: string): Promise<void>;
  /** The latest state within `waitMs` (it returns early on a final one). Undefined: the client knows no such operation. */
  spendState(operationId: string, waitMs: number): Promise<SpendState | undefined>;
  redeem(notes: string, ghostly: string): Promise<string>;
  redeemState(operationId: string, waitMs: number): Promise<RedeemState | undefined>;
  createInvoice(amountMsats: number, description: string, expirySecs: number, ghostly: string): Promise<{ operationId: string; invoice: string }>;
  receiveState(operationId: string, waitMs: number): Promise<ReceiveState | undefined>;
  /** What the federation's gateway would charge to pay this amount, in msats. Undefined: no gateway. */
  gatewayFee(amountMsats: number): Promise<number | undefined>;
  payInvoice(invoice: string, ghostly: string): Promise<{ operationId: string; feeMsats: number; internal: boolean }>;
  payState(operationId: string, internal: boolean, waitMs: number): Promise<PayOutcome>;
  operations(limit: number): Promise<FedimintOperation[]>;
  /** Ends the worker; the database stays. */
  close(): Promise<void>;
}

export interface FedimintSdk {
  preview(invite: string): Promise<FederationInfo>;
  /** Joins (or, `recover`, restores from the federation's backup of this mnemonic) into a new database. */
  join(params: { database: string; mnemonic: string; invite: string; recover: boolean }): Promise<FedimintClient>;
  /** Opens a database joined before. */
  open(params: { database: string; mnemonic: string }): Promise<FedimintClient>;
  /** Deletes a database: only one that never held money (a failed join). */
  remove(database: string): Promise<void>;
  /** Whether this device has the database (a profile restored from a backup has the records, not the files). */
  exists(database: string): Promise<boolean>;
}

export const fedimintDatabase = (id: string) => `ghostly-fedimint-${id}.db`;

// ── The real SDK ───────────────────────────────────────────────────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const MODULE_WASM = () => import("@fedimint/fedimint-client-wasm-bundler/fedimint_client_wasm_bg.wasm?url");
/** The SDK checks it with an assert: any other length kills the worker. One client per database, always this name. */
const CLIENT_NAME = "dd5135b2-c228-41b7-a4f9-3b6e7afe3088";
const NETWORKS: Record<string, BitcoinNetwork> = { bitcoin: "bitcoin", signet: "signet", testnet: "testnet", testnet4: "testnet", regtest: "regtest", mutinynet: "mutinynet" };
/**
 * A v1 wallet (or Lightning) module's client config comes consensus-encoded as hex (`config` from a joined client,
 * `unknown_module_hex` in a preview); its network is the chain's magic, a u32 as a compact-size integer (`fe` +
 * four bytes, little-endian). Exactly one network must be found, or it stays unknown.
 */
const MAGIC: [string, BitcoinNetwork][] = [["fed9b4bef9", "bitcoin"], ["fe0709110b", "testnet"], ["fe283f161c", "testnet"], ["fe40cf030a", "signet"], ["fecb2ddfa5", "mutinynet"], ["fedab5bffa", "regtest"]];
function moduleNetwork(module: { network?: unknown; config?: unknown; unknown_module_hex?: unknown }): BitcoinNetwork | undefined {
  if (typeof module.network === "string") return NETWORKS[module.network];
  const encoded = typeof module.config === "string" ? module.config : module.unknown_module_hex;
  if (typeof encoded !== "string" || !/^[0-9a-f]*$/i.test(encoded)) return undefined;
  const hex = encoded.toLowerCase();
  const found = [...new Set(MAGIC.filter(([magic]) => hex.includes(magic)).map(([, network]) => network))];
  return found.length === 1 ? found[0] : undefined;
}
const hex = (value: unknown) => typeof value === "string" ? value : Array.isArray(value) ? value.map((b) => Number(b).toString(16).padStart(2, "0")).join("") : undefined;

let compiling: Promise<WebAssembly.Module> | undefined;
/** Compiled once per page (11 MB): each worker is handed the module, not the bytes. */
function compiled(): Promise<WebAssembly.Module> {
  return compiling ??= (async () => {
    const url = (await MODULE_WASM()).default;
    const response = await fetch(url);
    // A server that sends the wrong MIME type cannot stream: compile from the bytes instead.
    try { return await WebAssembly.compileStreaming(response.clone()); } catch { return WebAssembly.compile(await response.arrayBuffer()); }
  })().catch((error) => { compiling = undefined; throw error; });
}

/** A transport of `@fedimint/core` onto our own worker (fedimintWorker.ts). */
async function transport() {
  const [{ Transport }, module] = await Promise.all([import("@fedimint/types"), compiled()]);
  class WorkerTransport extends Transport {
    readonly logger = { debug() {}, info() {}, warn() {}, error() {} };
    private readonly worker = new Worker(new URL("./fedimintWorker.ts", import.meta.url), { type: "module" });
    constructor() {
      super();
      this.worker.onmessage = (event) => this.messageHandler(event.data);
      this.worker.onerror = (event) => { event.preventDefault(); this.messageHandler({ type: "error", error: `The Fedimint client stopped: ${event.message || "unknown error"}` }); };
    }
    postMessage(message: { type: string; payload?: Json; requestId?: number }) {
      // The worker gets the compiled module with its init, and nothing to log.
      this.worker.postMessage(message.type === "init" ? { ...message, payload: { ...(message.payload as object), module } } : message);
    }
    terminate() { this.worker.terminate(); }
  }
  return new WorkerTransport();
}

const text = (value: unknown, max = 200) => typeof value === "string" ? value.slice(0, max) : undefined;
const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);

export function federationInfo(federationId: string, config: unknown): FederationInfo {
  const c = config as { global?: { api_endpoints?: Record<string, { url?: unknown; name?: unknown }>; consensus_version?: { major?: unknown; minor?: unknown }; meta?: Record<string, unknown> }; modules?: Record<string, { kind?: unknown; network?: unknown; config?: unknown; unknown_module_hex?: unknown }> };
  const endpoints = Object.entries(c?.global?.api_endpoints ?? {}).sort(([a], [b]) => Number(a) - Number(b));
  const modules = Object.values(c?.modules ?? {});
  // The wallet module says it; a federation without one (Lightning and ecash only) says it through its Lightning module.
  const network = modules.filter((m) => m?.kind === "wallet").map(moduleNetwork).find(Boolean) ?? modules.filter((m) => m?.kind === "ln").map(moduleNetwork).find(Boolean);
  const version = c?.global?.consensus_version;
  return {
    federationId,
    name: text(c?.global?.meta?.federation_name, 80),
    guardians: endpoints.slice(0, 64).map(([peer, e]) => ({ name: text(e?.name, 80) || `Guardian ${peer}`, url: text(e?.url, 300) ?? "" })),
    consensusVersion: `${Number(version?.major ?? 0)}.${Number(version?.minor ?? 0)}`,
    network,
    modules: [...new Set(modules.map((m) => (typeof m?.kind === "string" ? m.kind.slice(0, 32) : "")).filter(Boolean))],
    welcome: text(c?.global?.meta?.welcome_message, 280),
  };
}

/** The first value a subscription gives that is final, or the last one within `waitMs`. */
function watch<S>(subscribe: (onState: (state: S) => void, onError: (error: string) => void) => () => void, final: (state: S) => boolean, waitMs: number): Promise<S | undefined> {
  return new Promise((resolve) => {
    let last: S | undefined, done = false, cancel: () => void = () => {};
    const finish = () => { if (done) return; done = true; clearTimeout(timer); cancel(); resolve(last); };
    const timer = setTimeout(finish, waitMs);
    cancel = subscribe((state) => { last = state; if (final(state)) finish(); }, () => finish());
  });
}

const SPEND: Record<string, SpendState> = { Created: "created", UserCanceledProcessing: "canceling", UserCanceledSuccess: "canceled", UserCanceledFailure: "taken", Success: "taken", Refunded: "refunded" };
const spendFinal = (s: SpendState) => s === "canceled" || s === "taken" || s === "refunded";
const REDEEM: Record<string, RedeemState> = { Created: "created", Issuing: "issuing", Done: "done" };
const receiveOf = (s: unknown): ReceiveState => s === "claimed" ? "claimed" : s === "funded" || s === "awaiting_funds" ? "funded" : typeof s === "object" && s && "canceled" in s ? "canceled" : "open";

/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK's own types are loose unions of JSON; this is where they are narrowed. */
class RealClient implements FedimintClient {
  constructor(readonly federationId: string, private wallet: any, private director: any, private end: () => void) {}
  async info() { return federationInfo(this.federationId, await this.wallet.federation.getConfig()); }
  balance(): Promise<number> { return this.wallet.balance.getBalance(); }
  onBalance(listener: (msats: number) => void) { return this.wallet.balance.subscribeBalance(listener, () => {}); }
  async parseNotes(notes: string): Promise<ParsedNotes> {
    const parsed = await this.director.parseOobNotes(notes);
    return { amountMsats: Number(parsed.total_amount), federationIdPrefix: String(parsed.federation_id_prefix), federationId: parsed.federation_id ?? undefined };
  }
  async spend(amountMsats: number, { cancelAfterSecs, ghostly }: { cancelAfterSecs: number; ghostly: string }) {
    const { notes, operation_id } = await this.wallet.mint.spendNotes(amountMsats, cancelAfterSecs, false, { ghostly });
    return { notes: String(notes), operationId: String(operation_id) };
  }
  cancelSpend(operationId: string): Promise<void> { return this.wallet.mint.tryCancelSpendNotes(operationId); }
  spendState(operationId: string, waitMs: number) {
    return watch<SpendState>((ok, fail) => this.wallet.mint.subscribeSpendNotes(operationId, (s: string) => ok(SPEND[s] ?? "created"), fail), spendFinal, waitMs);
  }
  redeem(notes: string, ghostly: string): Promise<string> { return this.wallet.mint.reissueExternalNotes(notes, { ghostly }); }
  redeemState(operationId: string, waitMs: number) {
    return watch<RedeemState>((ok, fail) => this.wallet.mint.subscribeReissueExternalNotes(operationId, (s: unknown) => ok(typeof s === "string" ? REDEEM[s] ?? "created" : s && typeof s === "object" && "Failed" in s ? "failed" : "created"), (error: string) => { ok("failed"); fail(error); }), (s) => s === "done" || s === "failed", waitMs);
  }
  async createInvoice(amountMsats: number, description: string, expirySecs: number, ghostly: string) {
    const { operation_id, invoice } = await this.wallet.lightning.createInvoice(amountMsats, description, expirySecs, undefined, { ghostly });
    return { operationId: String(operation_id), invoice: String(invoice) };
  }
  receiveState(operationId: string, waitMs: number) {
    return watch<ReceiveState>((ok, fail) => this.wallet.lightning.subscribeLnReceive(operationId, (s: unknown) => ok(receiveOf(s)), fail), (s) => s === "claimed" || s === "canceled", waitMs);
  }
  async gatewayFee(amountMsats: number) {
    await this.wallet.lightning.updateGatewayCache().catch(() => {});
    const gateway = await this.wallet.lightning.getAvailableGateway().catch(() => null);
    const fees = gateway?.fees;
    if (!fees) return undefined;
    return Number(fees.base_msat ?? 0) + Math.ceil(amountMsats * Number(fees.proportional_millionths ?? 0) / 1_000_000);
  }
  async payInvoice(invoice: string, ghostly: string) {
    const paid = await this.wallet.lightning.payInvoice(invoice, undefined, { ghostly });
    const internal = "internal" in paid.payment_type;
    return { operationId: String(internal ? paid.payment_type.internal : paid.payment_type.lightning), feeMsats: Number(paid.fee ?? 0), internal };
  }
  async payState(operationId: string, internal: boolean, waitMs: number): Promise<PayOutcome> {
    const state = await watch<unknown>((ok, fail) => internal ? this.wallet.lightning.subscribeInternalPayment(operationId, ok, fail) : this.wallet.lightning.subscribeLnPay(operationId, ok, fail),
      (s) => typeof s === "object" && !!s && ("success" in s || "preimage" in s || "refunded" in s || "refund_success" in s || "unexpected_error" in s || "funding_failed" in s) || s === "canceled", waitMs);
    if (state && typeof state === "object") {
      const s = state as Record<string, any>;
      // A payment out through the gateway ends in `success`; one to the same federation (internal) in `preimage` (bytes).
      if (s.success?.preimage || s.preimage) return { state: "paid", preimage: hex(s.success?.preimage ?? s.preimage) };
      if ("refunded" in s || "refund_success" in s || "funding_failed" in s) return { state: "failed", error: errorText(s.refunded?.gateway_error ?? s.funding_failed?.error ?? "The gateway gave the payment back") };
      if ("unexpected_error" in s) return { state: "pending", error: errorText(s.unexpected_error) };
    }
    if (state === "canceled") return { state: "failed", error: "Canceled before it was funded" };
    return { state: "pending" };
  }
  async operations(limit: number): Promise<FedimintOperation[]> {
    const list: [{ creation_time?: { secs_since_epoch?: number }; operation_id?: string }, { operation_module_kind?: string; meta?: any; outcome?: any }][] = await this.wallet.federation.listOperations(limit);
    return list.map(([key, log]) => {
      const variant = log.meta?.variant && typeof log.meta.variant === "object" ? Object.keys(log.meta.variant)[0] : undefined;
      const detail = variant ? log.meta.variant[variant] : undefined;
      return {
        id: String(key.operation_id ?? ""), kind: String(log.operation_module_kind ?? ""), variant,
        createdAt: Number(key.creation_time?.secs_since_epoch ?? 0) * 1000,
        amountMsats: typeof log.meta?.amount === "number" ? log.meta.amount : typeof detail?.requested_amount === "number" ? detail.requested_amount : undefined,
        outcome: log.outcome?.outcome, ghostly: typeof log.meta?.extra_meta?.ghostly === "string" ? log.meta.extra_meta.ghostly : undefined,
        invoice: typeof detail?.invoice === "string" ? detail.invoice : undefined,
        feeMsats: typeof detail?.fee === "number" ? detail.fee : undefined,
      };
    });
  }
  async close() { try { await this.wallet.cleanup(); } catch { /* already gone */ } this.end(); }
}

let loading: Promise<FedimintSdk> | undefined;
/** Loads the SDK on first use: profiles that never join a federation never fetch its 11 MB. */
export function loadFedimintSdk(): Promise<FedimintSdk> {
  return loading ??= (async () => {
    const { WalletDirector } = await import("@fedimint/core");
    /** A director on its own worker and database, with the mnemonic in place. */
    const director = async (database: string, mnemonic?: string) => {
      const t = await transport();
      const d = new WalletDirector(t as any, database, true);
      try {
        await d.initialize(database);
        if (mnemonic && !(await d.hasMnemonicSet())) await d.setMnemonic(mnemonic.trim().split(/\s+/));
        return { director: d, end: () => t.terminate() };
      } catch (error) { t.terminate(); throw error; }
    };
    const client = async (database: string, mnemonic: string, start: (wallet: any) => Promise<void>) => {
      const { director: d, end } = await director(database, mnemonic);
      try {
        const wallet = await d.createWallet();
        await start(wallet);
        return new RealClient(await wallet.federation.getFederationId(), wallet, d, end);
      } catch (error) { end(); throw error; }
    };
    const sdk: FedimintSdk = {
      async preview(invite) {
        // A scratch database of its own: previewing joins nothing.
        const database = fedimintDatabase(`preview-${crypto.randomUUID()}`);
        const { director: d, end } = await director(database);
        try { const preview = await d.previewFederation(invite.trim()); return federationInfo(preview.federation_id, preview.config); }
        finally { end(); await sdk.remove(database).catch(() => {}); }
      },
      join: ({ database, mnemonic, invite, recover }) => client(database, mnemonic, async (wallet) => {
        // joinFederation says false instead of throwing; its reason goes to the (silenced) logger.
        if (!(await wallet.joinFederation(invite.trim(), { clientName: CLIENT_NAME, forceRecover: recover }))) throw new Error("Could not join the federation: its guardians did not answer, or the invite code is not valid");
      }),
      open: ({ database, mnemonic }) => client(database, mnemonic, (wallet) => wallet.open(CLIENT_NAME)),
      async exists(database) {
        const root = await navigator.storage.getDirectory();
        try { const file = await (await root.getFileHandle(database)).getFile(); return file.size > 0; } catch { return false; }
      },
      async remove(database) {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(database).catch((error: unknown) => { if ((error as { name?: string })?.name !== "NotFoundError") throw error; });
      },
    };
    return sdk;
  })().catch((error) => { loading = undefined; throw error; });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
