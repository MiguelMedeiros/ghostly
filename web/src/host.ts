import { EngineServer, type EngineClientSink } from "@ghostly/browser/engine/server";
import type { BrowserHost } from "@ghostly/browser/host";

/**
 * Ghostly on the web: the peer runs in this page and lives as long as the tab.
 * Two things a web page cannot do stay with the extension and the desktop app:
 * reaching web apps on the user's machine (no way to be granted access, only
 * CORS), and giving a contact's web app an origin of its own to run on.
 */
let server: EngineServer | null = null;

export const webHost: BrowserHost = {
  version: __APP_VERSION__,
  features: { shareLocalServices: false, openServices: false },

  async connect(onMessage) {
    server ??= new EngineServer();
    const active = server;
    const client: EngineClientSink = { post: (message) => queueMicrotask(() => onMessage(message)) };
    active.attach(client);
    return { send: (request) => void active.handle(client, request) };
  },

  requestLocalAccess: async () => false,
  openService: async () => {
    throw new Error("Opening a contact's web app needs the Ghostly browser extension or desktop app.");
  },
};

/** Say goodbye to every peer when the tab closes, if there is time. */
export function announceDeparture(): void {
  void server?.node.shutdown();
}

/**
 * One peer per browser profile. Two tabs would publish under the same keys and
 * spend from the same wallet at once, so only the tab holding this lock runs.
 * Resolves once the lock is ours; it is released when the tab closes.
 */
export function becomeThePeer(onWaiting: () => void): Promise<void> {
  return new Promise((resolve) => {
    let acquired = false;
    void navigator.locks.request("ghostly-peer", () => {
      acquired = true;
      resolve();
      return new Promise<never>(() => {});
    });
    setTimeout(() => {
      if (!acquired) onWaiting();
    }, 150);
  });
}
