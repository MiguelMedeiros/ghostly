import type { EngineEvent, RpcRequest, RpcResponse } from "./shared/rpc";

/**
 * What differs between the places this peer runs. The extension keeps the
 * peer in an offscreen document and reaches it through extension messaging;
 * the web app runs it in the page. Everything else is shared.
 */
export interface EngineConnection {
  send(request: RpcRequest): void;
}

export interface BrowserHost {
  version: string;
  /** Something the user should know about this client, shown in the sidebar. */
  notice?: string;
  features: {
    /** Can this host reach web apps on the user's machine? A web page only can if they allow it with CORS. */
    shareLocalServices: boolean;
    /** Can this host show a contact's web app on an origin of its own? */
    openServices: boolean;
  };
  /** Reaches the peer. `onDisconnect` fires when it goes away; the client then connects again. */
  connect(onMessage: (message: EngineEvent | RpcResponse) => void, onDisconnect: () => void): Promise<EngineConnection>;
  /** Asks the user for access to a local origin, where the platform has such a thing. */
  requestLocalAccess(originPattern: string): Promise<boolean>;
  openService(peerPubKeyZ32: string, serviceId: string): Promise<void>;
}

let current: BrowserHost | null = null;

/** Must be called before anything in `platform/` is used. */
export function setBrowserHost(host: BrowserHost): void {
  current = host;
}

export function getBrowserHost(): BrowserHost {
  if (!current) throw new Error("No browser host configured");
  return current;
}
