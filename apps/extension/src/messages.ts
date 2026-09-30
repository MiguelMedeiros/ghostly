/** Messages between the extension's own contexts: pages, service worker and the offscreen peer. */
export const UI_PORT = "ui";
/** One-shot messages, addressed by `target` because every context hears them. */
export type RuntimeMessage =
  | { target: "background"; type: "ensure-engine" }
  | { target: "background"; type: "open-service"; peerPubKeyZ32: string; serviceId: string }
  /** A `lightning:` or `bitcoin:` link, for a wallet on this device: the app page cannot open one itself. */
  | { target: "background"; type: "open-payment-link"; uri: string }
  /** Answered with an `EngineStatus` once the peer is up. */
  | { target: "engine"; type: "ping" }
  /** The worker is about to close the peer's document, to start it again as another profile. */
  | { target: "engine"; type: "stop" }
  | {
      target: "engine";
      type: "http-request";
      peerPubKeyZ32: string;
      serviceId: string;
      method: string;
      path: string;
      headers: [string, string][];
      bodyB64: string | null;
    };

export type HttpRequestReply =
  | { ok: true; status: number; headers: [string, string][]; bodyB64: string }
  | { ok: false; code: string; message: string };

/** The profile the running peer opened, and the one the profile registry names now (WISP 04). */
export interface EngineStatus {
  profile: string;
  active: string;
}
