import type { EngineServer, EngineClientSink } from "./engine/server";
import { createPeerServer } from "./devices/peer";
import type { PeerServer } from "./devices/linkOnly";
import type { NodeOptions } from "./engine/node";
import type { BrowserHost } from "./host";

/**
 * A host that runs the peer in the page itself: the web app and the desktop
 * app. (The extension keeps it in an offscreen document instead, so it outlives
 * its pages.)
 */
export interface InPageHostOptions
  extends Pick<BrowserHost, "version" | "notice" | "updates" | "appRunner" | "appNetRunner" | "features" | "requestLocalAccess" | "forgetLocalAccess" | "openService" | "oidc" | "atproto" | "openPaymentLink" | "fullscreenWindow" | "shareText" | "readClipboardText" | "readClipboardFiles" | "openPubkyPassport" | "pubkyCookieSession" | "callMedia" | "keepAwake"> {
  node?: NodeOptions;
  /** Called once the peer exists, e.g. to let something outside the page reach it. Never on a standby: no engine runs there. */
  onServer?: (server: EngineServer) => void;
}

export function createInPageHost(options: InPageHostOptions): BrowserHost & { announceDeparture(): void } {
  // The device state is read first (WISP 06 § The gate): the engine, or device-link-only mode on a standby.
  let server: Promise<PeerServer> | null = null;
  let running: PeerServer | null = null;
  return {
    version: options.version,
    notice: options.notice,
    updates: options.updates,
    appRunner: options.appRunner,
    appNetRunner: options.appNetRunner,
    features: options.features,
    requestLocalAccess: options.requestLocalAccess,
    forgetLocalAccess: options.forgetLocalAccess,
    openService: options.openService,
    oidc: options.oidc,
    atproto: options.atproto,
    openPaymentLink: options.openPaymentLink,
    fullscreenWindow: options.fullscreenWindow,
    shareText: options.shareText,
    readClipboardText: options.readClipboardText,
    keepAwake: options.keepAwake,
    readClipboardFiles: options.readClipboardFiles,
    openPubkyPassport: options.openPubkyPassport,
    pubkyCookieSession: options.pubkyCookieSession,
    callMedia: options.callMedia,

    async connect(onMessage) {
      server ??= createPeerServer(options.node).then((peer) => {
        running = peer;
        if (!peer.gated) options.onServer?.(peer as EngineServer);
        return peer;
      });
      const active = await server;
      const client: EngineClientSink = { post: (message) => queueMicrotask(() => onMessage(message)) };
      active.attach(client);
      return { send: (request) => void active.handle(client, request) };
    },

    /** Say goodbye to every peer when the page closes, if there is time. */
    announceDeparture() {
      void running?.stop().catch(() => {});
    },
  };
}

/**
 * One peer per storage area. Two pages would publish under the same keys and
 * spend from the same wallet at once, so only the page holding this lock runs.
 * Resolves once the lock is ours; it is released when the page closes.
 *
 * Rejects with `PeerLockUnavailable` when the lock cannot be had at all: the browser has no Web Locks, or refuses
 * the request (it throws, or its promise rejects before the lock was granted). That is not "open in another tab",
 * so `onWaiting` is not called for it; the caller says the browser cannot run the app.
 */
export function becomeThePeer(lockName: string, onWaiting: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let acquired = false;
    let refused = false;
    const refuse = (cause: unknown) => {
      if (acquired || refused) return;
      refused = true;
      reject(new PeerLockUnavailable(cause));
    };
    try {
      const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
      if (!locks || typeof locks.request !== "function") { refuse(new Error("navigator.locks is not available")); return; }
      Promise.resolve(locks.request(lockName, () => {
        acquired = true;
        resolve();
        return new Promise<never>(() => {});
      })).catch(refuse);
    } catch (error) {
      refuse(error);
      return;
    }
    setTimeout(() => {
      if (!acquired && !refused) onWaiting();
    }, 150);
  });
}

/** The single-peer lock cannot be had in this browser (see `becomeThePeer`). */
export class PeerLockUnavailable extends Error {
  constructor(cause: unknown) {
    super(`The single-peer lock is not available: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PeerLockUnavailable";
  }
}
