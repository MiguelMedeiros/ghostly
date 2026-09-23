import { STORES, store, transact, wrap } from "../../../shared/idb";
import type { WalletMode } from "../../../shared/mints";
import { ModeChanged, ModeGate } from "../modeGate";
import { newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "../persistence";
import { offeredIn } from "./registry";
import { describeProvider, networkMode, redact, type ProviderDescriptor, type ProviderDescriptorView, type ProviderHost, type ProviderKind, type ProviderNetwork, type ProviderSettings } from "./types";

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
  error?: string;
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
}

const storageKey = (kind: ProviderKind, mode: WalletMode) => `${kind}Source-${mode}`;

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
  private stopped = false;
  view: SourceView = { mode: "mainnet", status: "none", offered: [] };

  constructor(private readonly options: SourcesOptions<P>) {}

  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next; }
  private find(id: string) { return this.options.descriptors().find((d) => d.id === id); }
  private offered() { return this.options.descriptors().filter((d) => offeredIn(d, this.options.host().platform, this.mode)).map((d) => describeProvider(d as ProviderDescriptor<unknown>)); }
  private async load(mode: WalletMode) { return wrap<StoredSource | undefined>((await store(STORES.settings, "readonly")).get(storageKey(this.options.kind, mode))); }

  /** The source of the mode (stored, else the default), not connected yet. */
  private idle(): SourceView {
    const id = this.stored?.providerId ?? this.options.defaultId;
    const descriptor = id ? this.find(id) : undefined;
    return {
      mode: this.mode, offered: this.offered(), providerId: id, label: descriptor?.label ?? id, custodial: descriptor?.custodial,
      isDefault: !!id && id === this.options.defaultId, config: this.stored?.config,
      secrets: descriptor?.fields.filter((f) => f.kind === "secret" && this.stored?.secrets).map((f) => f.name),
      status: !id ? "none" : descriptor ? "connecting" : "error",
      error: id && !descriptor ? `${id} is not available in this version of Ghostly` : undefined,
    };
  }

  async start(mode: WalletMode) { this.mode = mode; this.gate.switching(mode); this.stored = await this.load(mode); this.view = this.idle(); }

  /** Closes the source of the mode being left and loads this mode's. `ensureReady` connects it. */
  setMode(mode: WalletMode): Promise<void> {
    this.gate.switching(mode);
    return this.serial(async () => {
      if (mode === this.mode && this.view.mode === mode) return;
      await this.disconnect();
      this.mode = mode;
      this.stored = await this.load(mode);
      this.view = this.idle(); this.options.changed();
    });
  }

  /** Connects the mode's source in the background, and keeps retrying while it cannot be reached. */
  ensureReady(): Promise<void> {
    return this.connecting ??= this.serial(() => this.connect()).finally(() => { this.connecting = undefined; });
  }

  private async connect() {
    clearTimeout(this.retry);
    if (this.stopped || this.provider) return;
    const id = this.stored?.providerId ?? this.options.defaultId;
    const descriptor = id ? this.find(id) : undefined;
    if (!id || !descriptor) { this.view = this.idle(); this.options.changed(); return; }
    let secrets: Record<string, string> = {};
    try {
      if (this.stored?.secrets) secrets = JSON.parse(await unsealSeed(this.stored.secrets, this.stored.deviceKey ?? "")) as Record<string, string>;
      const { provider, network, alias } = await this.open(descriptor, { config: this.stored?.config ?? {}, secrets });
      this.descriptor = descriptor; this.provider = provider; this.secrets = secrets;
      this.view = { ...this.idle(), status: "ready", network, alias };
      this.options.changed();
      void this.refresh();
    } catch (error) {
      if (this.stopped || error instanceof ModeChanged) return;
      this.view = { ...this.idle(), status: "error", error: `Could not connect to ${descriptor.label}: ${redact(error, secrets)}` };
      this.options.changed();
      this.retry = setTimeout(() => void this.ensureReady(), 30_000);
    }
  }

  /** Creates a provider and checks it is on a network of this mode before anything uses it. */
  private async open(descriptor: ProviderDescriptor<P>, settings: ProviderSettings, controller = this.controller) {
    const signal = controller.signal;
    const provider = await this.gate.within(descriptor.create(settings, { ...this.options.host(), mode: this.mode, signal }), (p) => p.close());
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
    return this.serial(async () => {
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
      try { await transact([STORES.settings], (s) => { if (plain) s[STORES.settings].delete(storageKey(this.options.kind, this.mode)); else s[STORES.settings].put(stored, storageKey(this.options.kind, this.mode)); }); }
      catch (error) { await opened.provider.close().catch(() => {}); throw error; }
      await this.disconnect();
      this.controller = controller;
      this.stored = plain ? undefined : stored; this.descriptor = descriptor; this.provider = opened.provider; this.secrets = settings.secrets;
      this.view = { ...this.idle(), status: "ready", network: opened.network, alias: opened.alias };
      this.options.changed();
      void this.refresh();
    });
  }

  /** Forgets this mode's source (and its sealed secrets): the default, if there is one, takes over. */
  clear(): Promise<void> {
    return this.serial(async () => {
      await this.guard();
      await transact([STORES.settings], (s) => { s[STORES.settings].delete(storageKey(this.options.kind, this.mode)); });
      await this.disconnect();
      this.stored = undefined;
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
      this.view = { ...this.view, ...details, error: undefined };
    } catch (error) {
      if (provider !== this.provider) return;
      this.view = { ...this.view, error: `Could not read the balance: ${redact(error, this.secrets)}` };
    }
    this.options.changed();
    if (this.provider) this.timer = setTimeout(() => void this.refresh(), this.options.refreshMs ?? 15_000);
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
