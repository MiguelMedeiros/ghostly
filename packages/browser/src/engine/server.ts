import type { EngineEvent, RpcRequest, RpcResponse } from "../shared/rpc";
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

  constructor(options: NodeOptions = {}) {
    this.node = new GhostlyNode(
      {
        onState: (state) => this.broadcast({ kind: "state", state }),
        onMessages: (linkId, messages) => this.broadcast({ kind: "messages", linkId, messages }),
        onCallSignal: (linkId, signal) => this.broadcast({ kind: "call-signal", linkId, signal }),
      },
      options,
    );
    this.ready = this.node.start();
  }

  attach(client: EngineClientSink): void {
    this.clients.add(client);
    void this.ready.then(async () => {
      if (!this.clients.has(client)) return;
      client.post({ kind: "state", state: this.node.getState() });
      for (const link of this.node.getState().links) {
        client.post({ kind: "messages", linkId: link.id, messages: await this.node.getMessages(link.id) });
      }
    });
  }

  detach(client: EngineClientSink): void {
    this.clients.delete(client);
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

  private broadcast(event: EngineEvent): void {
    for (const client of this.clients) {
      try {
        client.post(event);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
