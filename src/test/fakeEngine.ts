import { setBrowserHost, type BrowserHost } from "@ghostly/browser/host";
import { engine } from "@ghostly/browser/platform/engine";
import type { EngineApi, EngineEvent, EngineMethod, RpcRequest, RpcResponse } from "@ghostly/browser/shared/rpc";
import type { EngineState, GroupView, LinkView, PaymentView, StoredMessage, WalletView } from "@ghostly/browser/shared/types";

type Params<M extends EngineMethod> = Parameters<EngineApi[M]> extends [infer P] ? P : undefined;
type Handler<M extends EngineMethod> = (params: Params<M>) => Awaited<ReturnType<EngineApi[M]>> | Promise<Awaited<ReturnType<EngineApi[M]>>>;

/** A patch one level deep: `settings`, `wallet` and the rest merge into the defaults instead of replacing them. */
export type StatePatch = { [K in keyof EngineState]?: EngineState[K] extends unknown[] | Record<string, PaymentView> ? EngineState[K] : Partial<EngineState[K]> };

export function walletView(patch: Partial<WalletView> = {}): WalletView {
  return { mode: "mainnet", mints: [], balance: 0, history: [], feesPaid: 0, ...patch };
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
    wallet: { ...base.wallet, ...patch.wallet },
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
  return { id: "group-1", name: "Friends", createdAt: 0, isAdmin: false, members: [], invited: [], memberLinks: {}, lastMessageAt: 0, canSend: true, ...patch };
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
