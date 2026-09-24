import { GhostlyHttpError, fromBase64, toBase64 } from "@ghostly/core";
import { EngineServer, type EngineClientSink } from "@ghostly/browser/engine/server";
import type { RpcRequest } from "@ghostly/browser/shared/rpc";
import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { UI_PORT, type EngineStatus, type HttpRequestReply, type RuntimeMessage } from "./messages";
import { activeNamespace, databaseFor, peerLockFor } from "./profile";

/**
 * The offscreen document is the Ghostly peer. Service workers have no
 * RTCPeerConnection and are shut down when idle; this page has WebRTC and
 * lives for as long as the browser runs the extension.
 */
const VIEWER_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** How long a peer being replaced gets to say goodbye to its contacts before its document closes. */
const STOP_GRACE_MS = 3_000;

/**
 * The local profile this document runs as, read once: a switch closes the document and starts another
 * (background.ts), so one peer never sees two profiles' data. The first profile keeps the original names.
 */
const profile = activeNamespace();
setDatabaseName(databaseFor(profile));

/**
 * The peer starts once it holds its profile's lock, released only when this document goes away: were a
 * replaced document still closing, the new one waits for it rather than run beside it on the same data.
 */
let running: EngineServer | null = null;
const server = new Promise<EngineServer>((resolve) => {
  void navigator.locks.request(peerLockFor(profile), () => {
    running = new EngineServer({ platform: "extension" });
    // Only in `vite build --mode e2e` (test/attacks.mjs plays a malicious peer through it); gone from real builds.
    if (import.meta.env.MODE === "e2e") Object.assign(globalThis, { __ghostly: running });
    resolve(running);
    return new Promise<never>(() => {});
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== UI_PORT) return;
  const client: EngineClientSink = { post: (message) => port.postMessage(message) };
  // Listeners go on at once, so nothing a page sends while the peer waits for its lock is lost.
  withPeer((s) => s.attach(client));
  port.onDisconnect.addListener(() => withPeer((s) => s.detach(client)));
  port.onMessage.addListener((request: RpcRequest) => withPeer((s) => void s.handle(client, request)));
});

/** Straight to the running peer; in order, once it starts, before that. */
function withPeer(act: (peer: EngineServer) => void): void {
  if (running) act(running);
  else void server.then(act);
}

async function handleHttpRequest(message: Extract<RuntimeMessage, { type: "http-request" }>): Promise<HttpRequestReply> {
  try {
    const peer = await server;
    await peer.ready;
    const response = await peer.node.request(message.peerPubKeyZ32, message.serviceId, {
      method: message.method,
      path: message.path,
      headers: message.headers,
      body: message.bodyB64 ? fromBase64(message.bodyB64) : null,
      maxResponseBytes: VIEWER_MAX_RESPONSE_BYTES,
    });
    return { ok: true, status: response.status, headers: response.headers, bodyB64: toBase64(await response.bytes()) };
  } catch (error) {
    const code = error instanceof GhostlyHttpError ? error.code : "error";
    return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
  }
}

let stopping: Promise<void> | null = null;
/** Stops the peer, once: before the worker closes this document for a switch, or as the page goes away. */
const stopPeer = () => (stopping ??= (running ? running.node.shutdown() : server.then((s) => s.node.shutdown())).catch(() => {}));

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message?.target !== "engine") return false;
  if (message.type === "ping") {
    // Which profile runs, and which one the registry names now: they differ once a page switched.
    void server.then((s) => s.ready).then(() => sendResponse({ profile, active: activeNamespace() } satisfies EngineStatus));
    return true;
  }
  if (message.type === "stop") {
    // Its contacts see it leave, if that takes a moment; a peer that hangs does not hold up the switch.
    void Promise.race([stopPeer(), new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS))]).then(() => sendResponse(true));
    return true;
  }
  if (message.type === "http-request") {
    void handleHttpRequest(message).then(sendResponse);
    return true;
  }
  return false;
});

// Closing the browser tears this page down; say goodbye if there is time.
addEventListener("pagehide", () => void stopPeer());
