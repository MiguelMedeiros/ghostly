/** Messages between the extension's own contexts: pages, service worker and the offscreen peer. */
export const UI_PORT = "ui";
/** One-shot messages, addressed by `target` because every context hears them. */
export type RuntimeMessage =
  | { target: "background"; type: "ensure-engine" }
  /** The peer stopped for good ("Clear all data"): its document closes and a new one starts. */
  | { target: "background"; type: "restart-engine" }
  | { target: "background"; type: "open-service"; peerPubKeyZ32: string; serviceId: string; tag: string; page?: ViewerPage }
  /** The profile locked: every tab showing a contact's app closes (`closeServiceWindows`). */
  | { target: "background"; type: "close-services" }
  /** A `lightning:` or `bitcoin:` link, for a wallet on this device: the app page cannot open one itself. */
  | { target: "background"; type: "open-payment-link"; uri: string }
  /**
   * A notification was clicked: the app page that showed it opens its chat and answers `true`; no answer, and the
   * worker shows the app itself (apps/ui/src/lib/notifications.ts).
   */
  | { target: "app"; type: "notification-open"; id: string }
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

/**
 * What a viewer tab says when its contact's app cannot answer, in the profile's language. The worker has no settings
 * and no dictionary: the page that opens the service hands it these.
 */
export interface ViewerPage {
  /** `<html lang>`, a BCP 47 tag. */
  lang: string;
  dir: "ltr" | "rtl";
  /** The contact is gone, or no longer shares the app (`services.window.unreachable`). */
  unreachable: string;
  /** Any other failure (`services.window.failed`); the engine's own words go to the console. */
  failed: string;
}

export type HttpRequestReply =
  | { ok: true; status: number; headers: [string, string][]; bodyB64: string }
  | { ok: false; code: string; message: string };

/** The profile the running peer opened, and the one the profile registry names now (WISP 04). */
export interface EngineStatus {
  profile: string;
  active: string;
  /**
   * The id of the profile `active` names (`""` for the first one), as a notice about it names it (`profile:<id>`):
   * a namespace is not an id once a handoff pointed the profile elsewhere, and the worker cannot read the registry.
   * Absent from a document an older build started.
   */
  activeId?: string;
}
