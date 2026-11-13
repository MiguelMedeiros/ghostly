import type { AttachMark } from "@ghostly/browser/shared/rpc";

/** Messages between the extension's own contexts: pages, service worker and the offscreen peer. */
export const UI_PORT = "ui";

/**
 * A page's port, named with the mark the extension's pages last mirrored (`AttachMark`): the peer attaches the page as its
 * port opens, and sends no chat unchanged since.
 */
export function uiPortName(since?: AttachMark): string {
  return since ? `${UI_PORT} ${since.epoch} ${since.mark}` : UI_PORT;
}

/** A page's port by its name (`uiPortName`): with the mark it carries, if any. Null for any other port. */
export function uiPortMark(name: string): { since?: AttachMark } | null {
  if (name === UI_PORT) return {};
  const [port, epoch, mark, ...rest] = name.split(" ");
  if (port !== UI_PORT || !epoch || rest.length || !/^\d+$/.test(mark ?? "")) return null;
  return { since: { epoch, mark: Number(mark) } };
}
/** One-shot messages, addressed by `target` because every context hears them. */
export type RuntimeMessage =
  | { target: "background"; type: "ensure-engine" }
  /** The peer stopped for good ("Clear all data"): its document closes and a new one starts. */
  | { target: "background"; type: "restart-engine" }
  /**
   * `relayOnly`: Hide my IP from contacts is on, and no tab opens (background.ts `RELAY_ONLY_REFUSED`). `profile`: the
   * page's profile (`EngineStatus.profile`); the tab opens only while the peer runs that one.
   */
  | { target: "background"; type: "open-service"; peerPubKeyZ32: string; serviceId: string; tag: string; profile: string; page?: ViewerPage; relayOnly?: boolean }
  /** The profile locked: every tab showing a contact's app closes (`closeServiceWindows`). */
  | { target: "background"; type: "close-services" }
  /** A `lightning:` or `bitcoin:` link, for a wallet on this device: the app page cannot open one itself. */
  | { target: "background"; type: "open-payment-link"; uri: string }
  /** The offscreen peer asks whether profile `profile` may reach `origin` for a contact (localAllowList.ts): a boolean. */
  | { target: "background"; type: "local-access-allowed"; profile: string; origin: string }
  /**
   * The peer heard a message while no tab was open: the worker shows a notification with `body`, which opens `chat`
   * when clicked (apps/extension/src/attentionNotices.ts).
   */
  | { target: "background"; type: "notify"; body: string; chat?: string }
  /**
   * A notification was clicked: the app page that showed it opens its chat and answers `true`; no answer, and the
   * worker shows the app itself (apps/ui/src/lib/notifications.ts).
   */
  | { target: "app"; type: "notification-open"; id: string }
  /** Answered with an `EngineStatus` once the peer is up. */
  | { target: "engine"; type: "ping" }
  /** The worker is about to close the peer's document, to start it again as another profile. */
  | { target: "engine"; type: "stop" }
  /** Chrome took back these host patterns (`permissions.onRemoved`): the apps at those hosts stop being shared. */
  | { target: "engine"; type: "local-access-removed"; origins: string[] }
  | {
      target: "engine";
      type: "http-request";
      peerPubKeyZ32: string;
      serviceId: string;
      method: string;
      path: string;
      headers: [string, string][];
      bodyB64: string | null;
      /** The app's name when its tab opened (`ViewerPage.app`), for when the peer's state no longer lists it. */
      app?: string;
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
  /**
   * The app's name as the chat listed it when the tab opened: the peer's state no longer has it once the contact took
   * the app back, which is when the tab says so by name (`services.window.unshared`).
   */
  app?: string;
}

export type HttpRequestReply =
  | { ok: true; status: number; headers: [string, string][]; bodyB64: string }
  /** `status`: the one the contact's machine gave, when it answered in place of its app. */
  | { ok: false; code: string; message: string; status?: number; shown?: ShownError };

/** What a viewer tab shows in place of the app when the contact's machine answered for it: said by the peer in the profile's language (viewerWords.ts). */
export interface ShownError {
  text: string;
  lang: string;
  dir: "ltr" | "rtl";
}

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
  /**
   * The peer stopped for good (its document is closing for a switch, or "Clear all data" ran) and its document stays
   * on with no peer: the page that would ask for a new one went away, or the worker did. Or its start failed (the
   * profile's database did not open) a while ago: the next ask tries again. Absent from an older build.
   */
  stopped?: boolean;
}
