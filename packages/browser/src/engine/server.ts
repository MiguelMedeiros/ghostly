import { parseCallSignal } from "@ghostly/core";
import type { MessageChanges } from "../shared/messageChanges";
import type { EngineEvent, RpcRequest, RpcResponse } from "../shared/rpc";
import type { StoredMessage } from "../shared/types";
import { profileOpenFailure } from "../shared/idb";
import type { PeerServer } from "../devices/linkOnly";
import { GhostlyNode, type NodeOptions } from "./node";

/**
 * The peer plus what it takes to serve UI clients: answer their calls, and
 * tell every one of them what changes. How clients are attached (an extension
 * port, a function call in the same page) is the host's business.
 */
export interface EngineClientSink {
  post(message: EngineEvent | RpcResponse): void;
}

export class EngineServer implements PeerServer {
  /** The whole engine: never made on a device that is not the active one (`devices/peer.ts` decides, WISP 06 § The gate). */
  readonly gated = false;
  readonly node: GhostlyNode;
  readonly ready: Promise<void>;
  private readonly clients = new Set<EngineClientSink>();
  /**
   * Per client, the chats and groups whose whole history it was sent. It hears only what changes in those; one it
   * does not have yet is sent whole first (read once, when its first change comes), then what changes.
   */
  private readonly histories = new WeakMap<EngineClientSink, Set<string>>();
  /** Per chat or group, what is still being sent (a whole history being read): what comes next waits for it. */
  private readonly sending = new Map<string, Promise<void>>();
  /**
   * Per chat, the contact's call offer that nothing here has answered yet. A client that attaches while it rings hears
   * it too: the extension's peer runs with no tab open, and a tab opened during the ring used to show no call.
   */
  private readonly offers = new Map<string, string>();

  constructor(options: NodeOptions = {}) {
    this.node = new GhostlyNode(
      {
        onAttention: (event) => this.broadcast({kind:"attention", event}),
        onState: (state) => this.broadcast({ kind: "state", state }),
        onMessages: (linkId, messages) => void this.inOrder(linkId, () => this.sendHistory(linkId, messages)).catch(() => {}),
        onMessageChanges: (linkId, changes) => void this.inOrder(linkId, () => this.sendChanges(linkId, changes)).catch(() => {}),
        onCallSignal: (linkId, signal) => {
          if (signalKind(signal) === "o") this.offers.set(linkId, signal);
          else this.offers.delete(linkId);
          this.broadcast({ kind: "call-signal", linkId, signal });
        },
      },
      options,
    );
    this.ready = this.node.start();
    // A start that fails is told to each client as it attaches; nothing else may be left to report it as unhandled.
    this.ready.catch(() => {});
  }

  attach(client: EngineClientSink): void {
    this.clients.add(client);
    this.histories.set(client, new Set());
    void this.ready.then(async () => {
      if (!this.clients.has(client)) return;
      client.post({ kind: "state", state: this.node.getState() });
      // A call still ringing; one too old to answer is forgotten (the client would refuse it too).
      for (const [linkId, signal] of this.offers) {
        if (parseCallSignal(signal)?.t === "o") client.post({ kind: "call-signal", linkId, signal });
        else this.offers.delete(linkId);
      }
      for (const link of this.node.getState().links) {
        await this.inOrder(link.id, async () => {
          if (!this.clients.has(client)) return;
          client.post({ kind: "messages", linkId: link.id, messages: await this.node.getMessages(link.id) });
          this.histories.get(client)?.add(link.id);
        });
      }
    }, (error: unknown) => {
      // The peer never started (the profile's database did not open): the client is told why, so the app says so
      // instead of showing a chat list that looks alive. Before, this was dropped here and nothing was said.
      this.post(client, { kind: "start-failed", failure: profileOpenFailure(error) });
    }).catch(() => {
      // The client went away mid-snapshot (dropped, as broadcast does).
      this.clients.delete(client);
    });
  }

  stop(): Promise<void> {
    return this.node.shutdown();
  }

  detach(client: EngineClientSink): void {
    this.clients.delete(client);
    this.histories.delete(client);
    if (this.clients.size === 0) this.node.setActiveLink({ linkId: null });
  }

  async handle(client: EngineClientSink, request: RpcRequest): Promise<void> {
    if (request?.kind !== "request") return;
    const response: RpcResponse = { kind: "response", id: request.id };
    // This app answered, declined or called in that chat: the contact's offer is not one to ring for any more.
    if (request.method === "setCallSignal") this.offers.delete((request.params as { linkId?: string } | undefined)?.linkId ?? "");
    try {
      await this.ready;
      const method = this.node[request.method] as (params: unknown) => unknown;
      if (typeof method !== "function") throw new Error(`Unknown method: ${request.method}`);
      response.result = await method.call(this.node, request.params);
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
    }
    try {
      client.post(response);
    } catch {
      // the client went away
    }
  }

  /**
   * Sends what one chat or group needs sent after what is still being sent for it, or at once when nothing is: its
   * events reach each client in the order they happened. The step's failure is the caller's; the next step runs anyway.
   */
  private inOrder(linkId: string, step: () => void | Promise<void>): Promise<void> {
    const before = this.sending.get(linkId);
    if (before) return this.track(linkId, before.then(step));
    try {
      const result = step();
      return result instanceof Promise ? this.track(linkId, result) : Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private track(linkId: string, running: Promise<void>): Promise<void> {
    const settled = running.catch(() => {});
    this.sending.set(linkId, settled);
    void settled.then(() => { if (this.sending.get(linkId) === settled) this.sending.delete(linkId); });
    return running;
  }

  private sendHistory(linkId: string, messages: StoredMessage[]): void {
    this.broadcast({ kind: "messages", linkId, messages });
    for (const client of this.clients) this.histories.get(client)?.add(linkId);
  }

  private sendChanges(linkId: string, changes: MessageChanges): void | Promise<void> {
    const behind: EngineClientSink[] = [];
    for (const client of this.clients) {
      if (!this.histories.get(client)?.has(linkId)) { behind.push(client); continue; }
      this.post(client, { kind: "message-changes", linkId, ...changes });
    }
    if (!behind.length) return;
    // Its whole history, read now: it holds these changes already, and what changes next follows it.
    return this.node.getMessages(linkId).then((messages) => {
      for (const client of behind) {
        if (!this.clients.has(client)) continue;
        if (this.post(client, { kind: "messages", linkId, messages })) this.histories.get(client)?.add(linkId);
      }
    });
  }

  private post(client: EngineClientSink, event: EngineEvent): boolean {
    try {
      client.post(event);
      return true;
    } catch {
      this.clients.delete(client);
      return false;
    }
  }

  private broadcast(event: EngineEvent): void {
    for (const client of [...this.clients]) this.post(client, event);
  }
}

/** A call signal's kind (`o` for an offer), read as the client reads it; checked in full before it is replayed. */
function signalKind(signal: string): unknown {
  try {
    return (JSON.parse(signal) as { t?: unknown } | null)?.t;
  } catch {
    return undefined;
  }
}
