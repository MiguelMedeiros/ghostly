import { fromBase64, toBase64, GhostlyHttpError } from "@ghostly/core";
import { GhostlyNode } from "./engine/node";
import { UI_PORT, type EngineEvent, type HttpRequestReply, type RpcRequest, type RpcResponse, type RuntimeMessage } from "./shared/rpc";

/**
 * The offscreen document is the Ghostly peer. Service workers have no
 * RTCPeerConnection and are shut down when idle; this page has WebRTC and
 * lives for as long as the browser runs the extension.
 */
const VIEWER_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const ports = new Set<chrome.runtime.Port>();
const broadcast = (event: EngineEvent) => {
  for (const port of ports) {
    try {
      port.postMessage(event);
    } catch {
      ports.delete(port);
    }
  }
};

const node = new GhostlyNode({
  onState: (state) => broadcast({ kind: "state", state }),
  onMessages: (linkId, messages) => broadcast({ kind: "messages", linkId, messages }),
  onCallSignal: (linkId, signal) => broadcast({ kind: "call-signal", linkId, signal }),
});
const ready = node.start();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== UI_PORT) return;
  ports.add(port);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (ports.size === 0) node.setActiveLink({ linkId: null });
  });

  port.onMessage.addListener(async (request: RpcRequest) => {
    if (request?.kind !== "request") return;
    const response: RpcResponse = { kind: "response", id: request.id };
    try {
      await ready;
      const method = node[request.method] as (params: unknown) => unknown;
      if (typeof method !== "function") throw new Error(`Unknown method: ${request.method}`);
      response.result = await method.call(node, request.params);
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
    }
    try {
      port.postMessage(response);
    } catch {
      // UI went away
    }
  });

  void ready.then(async () => {
    port.postMessage({ kind: "state", state: node.getState() } satisfies EngineEvent);
    for (const link of node.getState().links) {
      port.postMessage({ kind: "messages", linkId: link.id, messages: await node.getMessages(link.id) } satisfies EngineEvent);
    }
  });
});

async function handleHttpRequest(message: Extract<RuntimeMessage, { type: "http-request" }>): Promise<HttpRequestReply> {
  try {
    await ready;
    const response = await node.request(message.peerPubKeyZ32, message.serviceId, {
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
    void ready.then(() => sendResponse(true));
    return true;
  }
  if (message.type === "http-request") {
    void handleHttpRequest(message).then(sendResponse);
    return true;
  }
  return false;
});

// Closing the browser tears this page down; say goodbye if there is time.
addEventListener("pagehide", () => void node.shutdown());
