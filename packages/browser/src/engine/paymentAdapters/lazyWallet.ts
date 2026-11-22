import type { WalletNetwork } from "@ghostly/core";
import { store, STORES, wrap } from "../../shared/idb";
import { networkLabel } from "./modeGate";
import { walletKey } from "./walletNetworks";
import { SPARK_MAINNET_NEEDS_KEY, sparkNetworkFor } from "./walletModes";
import type { ArkWallet } from "./arkWallet";
import type { BarkWallet } from "./barkWallet";
import type { FedimintEvents, FedimintWallet } from "./fedimintWallet";
import type { FedimintSdk } from "./fedimintSdk";
import type { SparkWallet } from "./sparkWallet";
import type { UsdtWallet } from "./usdtWallet";

/** What the engine does to every wallet of a kind at start, at its turn and at its stop. */
type Control = "start" | "ensureReady" | "stop";
interface Wallet { start(): Promise<void>; ensureReady(create?: boolean): Promise<void>; stop(): Promise<void> }

/**
 * A kind of wallet whose class loads with its first saved wallet. `idle`: what it answers while none is saved (no
 * seed, no federation): its empty view, and what is asked of it at once. `loads`: everything else it does, done by
 * the wallet once its module loaded. The two name every member of the class between them, or this does not compile.
 */
interface Kind<W extends Wallet, I extends keyof W> {
  /** A wallet of this kind and network is saved: read from storage, without the wallet's module. */
  saved(): Promise<boolean>;
  load(): Promise<W>;
  idle: Pick<W, I>;
  loads: Record<Exclude<keyof W, I | Control>, true>;
}

/**
 * One network's wallet of a kind (Ark, Bark, Fedimint, Spark, USDT), as the engine uses it: its class and the code
 * around it load when a saved wallet of the kind starts or one is made, restored or joined, not with the app. Until
 * then the empty wallet answers.
 */
export function lazyWallet<W extends Wallet, I extends keyof W>(kind: Kind<W, I>): W {
  let wallet: W | undefined;
  let loading: Promise<W> | undefined;
  let started = false;
  /** What was set on the wallet before it loaded (a test's SDK or spy): it gets it once made. */
  const early = new Map<PropertyKey, PropertyDescriptor>();
  /** The class's own method, not a replacement set on the wallet that may call this one. */
  const ownMethod = (made: W, name: PropertyKey, args: unknown[]) => (Object.getPrototypeOf(made)[name] as (...a: unknown[]) => unknown).apply(made, args);
  const load = (): Promise<W> => loading ??= kind.load().then(async (made) => {
    for (const [name, descriptor] of early) Object.defineProperty(made, name, descriptor);
    early.clear();
    wallet = made;
    if (started) await made.start().catch((error: unknown) => { wallet = loading = undefined; throw error; });
    return made;
  }, (error: unknown) => { loading = undefined; throw error; });
  const control: Pick<Wallet, Control> = {
    async start() {
      started = true;
      if (wallet) return ownMethod(wallet, "start", []) as Promise<void>;
      if (loading || await kind.saved()) await load();
    },
    // None saved: nothing to open, unless asked to make the default one.
    ensureReady(create?: boolean) {
      return wallet || loading || create ? load().then((made) => ownMethod(made, "ensureReady", [create]) as Promise<void>) : Promise.resolve();
    },
    stop() { return wallet || loading ? load().then((made) => ownMethod(made, "stop", []) as Promise<void>) : Promise.resolve(); },
  };
  const later = (name: PropertyKey) => (...args: unknown[]) => load().then((made) => ownMethod(made, name, args));
  const owns = (on: object, name: PropertyKey) => Object.prototype.hasOwnProperty.call(on, name);
  const known = (name: PropertyKey) => owns(control, name) || owns(kind.idle, name) || owns(kind.loads, name);
  const read = (name: PropertyKey): unknown => {
    if (wallet) { const value = Reflect.get(wallet, name); return typeof value === "function" ? value.bind(wallet) : value; }
    if (early.has(name)) return early.get(name)!.value;
    if (owns(control, name)) return control[name as Control];
    if (owns(kind.idle, name)) return kind.idle[name as I];
    if (owns(kind.loads, name)) return later(name);
    return undefined;
  };
  const define = (name: PropertyKey, descriptor: PropertyDescriptor) => {
    if (wallet) return Reflect.defineProperty(wallet, name, descriptor);
    early.set(name, { writable: true, enumerable: true, configurable: true, ...descriptor });
    return true;
  };
  return new Proxy({}, {
    get: (_target, name) => read(name),
    set: (_target, name, value) => define(name, { value }),
    defineProperty: (_target, name, descriptor) => define(name, descriptor),
    // An instance of its class once loaded, not before.
    getPrototypeOf: () => wallet ? Object.getPrototypeOf(wallet) : Object.prototype,
    has: (_target, name) => (wallet ? name in wallet : early.has(name) || known(name)),
    // What a spy reads before it replaces a method (vi.spyOn).
    getOwnPropertyDescriptor: (_target, name) => (wallet ? name in wallet : early.has(name) || known(name)) ? { value: read(name), writable: true, enumerable: true, configurable: true } : undefined,
  }) as W;
}

const savedUnder = (key: string) => async () => await wrap<number>((await store(STORES.settings, "readonly")).count(key)) > 0;
/** `changed(false)`: a balance read that found nothing new (see each wallet's constructor). */
type Changed = (viewChanged?: boolean) => void;

export const lazyArkWallet = (network: WalletNetwork, changed: Changed) => lazyWallet<ArkWallet, "network" | "adapter" | "view" | "configured" | "cutShort" | "resume" | "refresh" | "require">({
  saved: savedUnder(walletKey("arkWallet", network)),
  load: async () => new (await import("./arkWallet")).ArkWallet(network, changed),
  idle: {
    network, adapter: undefined, view: { configured: false, locked: true, automatic: false, balance: 0 }, configured: false,
    cutShort: () => {}, resume: () => {}, refresh: async () => {},
    require: () => { throw new Error("Unlock your Ark wallet or wait for it to connect"); },
  },
  loads: { createDefaultNow: true, create: true, unlock: true, remove: true, lock: true, backup: true, exportBackup: true, restoreBackup: true, recover: true, target: true },
});

export const lazyBarkWallet = (network: WalletNetwork, changed: Changed) => lazyWallet<BarkWallet, "network" | "adapter" | "view" | "configured" | "cutShort" | "resume" | "refresh" | "require">({
  saved: savedUnder(walletKey("barkWallet", network)),
  load: async () => new (await import("./barkWallet")).BarkWallet(network, changed),
  idle: {
    network, adapter: undefined, view: { configured: false, locked: true, balance: 0 }, configured: false,
    cutShort: () => {}, resume: () => {}, refresh: async () => {},
    require: () => { throw new Error("Wait for your Bark wallet to connect"); },
  },
  loads: { createDefaultNow: true, create: true, remove: true, lock: true, board: true, target: true, backup: true, exportBackup: true, restoreBackup: true },
});

export const lazySparkWallet = (network: WalletNetwork, changed: Changed) => {
  const needsKey = network === "mainnet";
  const view = { configured: false, locked: true, balance: 0, network: sparkNetworkFor(network), ...(needsKey ? { needsKey, unavailable: SPARK_MAINNET_NEEDS_KEY } : {}) };
  return lazyWallet<SparkWallet, "network" | "adapter" | "view" | "configured" | "cutShort" | "resume" | "refresh" | "require" | "breezDatabase">({
    saved: savedUnder(walletKey("sparkWallet", network)),
    load: async () => new (await import("./sparkWallet")).SparkWallet(network, changed),
    idle: {
      network, adapter: undefined, view, configured: false,
      cutShort: () => {}, resume: () => {}, refresh: async () => {}, breezDatabase: async () => undefined,
      require: () => { throw new Error(view.unavailable ?? "Wait for your Spark wallet to connect"); },
    },
    loads: { create: true, remove: true, lock: true, target: true, backup: true, exportBackup: true, restoreBackup: true },
  });
};

export const lazyUsdtWallet = (network: WalletNetwork, changed: Changed) => {
  const require = () => { throw new Error("Unlock your USDT wallet or wait for it to connect"); };
  return lazyWallet<UsdtWallet, "network" | "adapter" | "view" | "configured" | "cutShort" | "resume" | "refresh" | "require" | "target">({
    saved: savedUnder(walletKey("usdtWallet", network)),
    load: async () => new (await import("./usdtWallet")).UsdtWallet(network, changed),
    idle: {
      network, adapter: undefined, view: { configured: false, locked: true, automatic: false, balance: "0", gasBalance: "0" }, configured: false,
      cutShort: () => {}, resume: () => {}, refresh: async () => {}, require, target: require,
    },
    loads: { createDefaultNow: true, create: true, unlock: true, remove: true, lock: true, getTestTokens: true, reveal: true, exportBackup: true, restoreBackup: true },
  });
};

/** `sdk`: the Fedimint SDK to use instead of the real one (a test's), read when a federation opens. */
export const lazyFedimintWallet = (network: WalletNetwork, events: FedimintEvents, sdk: () => (() => Promise<FedimintSdk>) | undefined) => {
  const notJoined = (): never => { throw new Error(`You have not joined this federation in your ${networkLabel(network)} Fedimint wallet`); };
  return lazyWallet<FedimintWallet, "network" | "view" | "configured" | "cutShort" | "resume" | "refresh" | "client" | "federation" | "ready" | "requestFederations" | "invoiceFederation" | "spendState" | "target" | "inspectNotes" | "checkReceives">({
    saved: savedUnder(`fedimintWallet-${network}`),
    load: async () => {
      const [{ FedimintWallet }, { loadFedimintSdk }] = await Promise.all([import("./fedimintWallet"), import("./fedimintSdk")]);
      return new FedimintWallet(network, events, () => (sdk() ?? loadFedimintSdk)());
    },
    idle: {
      network, view: { federations: [], balance: 0, history: [] }, configured: false,
      cutShort: () => {}, resume: () => {}, refresh: async () => {}, checkReceives: async () => {}, inspectNotes: async () => null,
      client: notJoined, spendState: notJoined, federation: () => undefined, ready: () => [], requestFederations: () => [], invoiceFederation: () => undefined,
      target: () => { throw new Error("You have not joined this federation in this wallet"); },
    },
    loads: { preview: true, join: true, leave: true, remove: true, spendNotes: true, redeemNotes: true, redeemState: true, receiveNotes: true, takeBack: true, spendFor: true, createInvoice: true, backup: true, exportBackup: true, restoreBackup: true, restorePhrase: true },
  });
};
