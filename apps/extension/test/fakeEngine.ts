import type { EngineClientSink } from "@ghostly/browser/engine/server";
import type { RpcRequest } from "@ghostly/browser/shared/rpc";
import { databaseName } from "@ghostly/browser/shared/idb";

/**
 * Stands in for `@ghostly/browser/engine/server` in the offscreen document: the
 * peer itself is tested in packages/browser; here only what the extension does
 * with it matters. The control object lives on `globalThis` so the test and a
 * module re-imported after `vi.resetModules()` share it.
 */

export interface EngineResponse {
  status: number;
  headers: [string, string][];
  bytes(): Promise<Uint8Array>;
}

export interface EngineRequestInit {
  method: string;
  path: string;
  headers: [string, string][];
  body: Uint8Array | null;
  maxResponseBytes: number;
}

export interface FakeEngineControl {
  servers: FakeEngineServer[];
  /** Peers starting and stopping, in order: `start <database>`, `stop <database>`. */
  log: string[];
  ready: Promise<void>;
  respond: (peer: string, service: string, init: EngineRequestInit) => Promise<EngineResponse>;
}

export function engineControl(): FakeEngineControl {
  const holder = globalThis as { __fakeEngine?: FakeEngineControl };
  holder.__fakeEngine ??= { servers: [], log: [], ready: Promise.resolve(), respond: async () => okResponse("") };
  return holder.__fakeEngine;
}

export function resetEngine(): FakeEngineControl {
  delete (globalThis as { __fakeEngine?: FakeEngineControl }).__fakeEngine;
  return engineControl();
}

export function okResponse(body: string, status = 200, headers: [string, string][] = []): EngineResponse {
  return { status, headers, bytes: async () => new TextEncoder().encode(body) };
}

export class FakeEngineServer {
  readonly attached: EngineClientSink[] = [];
  readonly detached: EngineClientSink[] = [];
  readonly handled: { client: EngineClientSink; request: RpcRequest }[] = [];
  readonly requests: { peer: string; service: string; init: EngineRequestInit }[] = [];
  shutdowns = 0;
  readonly ready: Promise<void>;
  /** The peer database the document had chosen when it started this peer (mock `shared/idb` to read it). */
  readonly database = databaseName();
  readonly node = {
    request: (peer: string, service: string, init: EngineRequestInit) => {
      this.requests.push({ peer, service, init });
      return engineControl().respond(peer, service, init);
    },
    shutdown: async () => {
      this.shutdowns++;
      engineControl().log.push(`stop ${this.database}`);
    },
  };

  constructor(readonly options: unknown) {
    this.ready = engineControl().ready;
    engineControl().servers.push(this);
    engineControl().log.push(`start ${this.database}`);
  }

  attach(client: EngineClientSink): void {
    this.attached.push(client);
  }

  detach(client: EngineClientSink): void {
    this.detached.push(client);
  }

  async handle(client: EngineClientSink, request: RpcRequest): Promise<void> {
    this.handled.push({ client, request });
  }
}

export const engineServerModule = { EngineServer: FakeEngineServer };
