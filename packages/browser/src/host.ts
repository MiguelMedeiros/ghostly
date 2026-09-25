import type { FoundUpdate } from "../../../src/lib/updates";
import type { EngineEvent, RpcRequest, RpcResponse } from "./shared/rpc";
import type { OidcPlatform } from "./proofs/oidc/providers";
import type { OidcWindow } from "./proofs/oidc/flow";
import type { AtprotoHost } from "./proofs/atproto/oauth";

/**
 * What differs between the places this peer runs. The extension keeps the
 * peer in an offscreen document and reaches it through extension messaging;
 * the web app runs it in the page. Everything else is shared.
 */
export interface EngineConnection {
  send(request: RpcRequest): void;
}

/**
 * How a client finds a new version of itself and puts it in place. The web
 * app reloads the tab; an extension from the store reloads itself; an unpacked
 * extension can only point at the download. A host that leaves this out has no
 * updater, and the UI never mentions one.
 */
export interface UpdateSource {
  /** Where someone installing by hand should go. */
  downloadUrl: string;
  /** The newest published version, or null when this client already runs it. */
  check(): Promise<FoundUpdate | null>;
  /** Never called for `apply: "manual"`. `onProgress` is used where the platform reports it. */
  install(update: FoundUpdate, onProgress?: (fraction: number) => void): Promise<void>;
}

export interface BrowserHost {
  version: string;
  /** Something the user should know about this client, shown in the sidebar. */
  notice?: string;
  /** Left out where this client has no way to learn about new versions. */
  updates?: UpdateSource;
  features: {
    /** Can this host reach web apps on the user's machine? A web page only can if they allow it with CORS. */
    shareLocalServices: boolean;
    /** Can this host show a contact's web app on an origin of its own? */
    openServices: boolean;
    /** Can this host restart as another local profile (WISP 04)? The page's own peer, or the extension's offscreen one. */
    profiles?: boolean;
  };
  /** Reaches the peer. `onDisconnect` fires when it goes away; the client then connects again. */
  connect(onMessage: (message: EngineEvent | RpcResponse) => void, onDisconnect: () => void): Promise<EngineConnection>;
  /** Asks the user for access to a local origin, where the platform has such a thing. */
  requestLocalAccess(originPattern: string): Promise<boolean>;
  openService(peerPubKeyZ32: string, serviceId: string): Promise<void>;
  /**
   * Opens a `lightning:` or `bitcoin:` link in a wallet on this device. Left out where a plain link
   * already does it (a web page); the desktop app and the extension have to hand it to the system.
   */
  openPaymentLink?(uri: string): Promise<void>;
  /**
   * Hands a link to the system's share sheet, pointing at `anchor` (the button, in CSS pixels).
   * Resolves to false where the platform has no sheet to show; left out where the page's own Web
   * Share API is the way (a web page).
   */
  shareText?(text: string, anchor?: ShareAnchor): Promise<boolean>;
  /**
   * The clipboard's text, read by the platform itself, for a paste button the user just clicked.
   * Left out where the page's `navigator.clipboard.readText()` is the way (a web page, the
   * extension); the desktop app reads natively because WKWebView asks for a second click.
   */
  readClipboardText?(): Promise<string>;
  /** Signing in with an OpenID Connect provider for an identity proof. Left out where the platform cannot. */
  oidc?: OidcHost;
  /** Signing in to the person's AT Protocol server (Bluesky or another PDS) for an identity proof. Left out where the platform cannot. */
  atproto?: AtprotoHost;
  /**
   * Opens Pubky Passport's authorize page (`https://passport.pubky.app/authorize#d=…`, the request in its fragment)
   * outside the app. The desktop app hands it to the system browser; left out where the page opens a popup itself.
   */
  openPubkyPassport?(url: string): Promise<void>;
}

/** Where a share sheet points: the button that opened it, in CSS pixels from the page's top left. */
export interface ShareAnchor { x: number; y: number; width: number; height: number }

export interface OidcHost {
  platform: OidcPlatform;
  /**
   * Call it straight from the click: the web app opens its popup and the
   * extension asks for the `identity` permission before anything is awaited,
   * or the browser blocks them.
   */
  open(): Promise<OidcWindow>;
}

let current: BrowserHost | null = null;

/** Must be called before anything in `platform/` is used. */
export function setBrowserHost(host: BrowserHost): void {
  current = host;
}

export function getBrowserHost(): BrowserHost {
  if (!current) throw new Error("No browser host configured");
  return current;
}
