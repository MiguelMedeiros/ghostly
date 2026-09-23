import { EngineServer, type EngineClientSink } from "./engine/server";
import type { NodeOptions } from "./engine/node";
import type { BrowserHost } from "./host";

/**
 * A host that runs the peer in the page itself: the web app and the desktop
 * app. (The extension keeps it in an offscreen document instead, so it outlives
 * its pages.)
 */
export interface InPageHostOptions
  extends Pick<BrowserHost, "version" | "notice" | "updates" | "features" | "requestLocalAccess" | "openService" | "oidc"> {
  node?: NodeOptions;
  /** Called once the peer exists, e.g. to let something outside the page reach it. */
  onServer?: (server: EngineServer) => void;
}

export function createInPageHost(options: InPageHostOptions): BrowserHost & { announceDeparture(): void } {
  let server: EngineServer | null = null;
  return {
    version: options.version,
    notice: options.notice,
    updates: options.updates,
    features: options.features,
    requestLocalAccess: options.requestLocalAccess,
    openService: options.openService,
    oidc: options.oidc,

    async connect(onMessage) {
      if (!server) {
        server = new EngineServer(options.node);
        options.onServer?.(server);
      }
      const active = server;
      const client: EngineClientSink = { post: (message) => queueMicrotask(() => onMessage(message)) };
      active.attach(client);
      return { send: (request) => void active.handle(client, request) };
    },

    /** Say goodbye to every peer when the page closes, if there is time. */
    announceDeparture() {
      void server?.node.shutdown();
    },
  };
}

/**
 * One peer per storage area. Two pages would publish under the same keys and
 * spend from the same wallet at once, so only the page holding this lock runs.
 * Resolves once the lock is ours; it is released when the page closes.
 */
export function becomeThePeer(lockName: string, onWaiting: () => void): Promise<void> {
  return new Promise((resolve) => {
    let acquired = false;
    void navigator.locks.request(lockName, () => {
      acquired = true;
      resolve();
      return new Promise<never>(() => {});
    });
    setTimeout(() => {
      if (!acquired) onWaiting();
    }, 150);
  });
}
