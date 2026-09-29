import type { MessageChanges } from "../shared/messageChanges";
import type { EngineEvent, RpcRequest, RpcResponse } from "../shared/rpc";
import type { StoredMessage } from "../shared/types";
import { GhostlyNode, type NodeOptions } from "./node";

/**
 * The peer plus what it takes to serve UI clients: answer their calls, and
 * tell every one of them what changes. How clients are attached (an extension
 * port, a function call in the same page) is the host's business.
 */
export interface EngineClientSink {
  post(message: EngineEvent | RpcResponse): void;
}

export class EngineServer {
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

  constructor(options: NodeOptions = {}) {
    this.node = new GhostlyNode(
      {
        onAttention: (event) => this.broadcast({kind:"attention", event}),
        onState: (state) => this.broadcast({ kind: "state", state }),
        onMessages: (linkId, messages) => void this.inOrder(linkId, () => this.sendHistory(linkId, messages)).catch(() => {}),
        onMessageChanges: (linkId, changes) => void this.inOrder(linkId, () => this.sendChanges(linkId, changes)).catch(() => {}),
        onCallSignal: (linkId, signal) => this.broadcast({ kind: "call-signal", linkId, signal }),
      },
      options,
    );
    this.ready = this.node.start();
  }

  attach(client: EngineClientSink): void {
    this.clients.add(client);
    this.histories.set(client, new Set());
    void this.ready.then(async () => {
      if (!this.clients.has(client)) return;
      client.post({ kind: "state", state: this.node.getState() });
      for (const link of this.node.getState().links) {
        await this.inOrder(link.id, async () => {
          if (!this.clients.has(client)) return;
          client.post({ kind: "messages", linkId: link.id, messages: await this.node.getMessages(link.id) });
          this.histories.get(client)?.add(link.id);
        });
      }
    }).catch(() => {
      // The client went away mid-snapshot (dropped, as broadcast does), or the peer never started (every call says so).
      this.clients.delete(client);
    });
  }

  detach(client: EngineClientSink): void {
    this.clients.delete(client);
    this.histories.delete(client);
    if (this.clients.size === 0) this.node.setActiveLink({ linkId: null });
  }

  async handle(client: EngineClientSink, request: RpcRequest): Promise<void> {
    if (request?.kind !== "request") return;
    const response: RpcResponse = { kind: "response", id: request.id };
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
