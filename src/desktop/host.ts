import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DHT_POLL_INTERVALS,
  GhostlyHttpError,
  fromBase64,
  toBase64,
  type Identity,
  type GhostRecord,
  type LocalFetch,
  type PkarrTransport,
  type SignedPacket,
} from "@ghostly/core";
import type { EngineServer } from "@ghostly/browser/engine/server";
import { createInPageHost } from "@ghostly/browser/inPageHost";
import { createIrohEndpoint, createHyperEndpoint } from "./nativeTransports";
import { desktopUpdates } from "./updates";
import { desktopOidc } from "./oidc";
import { engine } from "@ghostly/browser/platform/engine";

/**
 * Ghostly Desktop runs the same peer as the browser clients, in its WebView,
 * with Rust doing what a WebView cannot: talk to the Mainline DHT, reach web
 * apps on this machine, and give a contact's web app a window of its own.
 */

/** Pkarr through the Rust client: the DHT directly, plus its default relays. */
const tauriTransport: PkarrTransport = {
  async publish(identity: Identity, records: GhostRecord[]) {
    await invoke("publish_records", { seedB64: identity.seedB64, records });
  },
  async resolve(pubKeyZ32: string): Promise<SignedPacket | null> {
    const packet = await invoke<{ timestamp_micros: string; records: GhostRecord[] } | null>("resolve_records", {
      publicKeyZ32: pubKeyZ32,
    });
    // Rust verified the signature while resolving.
    return packet && { pubKeyZ32, timestampMicros: BigInt(packet.timestamp_micros), records: packet.records };
  },
  describe: () => ({ protocol: "Mainline DHT (BEP44) — Direct UDP", relays: [] }),
};

/**
 * The WebView may not talk to localhost (CSP, CORS); Rust may, and only to
 * loopback, without following redirects. The Rust request cannot be aborted, so
 * this settles only when it does: the host counts it toward the peer's limit
 * until then.
 */
const tauriLocalFetch: LocalFetch = async (request) => {
  request.signal.throwIfAborted();
  const response = await invoke<{ status: number; headers: [string, string][]; body_b64: string }>("local_fetch", {
    url: request.url,
    method: request.method,
    headers: request.headers,
    bodyB64: request.body ? toBase64(request.body) : null,
  });
  const body = fromBase64(response.body_b64);
  return {
    status: response.status,
    headers: response.headers,
    body: body.length > 0 ? [body] : null,
  };
};

interface ServiceRequest {
  id: number;
  peer: string;
  service: string;
  method: string;
  path: string;
  headers: [string, string][];
  body_b64: string | null;
}

const VIEWER_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Requests from a service window arrive here and leave over the contact's data link. */
function serveServiceWindows(server: EngineServer): void {
  void listen<ServiceRequest>("ghostly-svc-request", async ({ payload }) => {
    let response: { status: number; headers: [string, string][]; body_b64: string };
    try {
      await server.ready;
      const answer = await server.node.request(payload.peer, payload.service, {
        method: payload.method,
        path: payload.path,
        headers: payload.headers,
        body: payload.body_b64 ? fromBase64(payload.body_b64) : null,
        maxResponseBytes: VIEWER_MAX_RESPONSE_BYTES,
      });
      response = { status: answer.status, headers: answer.headers, body_b64: toBase64(await answer.bytes()) };
    } catch (error) {
      const gone = error instanceof GhostlyHttpError && ["unreachable", "timeout", "closed", "offline"].includes(error.code);
      const text = gone
        ? "This service is not reachable. Services exist while their ghost is online."
        : `The request failed: ${error instanceof Error ? error.message : String(error)}`;
      response = {
        status: gone ? 503 : 502,
        headers: [["content-type", "text/plain; charset=utf-8"]],
        body_b64: toBase64(new TextEncoder().encode(text)),
      };
    }
    await invoke("service_respond", { id: payload.id, response });
  });
}

export function createDesktopHost(version: string) {
  return createInPageHost({
    version,
    features: { shareLocalServices: true, openServices: true, profiles: true },
    updates: desktopUpdates,
    node: { nativeTransports: { "iroh/1": createIrohEndpoint, "hyperdht/1": createHyperEndpoint }, transport: tauriTransport, pollIntervals: DHT_POLL_INTERVALS, localFetch: tauriLocalFetch, platform: "desktop", invoke },
    onServer: serveServiceWindows,
    oidc: desktopOidc,
    // A WebView cannot hand a lightning: or bitcoin: link to the system; Rust does, for those two schemes only.
    openPaymentLink: (uri) => invoke("open_payment_link", { url: uri }),
    // There is nothing to ask: the user typed the address, and Rust only ever reaches loopback.
    requestLocalAccess: async () => true,
    async openService(peerPubKeyZ32, serviceId) {
      const service = engine.linkByPeer(peerPubKeyZ32)?.peerServices?.find((s) => s.id === serviceId);
      await invoke("open_service_window", { peer: peerPubKeyZ32, service: serviceId, title: service?.name ?? serviceId });
    },
  });
}
