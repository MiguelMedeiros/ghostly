import { GhostlyHttpError, fromBase64, parseLocalTarget, toBase64 } from "@ghostly/core";
import { localAccessPattern } from "@ghostly/browser/host";
import type { EngineServer, EngineClientSink } from "@ghostly/browser/engine/server";
import { copyingSink } from "@ghostly/browser/engine/copyingSink";
import { createPeerServer } from "@ghostly/browser/devices/peer";
import type { PeerServer } from "@ghostly/browser/devices/linkOnly";
import type { ClientMessage } from "@ghostly/browser/shared/rpc";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { defaultWalletsAllowed } from "@ghostly/browser/platform/walletSetupSwitch";
import { UI_PORT, type EngineStatus, type HttpRequestReply, type RuntimeMessage } from "./messages";
import { activeNamespace, databaseFor, peerLockFor } from "./profile";
import { activeProfileId } from "../../ui/src/lib/profiles";
import { fromOwnPage } from "./shared/sender";
import { setStorageProfile } from "../../ui/src/lib/storage";
import { allowedLocalFetch } from "./localAllowList";

/**
 * The offscreen document is the Ghostly peer. Service workers have no
 * RTCPeerConnection and are shut down when idle; this page has WebRTC and
 * lives for as long as the browser runs the extension.
 */
const VIEWER_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** How long a peer being replaced gets to say goodbye to its contacts before its document closes. */
const STOP_GRACE_MS = 3_000;
/**
 * How long a peer being replaced in the middle of "Clear all data" gets to end it (take back what it can, stop, empty
 * its database: `CLEAR_WITHDRAW_MS` and a little more), as long as the page gives it (clearData.ts `CLEAR_ENGINE_MS`).
 */
const CLEAR_GRACE_MS = 15_000;
/**
 * Each chat's newest rows a page gets when it connects (`EngineServer.attach`'s `newest`), not its whole history: this
 * port carries JSON, and every chat's whole history went across to each tab opened or reloaded (about 20 MiB for 50
 * chats of 2,000 messages). Twice what a page keeps of a chat (`STORED_MESSAGES`, 200): a chat that got fewer than 200
 * while no tab showed it needs nothing more. A page asks for the rest of a chat it shows whole.
 */
const ATTACH_NEWEST = 400;

/**
 * The local profile this document runs as, read once: a switch closes the document and starts another
 * (background.ts), so one peer never sees two profiles' data. The first profile keeps the original names.
 */
const profile = activeNamespace();
setDatabaseName(databaseFor(profile));
// Its settings' names, read for the language a viewer tab is told things in (viewerWords.ts).
setStorageProfile(profile);

/**
 * The peer starts once it holds its profile's lock, released only when this document goes away: were a
 * replaced document still closing, the new one waits for it rather than run beside it on the same data.
 */
let running: PeerServer | null = null;
/** When the peer's start failed for good (its database did not open: the device is full, or another window held it). */
let failedAt: number | null = null;
/**
 * How long a peer whose start failed is kept before the worker may replace it. The pages on it connect again as its
 * document closes, each asking for the peer: were they to replace the one just made, the documents would follow one
 * another for as long as the device stays full. A page's Try again, the toolbar button or the minute check, later, do.
 */
const FAILED_KEPT_MS = 5_000;
const server = new Promise<PeerServer>((resolve, reject) => {
  void navigator.locks.request(peerLockFor(profile), () => {
    // The device state is read first (WISP 06 § The gate), at browser start with no page open too: a device that is
    // not the active one gets device-link-only mode, which opens no peer database and starts no wallet.
    // Iroh through a relay (WISP 102), over WebSockets from this document; the wasm loads on first use.
    // A new profile gets its default Mainnet wallets; never in a test build or an automated browser.
    // No mini-app runner here yet (WISP 1200 § Per client: Extension, and the TODO below): the engine offers no apps/1
    // and refuses the app calls, whatever the build's APPS_ENABLED says.
    // A contact reaches only the local addresses this profile's person allowed in this browser, as the worker reads them
    // (localAllowList.ts: this document has no `chrome.storage` nor `chrome.permissions`).
    void createPeerServer({ platform: "extension", irohWeb: true, apps: false, defaultWallets: defaultWalletsAllowed(() => import.meta.env.MODE === "e2e"), localFetch: allowedLocalFetch(profile) }).then((peer) => {
      running = peer;
      // A message that came with no tab open: the peer tells the person, as a tab would have (attentionNotices.ts).
      const engine = engineOf(peer);
      if (engine) engine.unheardAttention = (event) => void import("./attentionNotices").then(({ noticeUnheard }) => noticeUnheard(event, () => engine.node.getState().links)).catch(() => {});
      // Only in `vite build --mode e2e` (test/attacks.mjs plays a malicious peer through it); gone from real builds.
      if (import.meta.env.MODE === "e2e") Object.assign(globalThis, { __ghostly: running });
      // Heard before any `ping` waits on it, so a ping that comes once it failed knows.
      peer.ready.catch(() => { failedAt ??= Date.now(); });
      resolve(peer);
    }, (error: unknown) => {
      failedAt ??= Date.now();
      reject(error);
    });
    return new Promise<never>(() => {});
  });
});
// Nothing may be left to report a start that failed as unhandled: each caller below hears of it.
server.catch(() => {});

// Only the extension's own pages and its worker are heard, on a port or in a message (`fromOwnPage`).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== UI_PORT) return;
  if (!fromOwnPage(port.sender)) {
    port.disconnect();
    return;
  }
  // TODO(apps, WISP 1200 § Per client, Extension): this port carries JSON, so the app calls that answer bytes (`appFile`,
  // `appPreview`'s `icon`) need another shape before the extension runs apps. The extension is out of phase 1.
  // Each message is copied on its way: a state carries the payments and the wallet only when they changed.
  const client: EngineClientSink = copyingSink((message) => port.postMessage(message));
  // Listeners go on at once, so nothing a page sends while the peer waits for its lock is lost.
  withPeer((s) => {
    const engine = engineOf(s);
    if (engine) engine.attach(client, undefined, { newest: ATTACH_NEWEST });
    else s.attach(client);
  });
  port.onDisconnect.addListener(() => withPeer((s) => s.detach(client)));
  port.onMessage.addListener((request: ClientMessage) => withPeer((s) => {
    // A chat's whole history the page asked for; a device that is not the active one has none.
    if (request?.kind === "history") void engineOf(s)?.history(client, request.linkId);
    else {
      const handled = s.handle(client, request);
      // "Clear all data" stops the peer for good (`clearProfileData`): once it is over, the worker replaces this document
      // at the next start it is asked for, should the page go away before it asks for a new peer (`restart-engine`).
      if (request?.kind === "request" && request.method === "clearProfileData") {
        void handled.finally(() => { cleared = true; });
        clearing = handled.catch(() => {});
      }
    }
  }));
});

/** The engine, or null on a device that is not the active one for this profile: nothing there serves a contact's app. */
const engineOf = (peer: PeerServer): EngineServer | null => (peer.gated ? null : (peer as EngineServer));

/** Straight to the running peer; in order, once it starts, before that. */
function withPeer(act: (peer: PeerServer) => void): void {
  if (running) act(running);
  else void server.then(act, () => {});
}

async function handleHttpRequest(message: Extract<RuntimeMessage, { type: "http-request" }>): Promise<HttpRequestReply> {
  try {
    const peer = engineOf(await server);
    if (!peer) return { ok: false, code: "offline", message: "This profile is not active on this device" };
    await peer.ready;
    const response = await peer.node.request(message.peerPubKeyZ32, message.serviceId, {
      method: message.method,
      path: message.path,
      headers: message.headers,
      body: message.bodyB64 ? fromBase64(message.bodyB64) : null,
      maxResponseBytes: VIEWER_MAX_RESPONSE_BYTES,
    });
    const body = await response.bytes();
    // The contact's machine answered in place of their app (docs/PROTOCOL.md "Host errors"), in its English and from
    // its side ("The local service is not reachable."): the tab says it in the profile's language, from this side.
    const hostCode = response.headers.find(([name]) => name.toLowerCase() === "x-ghostly-error")?.[1];
    if (hostCode !== undefined) {
      const app = serviceName(peer, message.peerPubKeyZ32, message.serviceId) ?? message.app ?? message.serviceId;
      const shown = await (await import("./viewerWords")).hostErrorShown(response.headers, app);
      return { ok: false, code: hostCode, message: hostCode, status: response.status, shown };
    }
    return { ok: true, status: response.status, headers: response.headers, bodyB64: toBase64(body) };
  } catch (error) {
    const code = error instanceof GhostlyHttpError ? error.code : "error";
    return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The name the contact gave the service they share, as the chat shows it now. None once they took it back: the tab
 * then names it as it was when it opened.
 */
function serviceName(peer: EngineServer, peerPubKeyZ32: string, serviceId: string): string | undefined {
  try {
    const links = peer.node.getState().links.filter((link) => link.peerPubKeyZ32 === peerPubKeyZ32);
    return links.flatMap((link) => link.peerServices ?? []).find((service) => service.id === serviceId)?.name;
  } catch {
    return undefined;
  }
}

/**
 * Chrome no longer lets the extension reach `patterns` (`http://127.0.0.1/*`): every app this profile shares at one of
 * those hosts, on any port, is turned off ("Share" off, `setServiceEnabled`), so contacts no longer see it and are
 * answered as for any app not shared. Turning it on again is the person's to do.
 */
async function turnOffAppsAt(patterns: string[]): Promise<void> {
  const peer = engineOf(await server);
  if (!peer) return;
  await peer.ready;
  const gone = new Set(patterns);
  for (const service of peer.node.getState().services) {
    if (!service.enabled) continue;
    let pattern: string;
    try { pattern = localAccessPattern(parseLocalTarget(service.target).origin); } catch { continue; }
    if (gone.has(pattern)) peer.node.setServiceEnabled({ serviceId: service.id, enabled: false });
  }
}

let stopping: Promise<void> | null = null;
/** A page's "Clear all data" stopped the peer: it does not run again in this document. */
let cleared = false;
/** A page's "Clear all data" in progress in the peer: it ends with the peer stopped. */
let clearing: Promise<void> | null = null;
/**
 * Stops the peer, once: before the worker closes this document for a switch, or as the page goes away. One "Clear all
 * data" stopped is not stopped again: nothing it held is written over the emptied database. One clearing stops once
 * its clear is over: a switch in another tab no longer leaves its database half emptied.
 */
const stopPeer = () => (stopping ??= cleared ? Promise.resolve() : clearing ?? (running ? running.stop() : server.then((s) => s.stop())).catch(() => {}));

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message?.target !== "engine" || !fromOwnPage(sender)) return false;
  if (message.type === "ping") {
    // Which profile runs, and which one the registry names now: they differ once a page switched.
    // Answered too when the peer did not start (its database did not open): the pages connect and are told why
    // (`start-failed`). Before, no answer came and the page got "The Ghostly peer did not start" after five seconds.
    // A peer that stopped for good says so, and the worker starts another in its place: one whose start failed too, so
    // the person who freed some space and pressed Try again gets a new start, not this one again until Chrome restarts.
    void server.then((s) => s.ready.catch(() => {}), () => {}).then(() => {
      const failed = failedAt !== null && Date.now() - failedAt >= FAILED_KEPT_MS;
      sendResponse({ profile, active: activeNamespace(), activeId: activeProfileId(), stopped: cleared || stopping !== null || failed } satisfies EngineStatus);
    });
    return true;
  }
  if (message.type === "stop") {
    // Its contacts see it leave, if that takes a moment; a peer that hangs does not hold up the switch.
    const grace = clearing && !cleared ? CLEAR_GRACE_MS : STOP_GRACE_MS;
    void Promise.race([stopPeer(), new Promise((resolve) => setTimeout(resolve, grace))]).then(() => sendResponse(true));
    return true;
  }
  if (message.type === "http-request") {
    void handleHttpRequest(message).then(sendResponse);
    return true;
  }
  if (message.type === "local-access-removed") {
    const origins = Array.isArray(message.origins) ? message.origins.filter((o): o is string => typeof o === "string") : [];
    void turnOffAppsAt(origins).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  return false;
});

// Closing the browser tears this page down; say goodbye if there is time.
addEventListener("pagehide", () => void stopPeer());
