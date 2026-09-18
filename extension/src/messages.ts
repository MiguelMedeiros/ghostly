/** Messages between the extension's own contexts: pages, service worker and the offscreen peer. */
export const UI_PORT = "ui";
/** One-shot messages, addressed by `target` because every context hears them. */
export type RuntimeMessage =
  | { target: "background"; type: "ensure-engine" }
  | { target: "background"; type: "open-service"; peerPubKeyZ32: string; serviceId: string }
  | { target: "engine"; type: "ping" }
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
