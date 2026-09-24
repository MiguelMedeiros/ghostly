import { getBrowserHost, type EngineConnection } from "../host";
import type { AttentionEvent, EngineApi, EngineEvent, EngineMethod, RpcResponse } from "../shared/rpc";
import type { EngineState, LinkView, StoredMessage } from "../shared/types";

type Result<M extends EngineMethod> = Awaited<ReturnType<EngineApi[M]>>;

/**
 * This page's connection to the Ghostly peer, wherever the host keeps it. The
 * peer owns the network; pages only ask it to do things.
 */
class EngineClient {
  state: EngineState | null = null;
  readonly messages = new Map<string, StoredMessage[]>();

  private connection: EngineConnection | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly stateListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(linkId: string, messages: StoredMessage[]) => void>();
  private readonly attentionListeners = new Set<(event: AttentionEvent) => void>();
  private readonly callListeners = new Set<(linkId: string, signal: string) => void>();
  /**
   * The latest call offer per link, until something answers or ends it: a chat that is not open
   * when the call comes in is loaded because of it, and then reads the offer it would have missed.
   * Offers expire by themselves (`parseCallSignal` refuses old ones).
   */
  private readonly offers = new Map<string, string>();

  subscribe(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onMessages(listener: (linkId: string, messages: StoredMessage[]) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onAttention(listener: (event: AttentionEvent) => void): () => void {
    this.attentionListeners.add(listener);
    return () => this.attentionListeners.delete(listener);
  }

  /** The pending offer for this link, taken: it is handed out once. */
  takeCallOffer(linkId: string): string | undefined {
    const offer = this.offers.get(linkId);
    this.offers.delete(linkId);
    return offer;
  }

  onCallSignal(listener: (linkId: string, signal: string) => void): () => void {
    this.callListeners.add(listener);
    return () => this.callListeners.delete(listener);
  }

  /** A chat by its peer's key, or the edge of a group toward a member (payments with that member use it). */
  linkByPeer(peerPubKeyZ32: string): LinkView | undefined {
    return this.state?.links.find((l) => l.peerPubKeyZ32 === peerPubKeyZ32) ?? this.state?.edges?.find((l) => l.peerPubKeyZ32 === peerPubKeyZ32);
  }

  async call<M extends EngineMethod>(method: M, ...params: Parameters<EngineApi[M]>): Promise<Result<M>> {
    await this.connect();
    const connection = this.connection;
    if (!connection) throw new Error("Ghostly is starting…");
    const id = this.nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      connection.send({ kind: "request", id, method, params: params[0] } as Parameters<EngineConnection["send"]>[0]);
    });
  }

  /** Pages call this once at startup; calls made earlier wait for it. */
  connect(): Promise<void> {
    if (this.connection) return Promise.resolve();
    this.connecting ??= getBrowserHost()
      .connect(
        (message) => this.handle(message),
        () => {
          this.connection = null;
          for (const pending of this.pending.values()) pending.reject(new Error("Lost the Ghostly peer"));
          this.pending.clear();
          setTimeout(() => void this.connect().catch(() => {}), 500);
        },
      )
      .then((connection) => {
        this.connection = connection;
      })
      .finally(() => (this.connecting = null));
    return this.connecting;
  }

  private handle(message: EngineEvent | RpcResponse): void {
    switch (message.kind) {
      case "attention":
        for (const listener of this.attentionListeners) listener(message.event);
        break;
      case "state":
        this.state = message.state;
        for (const listener of this.stateListeners) listener();
        break;
      case "messages":
        this.messages.set(message.linkId, message.messages);
        for (const listener of this.messageListeners) listener(message.linkId, message.messages);
        break;
      case "call-signal": {
        let kind: unknown;
        try { kind = (JSON.parse(message.signal) as { t?: unknown })?.t; } catch { kind = undefined; }
        if (kind === "o") this.offers.set(message.linkId, message.signal);
        else this.offers.delete(message.linkId);
        for (const listener of this.callListeners) listener(message.linkId, message.signal);
        break;
      }
      case "response": {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error !== undefined) pending?.reject(new Error(message.error));
        else pending?.resolve(message.result);
        break;
      }
    }
  }
}

export const engine = new EngineClient();
