import { STORES, store, transact, wrap } from "../../../shared/idb";
import type { WalletMode } from "../../../shared/mints";
import { ModeChanged, ModeGate } from "../modeGate";
import { newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "../persistence";
import { describeProvider, networkMode, offeredIn, redact, sourceProblem, type ProviderDescriptor, type ProviderDescriptorView, type ProviderHost, type ProviderKind, type ProviderNetwork, type ProviderSettings, type SourceProblem } from "./types";

/**
 * What is stored for a source, under `<kind>Source-<mode>` in the settings store: never in the Settings
 * object (which the UI sees), and its secrets sealed with a device key, like the Ark and USDT seeds.
 */
interface StoredSource {
  providerId: string;
  config: Record<string, string>;
  secrets?: EncryptedSeed;
  deviceKey?: string;
  savedAt: number;
}

/** The last balance a source read, under `<kind>SourceSeen-<mode>`: shown while it reconnects after a restart. */
interface SeenBalance { providerId: string; balance?: number; unconfirmed?: number; at: number }

export interface SourceView {
  mode: WalletMode;
  /** Absent: no source (on-chain has none until one is chosen). */
  providerId?: string;
  label?: string;
  /** The built-in default of this kind (the Cashu mints for Lightning). */
  isDefault?: boolean;
  custodial?: boolean;
  /** The non-secret settings, as saved. */
  config?: Record<string, string>;
  /** The names of the secret fields that are saved. Their values never leave the engine. */
  secrets?: string[];
  status: "none" | "connecting" | "ready" | "error";
  network?: ProviderNetwork;
  alias?: string;
  /** Spendable sats, when the source says. */
  balance?: number;
  /** On-chain: sats in the mempool. */
  unconfirmed?: number;
  /**
   * The balance shown is the last one read (at this time), not a fresh one: the source is not connected.
   * Absent once it reads again.
   */
  balanceAt?: number;
  /**
   * While `connecting` after a failed attempt, why it failed (it is being tried again by itself); while
   * `error`, why the source is unavailable.
   */
  error?: string;
  /** What kind of failure `error` is: no answer (tried again by itself), a setting to change, or other. */
  problem?: SourceProblem;
  /** Attempts that failed in a row, and when the next one starts (it also starts on Retry, or on waking). */
  failures?: number;
  retryAt?: number;
  /** The providers that can be picked here (this platform, this mode), in registry order. */
  offered: ProviderDescriptorView[];
}

interface Connectable { info(): Promise<{ network: ProviderNetwork; alias?: string }>; close(): Promise<void> }

export interface SourcesOptions<P> {
  kind: ProviderKind;
  descriptors: () => readonly ProviderDescriptor<P>[];
  /** Read each time a source connects. */
  host: () => Omit<ProviderHost, "mode" | "signal">;
  changed: () => void;
  /** Used while nothing is stored for the mode. */
  defaultId?: string;
  /** Asked before the source of a mode changes: a refusal (money in flight through it) stops the change. */
  refuseReplacing?: (providerId: string, mode: WalletMode) => Promise<string | undefined>;
  /** Balance and the like, read after connecting and then every `refreshMs`. */
  refresh?: (provider: P) => Promise<Partial<Pick<SourceView, "balance" | "unconfirmed">>>;
  refreshMs?: number;
  /** How long to wait before the next attempt after `failures` failed ones (tests shorten it). */
  backoff?: (failures: number) => number;
}

const storageKey = (kind: ProviderKind, mode: WalletMode) => `${kind}Source-${mode}`;
const seenKey = (kind: ProviderKind, mode: WalletMode) => `${kind}SourceSeen-${mode}`;

/**
 * A source that does not answer is tried again by itself: 2 s, 4 s, 8 s… up to 5 minutes, ±20 % so
 * that many apps coming back online do not knock at once.
 */
export const RETRY_MAX_MS = 5 * 60_000;
export function retryDelay(failures: number, random = Math.random): number {
  const base = Math.min(RETRY_MAX_MS, 2_000 * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.8 + 0.4 * random()));
}
/**
 * "Unavailable" only once it has failed this many times in a row for at least this long: a slow server at
 * start-up is "Connecting…". A wrong setting is unavailable at once (waiting does not fix it).
 */
export const SUSTAINED_FAILURES = 3;
export const SUSTAINED_MS = 30_000;

/**
 * Gives up on a connection when its signal aborts (a change of settings interrupts an attempt), even if the
 * provider does not listen to it; what still arrives afterwards is closed.
 */
function abortable<P extends Connectable>(work: Promise<P>, signal: AbortSignal): Promise<P> {
  return new Promise<P>((resolve, reject) => {
    const give = () => { reject(new Error("The connection attempt was interrupted")); void work.then((p) => p.close().catch(() => {}), () => {}); };
    if (signal.aborted) return give();
    signal.addEventListener("abort", give, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", give); if (!signal.aborted) resolve(value); },
      (error) => { signal.removeEventListener("abort", give); if (!signal.aborted) reject(error); },
    );
  });
}

/**
 * The active source of one kind (Lightning, on-chain), one per wallet mode: Mainnet and Testnet keep
 * their own, and switching modes closes one and opens the other, nothing is replaced. Every change is
 * serialized, and a connection still waiting when the mode switches is abandoned (and closed when it
 * arrives), like the Ark and USDT wallets do.
 */
export class ProviderSources<P extends Connectable> {
  private mode: WalletMode = "mainnet";
  private stored?: StoredSource;
  private descriptor?: ProviderDescriptor<P>;
  private provider?: P;
  /** The connected source's secrets, only to blank them out of error messages. */
  private secrets: Record<string, string> = {};
  private controller = new AbortController();
  private readonly gate = new ModeGate();
  private queue: Promise<unknown> = Promise.resolve();
  private connecting?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  /** Failed attempts in a row, and since when: what makes a failure sustained. */
  private failures = 0;
  private failingSince?: number;
  private seen?: SeenBalance;
  private stopped = false;
  view: SourceView = { mode: "mainnet", status: "none", offered: [] };

  constructor(private readonly options: SourcesOptions<P>) {}

  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next; }
  private find(id: string) { return this.options.descriptors().find((d) => d.id === id); }
  private offered() { return this.options.descriptors().filter((d) => offeredIn(d, this.options.host().platform, this.mode)).map((d) => describeProvider(d as ProviderDescriptor<unknown>)); }
  private async load(mode: WalletMode) {
    const settings = await store(STORES.settings, "readonly");
    const [stored, seen] = await Promise.all([wrap<StoredSource | undefined>(settings.get(storageKey(this.options.kind, mode))), wrap<SeenBalance | undefined>(settings.get(seenKey(this.options.kind, mode)))]);
    this.stored = stored; this.seen = seen;
    this.failures = 0; this.failingSince = undefined;
  }

  /** The source of the mode (stored, else the default), not connected yet: with the last balance it read. */
  private idle(): SourceView {
    const id = this.stored?.providerId ?? this.options.defaultId;
    const descriptor = id ? this.find(id) : undefined;
    const seen = id && this.seen?.providerId === id ? this.seen : undefined;
    return {
      mode: this.mode, offered: this.offered(), providerId: id, label: descriptor?.label ?? id, custodial: descriptor?.custodial,
      isDefault: !!id && id === this.options.defaultId, config: this.stored?.config,
      secrets: descriptor?.fields.filter((f) => f.kind === "secret" && this.stored?.secrets).map((f) => f.name),
      status: !id ? "none" : descriptor ? "connecting" : "error",
      error: id && !descriptor ? `${id} is not available in this version of Ghostly` : undefined,
      ...(seen ? { balance: seen.balance, unconfirmed: seen.unconfirmed, balanceAt: seen.at } : {}),
    };
  }

  async start(mode: WalletMode) { this.mode = mode; this.gate.switching(mode); await this.load(mode); this.view = this.idle(); }

  /** The list of providers changed (a plugin registered): the picker is told, nothing reconnects. */
  refreshOffered() { this.view = { ...this.view, offered: this.offered() }; this.options.changed(); }

  /** Closes the source of the mode being left and loads this mode's. `ensureReady` connects it. */
  setMode(mode: WalletMode): Promise<void> {
    this.gate.switching(mode);
    return this.serial(async () => {
      if (mode === this.mode && this.view.mode === mode) return;
      await this.disconnect();
      this.mode = mode;
      await this.load(mode);
      this.view = this.idle(); this.options.changed();
    });
  }

  /**
   * Connects the mode's source in the background, and keeps trying while it cannot be reached: "Connecting…"
   * (with the last balance it read) until the failure is sustained, then "Unavailable", still retrying with
   * backoff. `eager` (Retry, waking up): shows "Connecting…" again while it tries.
   */
  ensureReady(eager = false): Promise<void> {
    return this.connecting ??= this.serial(() => this.connect(eager)).finally(() => { this.connecting = undefined; });
  }

  /** Retry, now: the wait before the next attempt is skipped. Resolves when the attempt ends. */
  retryNow(): Promise<void> {
    if (this.provider || this.stopped) return Promise.resolve();
    clearTimeout(this.retry);
    return this.ensureReady(true);
  }

  /**
   * The app is back (in front, online, the computer woke): a source that is not connected is tried now, and
   * a connected one reads its balance now.
   */
  wake() {
    if (this.stopped) return;
    if (this.provider) { void this.refresh(); return; }
    if (this.failures && !this.connecting) void this.retryNow();
  }

  private async connect(eager = false) {
    clearTimeout(this.retry);
    if (this.stopped || this.provider) return;
    const id = this.stored?.providerId ?? this.options.defaultId;
    const descriptor = id ? this.find(id) : undefined;
    if (!id || !descriptor) { this.view = this.idle(); this.options.changed(); return; }
    if (eager && this.view.status === "error") { this.view = { ...this.view, status: "connecting", retryAt: undefined }; this.options.changed(); }
    const signal = this.controller.signal;
    let secrets: Record<string, string> = {};
    try {
      if (this.stored?.secrets) secrets = JSON.parse(await unsealSeed(this.stored.secrets, this.stored.deviceKey ?? "")) as Record<string, string>;
      const { provider, network, alias } = await this.open(descriptor, { config: this.stored?.config ?? {}, secrets });
      this.descriptor = descriptor; this.provider = provider; this.secrets = secrets;
      this.failures = 0; this.failingSince = undefined;
      this.view = { ...this.idle(), status: "ready", network, alias };
      this.options.changed();
      void this.refresh();
    } catch (error) {
      // Stopped, another mode, or interrupted by a change of settings: whoever did it connects next.
      if (this.stopped || error instanceof ModeChanged || signal.aborted) return;
      const now = Date.now();
      this.failures++;
      this.failingSince ??= now;
      const problem = sourceProblem(error);
      const sustained = problem === "config" || (this.failures >= SUSTAINED_FAILURES && now - this.failingSince >= SUSTAINED_MS);
      const delay = (this.options.backoff ?? retryDelay)(this.failures);
      this.view = { ...this.idle(), status: sustained ? "error" : "connecting", error: `Could not connect to ${descriptor.label}: ${redact(error, secrets)}`, problem, failures: this.failures, retryAt: now + delay };
      this.options.changed();
      this.retry = setTimeout(() => void this.ensureReady(), delay);
    }
  }

  /** Creates a provider and checks it is on a network of this mode before anything uses it. */
  private async open(descriptor: ProviderDescriptor<P>, settings: ProviderSettings, controller = this.controller) {
    const signal = controller.signal;
    const provider = await this.gate.within(abortable(descriptor.create(settings, { ...this.options.host(), mode: this.mode, signal }), signal), (p) => p.close());
    try {
      const { network, alias } = await this.gate.within(provider.info());
      if (!descriptor.networks.includes(network)) throw new Error(`it runs on ${network}, which ${descriptor.label} does not support here`);
      if (networkMode(network) !== this.mode) throw new Error(this.mode === "mainnet" ? `it runs on ${network}, a test network: switch the wallets to Testnet to use it` : "it runs on Bitcoin, real money: switch the wallets to Mainnet to use it");
      return { provider, network, alias };
    } catch (error) { await provider.close().catch(() => {}); throw error; }
  }

  /**
   * Makes `providerId` this mode's source, with the values typed in its form. It is connected and its
   * network checked first; only then are its settings saved (secrets sealed) and the old source closed.
   */
  set(providerId: string, values: Record<string, string>): Promise<void> {
    const interrupted = this.interrupt();
    return this.afterChange(interrupted, this.serial(async () => {
      const descriptor = this.find(providerId);
      if (!descriptor || !offeredIn(descriptor, this.options.host().platform, this.mode)) throw new Error("That source is not available here");
      const settings: ProviderSettings = { config: {}, secrets: {} };
      for (const field of descriptor.fields) {
        const value = (values[field.name] ?? "").trim();
        if (!value && !field.optional) throw new Error(`Enter ${field.label.toLowerCase()}`);
        if (field.kind === "select" && value && !field.options?.some((o) => o.value === value)) throw new Error(`Choose ${field.label.toLowerCase()}`);
        if (value) (field.kind === "secret" ? settings.secrets : settings.config)[field.name] = value;
      }
      descriptor.validate?.(settings, this.mode);
      await this.guard();
      await this.apply(descriptor, settings, false);
    }));
  }

  /**
   * Changes the `changeable` fields (a server address) of this mode's saved source, keeping its sealed
   * secrets and whose money it is: the wallet stays, only where it reads the chain changes. Connected and
   * checked first, like `set`; a refusal leaves the saved source as it was.
   */
  reconfigure(values: Record<string, string>): Promise<void> {
    const interrupted = this.interrupt();
    return this.afterChange(interrupted, this.serial(async () => {
      const stored = this.stored;
      const descriptor = stored ? this.find(stored.providerId) : undefined;
      if (!stored || !descriptor) throw new Error("There is no saved source to change");
      const changeable = descriptor.fields.filter((f) => f.changeable);
      if (!changeable.length) throw new Error(`${descriptor.label} has no server to change`);
      const config = { ...stored.config };
      for (const field of changeable) {
        if (!(field.name in values)) continue;
        const value = (values[field.name] ?? "").trim();
        if (!value && !field.optional) throw new Error(`Enter ${field.label.toLowerCase()}`);
        if (value) config[field.name] = value; else delete config[field.name];
      }
      const secrets = stored.secrets ? JSON.parse(await unsealSeed(stored.secrets, stored.deviceKey ?? "")) as Record<string, string> : {};
      const settings: ProviderSettings = { config, secrets };
      descriptor.validate?.(settings, this.mode);
      await this.apply(descriptor, settings, true);
    }));
  }

  /** A change refused after interrupting an attempt: the saved source goes on connecting as before. */
  private afterChange(interrupted: boolean, change: Promise<void>): Promise<void> {
    return change.finally(() => { if (interrupted && !this.provider && !this.stopped) void this.ensureReady(); });
  }

  /**
   * A connection attempt under way (or waiting to try again) gives way to a change of settings, instead of
   * holding it for its time-out. Says whether there was one.
   */
  private interrupt(): boolean {
    if (this.provider || (!this.connecting && !this.failures)) return false;
    clearTimeout(this.retry);
    this.controller.abort(); this.controller = new AbortController();
    return true;
  }

  /** Connects `settings`, then saves them and replaces the current source. `same`: the same wallet, reconfigured. */
  private async apply(descriptor: ProviderDescriptor<P>, settings: ProviderSettings, same: boolean) {
    const providerId = descriptor.id;
    let opened: Awaited<ReturnType<typeof this.open>>;
    // Its own signal: closing the source it replaces aborts that one's, not this one's.
    const controller = new AbortController();
    try { opened = await this.open(descriptor, settings, controller); }
    catch (error) { throw error instanceof ModeChanged ? error : new Error(`Could not connect to ${descriptor.label}: ${redact(error, settings.secrets)}`); }
    const deviceKey = newDeviceKey();
    const stored: StoredSource = { providerId, config: settings.config, savedAt: Date.now(),
      ...(Object.keys(settings.secrets).length ? { secrets: await sealSeed(JSON.stringify(settings.secrets), deviceKey), deviceKey } : {}) };
    // The default with nothing to configure is what an empty mode already uses: nothing to store.
    const plain = providerId === this.options.defaultId && !Object.keys(settings.config).length && !stored.secrets;
    // Another wallet's last balance is not this one's.
    if (!same) this.seen = undefined;
    try {
      await transact([STORES.settings], (s) => {
        if (plain) s[STORES.settings].delete(storageKey(this.options.kind, this.mode)); else s[STORES.settings].put(stored, storageKey(this.options.kind, this.mode));
        if (!same) s[STORES.settings].delete(seenKey(this.options.kind, this.mode));
      });
    }
    catch (error) { await opened.provider.close().catch(() => {}); throw error; }
    await this.disconnect();
    this.controller = controller;
    this.failures = 0; this.failingSince = undefined;
    this.stored = plain ? undefined : stored; this.descriptor = descriptor; this.provider = opened.provider; this.secrets = settings.secrets;
    this.view = { ...this.idle(), status: "ready", network: opened.network, alias: opened.alias };
    this.options.changed();
    void this.refresh();
  }

  /** Forgets this mode's source (and its sealed secrets): the default, if there is one, takes over. */
  clear(): Promise<void> {
    this.interrupt();
    return this.serial(async () => {
      await this.guard();
      await transact([STORES.settings], (s) => { s[STORES.settings].delete(storageKey(this.options.kind, this.mode)); s[STORES.settings].delete(seenKey(this.options.kind, this.mode)); });
      await this.disconnect();
      this.stored = undefined; this.seen = undefined;
      this.failures = 0; this.failingSince = undefined;
      this.view = this.idle(); this.options.changed();
    }).then(() => this.ensureReady());
  }

  private async guard() {
    const current = this.stored?.providerId ?? this.options.defaultId;
    const refusal = current ? await this.options.refuseReplacing?.(current, this.mode) : undefined;
    if (refusal) throw new Error(refusal);
  }

  /** The connected source, waiting for a connection under way. Throws when there is none. */
  async use(): Promise<{ provider: P; descriptor: ProviderDescriptor<P> }> {
    if (!this.provider) await this.ensureReady();
    if (!this.provider || !this.descriptor) throw new Error(this.view.status === "none" ? `No ${this.options.kind === "onchain" ? "Bitcoin" : "Lightning"} source is set up` : this.view.error ?? "The source is still connecting");
    return { provider: this.provider, descriptor: this.descriptor };
  }

  /** The connected source's id, when one is connected right now. */
  get activeId(): string | undefined { return this.provider ? this.descriptor?.id : undefined; }
  get active(): P | undefined { return this.provider; }

  async refresh() {
    clearTimeout(this.timer);
    const provider = this.provider;
    if (!provider || !this.options.refresh) return;
    try {
      const details = await this.options.refresh(provider);
      if (provider !== this.provider) return;
      this.view = { ...this.view, ...details, balanceAt: undefined, error: undefined };
      this.remember(details);
    } catch (error) {
      if (provider !== this.provider) return;
      this.view = { ...this.view, error: `Could not read the balance: ${redact(error, this.secrets)}` };
    }
    this.options.changed();
    if (this.provider) this.timer = setTimeout(() => void this.refresh(), this.options.refreshMs ?? 15_000);
  }

  /** Keeps the balance read, for the next start: written only when it changed. */
  private remember({ balance, unconfirmed }: Partial<Pick<SourceView, "balance" | "unconfirmed">>) {
    const providerId = this.descriptor?.id;
    // The default (the Cashu mints) connects without a network: nothing to show meanwhile.
    if (!providerId || providerId === this.options.defaultId || (balance === undefined && unconfirmed === undefined)) return;
    const was = this.seen;
    if (was?.providerId === providerId && was.balance === balance && was.unconfirmed === unconfirmed) return;
    const seen: SeenBalance = { providerId, balance, unconfirmed, at: Date.now() }, key = seenKey(this.options.kind, this.mode);
    this.seen = seen;
    void transact([STORES.settings], (s) => { s[STORES.settings].put(seen, key); }).catch(() => {});
  }

  private async disconnect() {
    clearTimeout(this.timer); clearTimeout(this.retry);
    this.controller.abort(); this.controller = new AbortController();
    const provider = this.provider;
    this.provider = undefined; this.descriptor = undefined; this.secrets = {};
    await provider?.close().catch(() => {});
  }

  /** Shutting down: nothing reconnects afterwards. */
  async stop() { this.stopped = true; await this.serial(() => this.disconnect()); }
}
