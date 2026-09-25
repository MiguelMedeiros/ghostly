import { setBrowserHost, type BrowserHost } from "@ghostly/browser/host";
import { engine } from "@ghostly/browser/platform/engine";
import type { EngineApi, EngineEvent, EngineMethod, RpcRequest, RpcResponse } from "@ghostly/browser/shared/rpc";
import type { EngineState, GroupView, LinkView, NetworkWalletsView, PaymentView, StoredMessage, WalletOffer, WalletView } from "@ghostly/browser/shared/types";
import { WALLET_TYPES } from "@ghostly/browser/shared/types";
import { walletInstances } from "@ghostly/browser/engine/paymentAdapters/walletInstances";
import { mintNetwork } from "@ghostly/browser/shared/mints";
import { WALLET_NETWORKS, walletNetworkOf, type WalletNetwork } from "@ghostly/core";

type Params<M extends EngineMethod> = Parameters<EngineApi[M]> extends [infer P] ? P : undefined;
type Handler<M extends EngineMethod> = (params: Params<M>) => Awaited<ReturnType<EngineApi[M]>> | Promise<Awaited<ReturnType<EngineApi[M]>>>;

/** A patch one level deep: `settings`, `wallet` and the rest merge into the defaults instead of replacing them. */
export type StatePatch = { [K in keyof EngineState]?: EngineState[K] extends unknown[] | Record<string, PaymentView> ? EngineState[K] : Partial<EngineState[K]> };

/**
 * A wallet as the engine shows it. A test gives the flat fields (the old shape: `mints`, `ark`, `usdt`…); each one
 * lands on its own network, read from its chain (a test mint, Mutinynet, Sepolia…), and the wallets the profile has
 * follow from that, as the engine lists them. A test may give `networks`, `wallets` or `offers` itself instead.
 */
export function walletView(patch: Partial<WalletView> = {}): WalletView {
  const flat: WalletView = { mode: "mainnet", mints: [], balance: 0, history: [], feesPaid: 0, ...patch };
  // What this made before (a state patched again) is made again from the flat fields; what a test gave, kept.
  const given = <T extends object>(value: T | undefined) => value && !derived.has(value) ? value : undefined;
  const networks = given(patch.networks) ?? mark(splitByNetwork(flat));
  const wallets = given(patch.wallets) ?? mark(walletInstances(networks));
  return { ...flat, networks, wallets, offers: given(patch.offers) ?? mark(offersFor(networks, wallets)) };
}
const derived = new WeakSet<object>();
const mark = <T extends object>(value: T): T => { derived.add(value); return value; };

const chainNetwork = (chain: string | undefined, fallback: WalletNetwork): WalletNetwork => chain ? walletNetworkOf(chain) : fallback;
function splitByNetwork(flat: WalletView): Record<WalletNetwork, NetworkWalletsView> {
  const fallback = flat.mode ?? "mainnet";
  // The flat balance is its mints' network's: a test sets it beside mints of one network.
  const balanceOf = (network: WalletNetwork) => flat.mints.some((m) => mintNetwork(m.url) === network) || (!flat.mints.length && network === fallback) ? flat.balance : 0;
  const on = <V,>(view: V | undefined, network: WalletNetwork, networkOfView: (v: V) => WalletNetwork) => view && networkOfView(view) === network ? view : undefined;
  const build = (network: WalletNetwork): NetworkWalletsView => {
    const mints = flat.mints.filter((m) => mintNetwork(m.url) === network);
    return {
      mints, balance: balanceOf(network), history: flat.history, feesPaid: flat.feesPaid,
      ark: on(flat.ark, network, (v) => chainNetwork(v.network, fallback)),
      bark: on(flat.bark, network, (v) => chainNetwork(v.network, "testnet")),
      spark: on(flat.spark, network, (v) => chainNetwork(v.network, fallback)),
      usdt: on(flat.usdt, network, (v) => v.chainId ? (v.chainId === 1 ? "mainnet" : "testnet") : chainNetwork(v.network, fallback)),
      fedimint: on(flat.fedimint, network, (v) => v.unavailable ? "mainnet" : chainNetwork(v.federations[0]?.network, fallback)),
      bitcoin: on(flat.bitcoin, network, (v) => v.mode ?? fallback),
      // The Cashu mints are Lightning's default source, as in the engine: a network with mints has it.
      lightning: on(flat.lightning, network, (v) => v.mode ?? fallback) ?? (mints.length && !flat.lightning ? { mode: network, providerId: "cashu-mint", status: "ready", offered: [], recent: [] } : undefined),
    };
  };
  return { mainnet: build("mainnet"), testnet: build("testnet") };
}
function offersFor(networks: Record<WalletNetwork, NetworkWalletsView>, wallets: WalletView["wallets"] = []): WalletOffer[] {
  return WALLET_TYPES.flatMap((type) => WALLET_NETWORKS.map((network): WalletOffer => {
    const exists = wallets.some((w) => w.type === type && w.network === network);
    if ((type === "bark" || type === "spark" || type === "fedimint") && network === "mainnet") return { type, network, exists, available: false, reason: `${type} on Mainnet is not available yet` };
    if (type === "fedimint") return { type, network, exists, available: true, needs: "invite" };
    if (type === "lightning" || type === "bitcoin") {
      const providers = (type === "lightning" ? networks[network].lightning : networks[network].bitcoin)?.offered.filter((d) => d.id !== "cashu-mint") ?? [];
      return providers.length ? { type, network, exists, available: true, needs: "provider", providers } : { type, network, exists, available: false, reason: "No source runs here yet" };
    }
    return { type, network, exists, available: true };
  }));
}

/** The state of a peer that has just started: online, no chats, an empty wallet. */
export function engineState(patch: StatePatch = {}): EngineState {
  const base: EngineState = {
    settings: { online: true, nick: "Ghost", relays: [], iceServers: [], mints: [], mintsInitialized: true },
    transport: { protocol: "webrtc/1", relays: [] },
    links: [],
    services: [],
    transfers: {},
    wallet: walletView(),
    payments: {},
    identityProofs: [],
    nostr: { own: [], settings: { relays: [], autoLoadProfiles: false, publish: false } },
    groups: [],
  };
  return {
    ...base,
    ...patch,
    settings: { ...base.settings, ...patch.settings },
    transport: { ...base.transport, ...patch.transport },
    wallet: walletView(patch.wallet ?? {}),
    nostr: { ...base.nostr, ...patch.nostr },
  } as EngineState;
}

/** A chat with a contact whose app is connected. */
export function linkView(patch: Partial<LinkView> = {}): LinkView {
  return {
    id: "link-1",
    myPubKeyZ32: "me",
    peerPubKeyZ32: "peer",
    createdAt: 0,
    status: "connected",
    dataLink: "open",
    peerOnline: true,
    peerLastSeenAt: 0,
    peerServices: null,
    lastMessageAt: 0,
    peerAck: 0,
    lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 },
    ...patch,
  } as LinkView;
}

export function paymentView(patch: Partial<PaymentView> = {}): PaymentView {
  return {
    id: "pay-1",
    linkId: "link-1",
    kind: "payment",
    direction: "in",
    amount: 21,
    unit: "sat",
    state: "pending",
    createdAt: 0,
    ...patch,
  } as PaymentView;
}

export function groupView(patch: Partial<GroupView> = {}): GroupView {
  return { id: "group-1", name: "Friends", profile: "mesh", createdAt: 0, isAdmin: false, members: [], invited: [], memberLinks: {}, lastMessageAt: 0, canSend: true, ...patch };
}

/**
 * The browser host the UI talks to in tests: `engine` (packages/browser/src/platform/engine.ts) connects to it
 * as it would to the real peer, and every call it makes is recorded here and answered by a handler the test
 * sets. A call nobody handles fails the way an engine error would, so a test never passes on a silent no-op.
 */
export class FakeEngine implements BrowserHost {
  version = "0.0.0-test";
  features = { shareLocalServices: false, openServices: false, profiles: false };
  state: EngineState = engineState();
  /** Every request, in order. */
  readonly calls: { method: EngineMethod; params: unknown }[] = [];
  openPaymentLink?: BrowserHost["openPaymentLink"];
  /** The desktop host's native clipboard read, when a test gives one; left out, the page's Clipboard API is used. */
  readClipboardText?: BrowserHost["readClipboardText"];
  /** Every web host can sign in to an AT Protocol server; this window never answers unless a test replaces it. */
  atproto?: BrowserHost["atproto"] = { platform: "web", open: () => new Promise(() => {}) };

  private handlers = new Map<EngineMethod, (params: never) => unknown>();
  private send: ((message: EngineEvent | RpcResponse) => void) | null = null;

  async connect(onMessage: (message: EngineEvent | RpcResponse) => void) {
    this.send = onMessage;
    onMessage({ kind: "state", state: this.state });
    return { send: (request: RpcRequest) => this.handle(request) };
  }

  requestLocalAccess = async () => false;
  openService = async () => {};

  /** Answers `method` from now on. */
  on<M extends EngineMethod>(method: M, handler: Handler<M>): this {
    this.handlers.set(method, handler as (params: never) => unknown);
    return this;
  }

  /** The params of every call to `method`. */
  callsTo<M extends EngineMethod>(method: M): Params<M>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params as Params<M>);
  }

  /** Replaces the state (patching the defaults) and tells the pages, as the peer does after every change. */
  setState(patch: StatePatch): void {
    this.state = engineState(patch);
    this.send?.({ kind: "state", state: this.state });
  }

  /** Patches the current state. */
  update(patch: StatePatch): void {
    this.setState({ ...this.state, ...patch } as StatePatch);
  }

  emit(event: EngineEvent): void {
    this.send?.(event);
  }

  messages(linkId: string, messages: StoredMessage[]): void {
    this.emit({ kind: "messages", linkId, messages });
  }

  reset(): void {
    this.calls.length = 0;
    this.handlers.clear();
    this.openPaymentLink = undefined;
    this.readClipboardText = undefined;
    this.setState({});
  }

  private handle(request: RpcRequest): void {
    this.calls.push({ method: request.method, params: request.params });
    const handler = this.handlers.get(request.method);
    const reply = (message: Omit<RpcResponse, "kind" | "id">) => this.send?.({ kind: "response", id: request.id, ...message });
    queueMicrotask(async () => {
      if (!handler) return reply({ error: `FakeEngine: nothing answers "${request.method}"` });
      try {
        reply({ result: await handler(request.params as never) });
      } catch (e) {
        reply({ error: e instanceof Error ? e.message : String(e) });
      }
    });
  }
}

export const fakeEngine = new FakeEngine();

/** Called once per test file by the setup: the UI's engine connects to the fake before anything renders. */
export async function installFakeEngine(): Promise<void> {
  setBrowserHost(fakeEngine);
  await engine.connect();
}
