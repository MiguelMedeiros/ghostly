import { GhostlyHttpError, fromBase64, toBase64 } from "@ghostly/core";
import { EngineServer, type EngineClientSink } from "@ghostly/browser/engine/server";
import type { RpcRequest } from "@ghostly/browser/shared/rpc";
import { UI_PORT, type HttpRequestReply, type RuntimeMessage } from "./messages";

/**
 * The offscreen document is the Ghostly peer. Service workers have no
 * RTCPeerConnection and are shut down when idle; this page has WebRTC and
 * lives for as long as the browser runs the extension.
 */
const VIEWER_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const server = new EngineServer({ platform: "extension" });

// Only in `vite build --mode e2e` (test/attacks.mjs plays a malicious peer through it); gone from real builds.
if (import.meta.env.MODE === "e2e") Object.assign(globalThis, { __ghostly: server });

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== UI_PORT) return;
  const client: EngineClientSink = { post: (message) => port.postMessage(message) };
  server.attach(client);
  port.onDisconnect.addListener(() => server.detach(client));
  port.onMessage.addListener((request: RpcRequest) => void server.handle(client, request));
});

async function handleHttpRequest(message: Extract<RuntimeMessage, { type: "http-request" }>): Promise<HttpRequestReply> {
  try {
    await server.ready;
    const response = await server.node.request(message.peerPubKeyZ32, message.serviceId, {
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

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message?.target !== "engine") return false;
  if (message.type === "ping") {
    void server.ready.then(() => sendResponse(true));
    return true;
  }
  if (message.type === "http-request") {
    void handleHttpRequest(message).then(sendResponse);
    return true;
  }
  return false;
});

// Closing the browser tears this page down; say goodbye if there is time.
addEventListener("pagehide", () => void server.node.shutdown());
