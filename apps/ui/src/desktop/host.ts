import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DHT_POLL_INTERVALS,
  GhostlyHttpError,
  fromBase64,
  fromBase64Url,
  toBase64,
  toBase64Url,
  type Identity,
  type DiscoveryChange,
  type DiscoveryStatus,
  type GhostRecord,
  type LocalFetch,
  type PkarrRequestOptions,
  type PkarrTransport,
  type SignedPacket,
  type TurnConditions,
  type TurnSourceAnswer,
  type TurnSourcePut,
  setLinkTraceSink,
  viewerResponseHeaders,
} from "@ghostly/core";
import type { EngineServer } from "@ghostly/browser/engine/server";
import { createInPageHost } from "@ghostly/browser/inPageHost";
import { defaultWalletsAllowed } from "@ghostly/browser/platform/walletSetupSwitch";
import { getIdentifier } from "@tauri-apps/api/app";
import type { PubkyCookieSession } from "@ghostly/browser/host";
import { createIrohEndpoint, createHyperEndpoint } from "./nativeTransports";
import { desktopUpdates } from "./updates";
import { desktopOidc } from "./oidc";
import { desktopAtproto } from "./atproto";
import { appCommandForKey, isAppCommand, sendAppCommand } from "../lib/appCommands";
import { nativeCallOptions, nativeDevices, type NativeCallSupport } from "./nativeCalls";
import { setDeviceSource } from "../lib/mediaDevices";
import { setAppBadgeTarget } from "../lib/appBadge";
import { setSoundsRelease, type SoundsRelease } from "../lib/sounds";
import { dockBadge } from "./dockBadge";
import { engine } from "@ghostly/browser/platform/engine";
import { fileSpace, registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { NativeFileBytes, type NativeInvoke } from "@ghostly/browser/shared/fileBytesNative";
import { setWindowThemeSink } from "../lib/windowTheme";
import { setNameStepUnderTest } from "../lib/nameStep";
import { appsTestFetch } from "./appsTestFetch";

/**
 * Ghostly Desktop runs the same peer as the browser clients, in its WebView,
 * with Rust doing what a WebView cannot: talk to the Mainline DHT, reach web
 * apps on this machine, and give a contact's web app a window of its own.
 */

/** How often, at most, Rust is asked how Pkarr is doing: after reads and writes, which come in bursts. */
const STATUS_EVERY_MS = 2_000;

/**
 * Pkarr through the Rust client: the Mainline DHT read directly, the relays in Settings written to (browser
 * contacts read only relays), and read from too when "Also use Pkarr relays" is on.
 */
export function createTauriTransport(): PkarrTransport {
  let status: DiscoveryStatus | undefined;
  let askedAt = 0;
  const listeners = new Set<(change?: DiscoveryChange) => void>();
  // What the connection panel shows, asked of Rust now and then; listeners hear of a relay tripping or recovering.
  const refresh = () => {
    if (Date.now() - askedAt < STATUS_EVERY_MS) return;
    askedAt = Date.now();
    void invoke<DiscoveryStatus>("pkarr_status").then((next) => {
      const health = (s?: DiscoveryStatus) => JSON.stringify(s?.relays.map((r) => [r.relay, r.state]) ?? []);
      const changed = health(next) !== health(status);
      // A relay that was failing answers again: links look and publish now rather than at their pace.
      const recovered = !!status && next.relays.some((r) => r.state === "ok" && status!.relays.some((was) => was.relay === r.relay && was.state !== "ok"));
      status = next;
      if (changed) for (const listener of listeners) listener(recovered ? "recovered" : "tripped");
    }).catch(() => {});
  };
  return {
    async publish(identity: Identity, records: GhostRecord[]) {
      try { await invoke("publish_records", { seedB64: identity.seedB64, records }); } finally { refresh(); }
    },
    async publishPayload(pubKeyZ32: string, payload: Uint8Array) {
      await invoke("publish_signed_packet", { publicKeyZ32: pubKeyZ32, payloadB64: toBase64Url(payload) });
    },
    async resolve(pubKeyZ32: string, options?: PkarrRequestOptions): Promise<SignedPacket | null> {
      // A look that can wait goes to the DHT alone and waits for its lookup.
      const packet = await invoke<{ timestamp_micros: string; records: GhostRecord[] } | null>("resolve_records", {
        publicKeyZ32: pubKeyZ32,
        background: !!options?.background,
        urgent: !!options?.urgent,
      }).finally(refresh);
      // Rust verified the signature while resolving.
      return packet && { pubKeyZ32, timestampMicros: BigInt(packet.timestamp_micros), records: packet.records };
    },
    // The turn record's own path (WISP 06 § Publishing and reading), in Rust (`turn_network.rs`): the DHT itself and
    // every relay are read, each put goes out on its source's condition (`cas` on the DHT), and nothing is retried.
    async turnRead(pubKeyZ32: string, options?: { timeoutMs?: number }): Promise<TurnSourceAnswer[]> {
      const answers = await invoke<{ source: string; answered: boolean; payloads: string[]; sequences?: string[]; stale?: boolean; detail?: string }[]>("turn_read", { publicKeyZ32: pubKeyZ32, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
      return answers.map(({ source, answered, payloads, sequences, stale, detail }) =>
        ({ source, answered, payloads: payloads.map(fromBase64Url), ...(sequences?.length ? { sequences } : {}), ...(stale ? { stale: true } : {}), ...(detail ? { detail } : {}) }));
    },
    // The profile has a device set: the turn's own DHT node is made and joins, ahead of the first read.
    turnWarm: () => invoke<void>("turn_warm"),
    turnPut(pubKeyZ32: string, payload: Uint8Array, conditions: TurnConditions): Promise<TurnSourcePut[]> {
      return invoke<TurnSourcePut[]>("turn_put", { publicKeyZ32: pubKeyZ32, payloadB64: toBase64Url(payload), conditions });
    },
    describe: () => ({ protocol: "Mainline DHT (BEP44) — Direct UDP", relays: [] }),
    networkChanged() {
      void invoke("pkarr_network_changed").then(() => {
        askedAt = 0; refresh();
        for (const listener of listeners) listener("recovered");
      }).catch(() => {});
    },
    configure({ relays, readRelays }) {
      void invoke("set_pkarr_relays", { relays, readRelays }).then(() => { askedAt = 0; refresh(); }).catch(() => {});
    },
    discovery: () => status ?? { path: null, relays: [] },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The WebView may not talk to localhost (CSP, CORS); Rust may, and only to
 * loopback addresses this profile's person allowed (`local_service_allow`),
 * without following redirects. The Rust request cannot be aborted, so this
 * settles only when it does: the host counts it toward the peer's limit until
 * then.
 */
const tauriLocalFetch: LocalFetch = async (request) => {
  request.signal.throwIfAborted();
  const response = await invoke<{ status: number; headers: [string, string][]; body_b64: string }>("local_fetch", {
    space: fileSpace(),
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

/**
 * A Pubky cookie session (Pubky Ring's approval) through Rust: WKWebView drops the homeserver's session cookie, a
 * third-party one in the page, so the homeserver refused every write. Rust keeps this approval's cookies in a jar of
 * its own (`pubky_session`), which `close` drops; the page never sees them.
 */
const pubkyCookieSession = (): PubkyCookieSession => {
  const session = toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  return {
    async fetch(request) {
      const answer = await invoke<{ status: number; headers: [string, string][]; body_b64: string }>("pubky_session_fetch", {
        session,
        url: request.url,
        method: request.method,
        headers: request.headers,
        bodyB64: request.body ? toBase64(request.body) : null,
      });
      return { status: answer.status, headers: answer.headers, body: fromBase64(answer.body_b64) };
    },
    close: () => void invoke("pubky_session_close", { session }).catch(() => {}),
  };
};

export interface ServiceRequest {
  id: number;
  peer: string;
  service: string;
  method: string;
  path: string;
  headers: [string, string][];
  body_b64: string | null;
}

const VIEWER_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface ServiceWindowResponse {
  status: number;
  headers: [string, string][];
  body_b64: string;
}

/**
 * The answer a service window gets for one request: the contact's, over the data link, with only the headers a
 * viewer serves (`viewerResponseHeaders`), or a short page saying why there is none.
 */
export async function answerServiceWindow(server: Pick<EngineServer, "ready" | "node">, payload: ServiceRequest): Promise<ServiceWindowResponse> {
  try {
    await server.ready;
    const answer = await server.node.request(payload.peer, payload.service, {
      method: payload.method,
      path: payload.path,
      headers: payload.headers,
      body: payload.body_b64 ? fromBase64(payload.body_b64) : null,
      maxResponseBytes: VIEWER_MAX_RESPONSE_BYTES,
    });
    return { status: answer.status, headers: viewerResponseHeaders(answer.headers), body_b64: toBase64(await answer.bytes()) };
  } catch (error) {
    const gone = error instanceof GhostlyHttpError && ["unreachable", "timeout", "closed", "offline"].includes(error.code);
    const text = gone
      ? "This service is not reachable. Services exist while their ghost is online."
      : `The request failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      status: gone ? 503 : 502,
      headers: [["content-type", "text/plain; charset=utf-8"]],
      body_b64: toBase64(new TextEncoder().encode(text)),
    };
  }
}

/** Requests from a service window arrive here and leave over the contact's data link. */
function serveServiceWindows(server: EngineServer): void {
  void listen<ServiceRequest>("ghostly-svc-request", async ({ payload }) => {
    const response = await answerServiceWindow(server, payload);
    await invoke("service_respond", { id: payload.id, response });
  });
}

/**
 * WKWebView opens about 46 WebRTC connections in one page, and no more (WISP 902 · Group Mesh § Cost per member): on a
 * Mac, groups and 1:1 chats over WebRTC hold at most 40, and the rest stay for calls. WebKitGTK (Linux) has no WebRTC in the page,
 * and WebView2 (Windows) no limit this low.
 */
export const MAC_PEER_BUDGET = 40;
export function macPeerBudget(agent = typeof navigator === "undefined" ? "" : navigator.userAgent): { peerBudget?: number } {
  return /Macintosh|Mac OS X/.test(agent) && !/iPhone|iPad/.test(agent) ? { peerBudget: MAC_PEER_BUDGET } : {};
}

/**
 * How the sounds let go of the audio output between sounds (apps/ui/src/lib/sounds.ts). WebKitGTK (Linux) holds the
 * page for seconds inside an `AudioContext.resume()` that follows a `suspend()`, so there the context is closed and a
 * new one made for the next sound. WKWebView (macOS) and WebView2 (Windows) resume at once and keep one.
 */
export function soundsRelease(agent = typeof navigator === "undefined" ? "" : navigator.userAgent): SoundsRelease {
  return /Linux/.test(agent) && !/Android/.test(agent) ? "close" : "suspend";
}

/**
 * New Chat and Settings from outside the page. On a Mac they are the app menu's items (Cmd+N, Cmd+,), which Rust
 * sends as `app-command` (apps/desktop/src/app_window.rs). Linux and Windows have no menu bar: there the page takes
 * Ctrl+N and Ctrl+, itself. The Mac leaves the keys to the menu, so a press runs once.
 */
export function listenForAppCommands(agent = typeof navigator === "undefined" ? "" : navigator.userAgent): void {
  void listen<unknown>("app-command", ({ payload }) => { if (isAppCommand(payload)) sendAppCommand(payload); }).catch(() => {});
  if (/Macintosh|Mac OS X/.test(agent)) return;
  window.addEventListener("keydown", (event) => {
    const command = appCommandForKey(event);
    if (!command) return;
    event.preventDefault();
    sendAppCommand(command);
  });
}

/** The bundle id of the Desktop builds the e2e tests drive (apps/desktop/tauri.e2e.conf.json), and of their copies. */
const E2E_IDENTIFIER = "tools.ghostly.e2e";

/**
 * Whether an e2e suite runs this app: the macOS e2e build's bundle id, or `GHOSTLY_E2E=1` from any e2e launcher (Rust's
 * `under_test`). The Linux Desktop e2e runs the real bundle id, and the app's own test driver sets no
 * `navigator.webdriver`, so those runs rely on the environment.
 */
export async function desktopUnderTest(): Promise<boolean> {
  if ((await getIdentifier()).startsWith(E2E_IDENTIFIER)) return true;
  return await invoke<boolean>("under_test");
}

/** `calls`: what Rust said about calls on this machine (`nativeCallSupport`), for `nativeCallOptions`. */
export function createDesktopHost(version: string, calls: NativeCallSupport | null = null) {
  const { node: callOptions, callMedia } = nativeCallOptions(calls);
  // Native calls capture and play in Rust: the microphones, cameras and speakers to choose from are GStreamer's.
  if (callMedia) setDeviceSource(nativeDevices);
  // The title bar follows the app's Light / Dark choice (null: the system's). On a Mac this is the app's appearance, so
  // the page's `prefers-color-scheme` follows it too, and comes back to the system's with System.
  setWindowThemeSink((value) => void invoke("plugin:window|set_theme", { label: "main", value }).catch(() => {}));
  // Every step of a link's way to a live connection goes to the app's log (see `diagnostic_log`), so a
  // pairing that took long can be read back afterwards, step by step.
  setLinkTraceSink((line) => void invoke("diagnostic_log", { line: `link ${line}` }).catch(() => {}));
  listenForAppCommands();
  setSoundsRelease(soundsRelease());
  // A new profile asks for a name; never under an e2e suite, which runs no automated browser here (desktopUnderTest).
  setNameStepUnderTest(desktopUnderTest);
  // Files sent and received are real files in the app's data folder, written and read through Rust.
  registerFileBytes("native", async () => new NativeFileBytes(invoke as NativeInvoke), true);
  // The unread count, as the web app's icon has it (muted chats left out), on the Dock icon.
  setAppBadgeTarget(dockBadge());
  return createInPageHost({
    version,
    features: { shareLocalServices: true, openServices: true, profiles: true },
    updates: desktopUpdates,
    // Mini-apps run in windows of their own on Rust's `ghostly-app` scheme, which serves the runner with its policy
    // (apps/desktop/src/app_sandbox.rs; WISP 1200): one address, the policy chosen by what the person granted.
    appRunner: "ghostly-app://localhost/",
    appNetRunner: "ghostly-app://localhost/",
    appRunnerServed: true,
    node: { nativeTransports: { "iroh/1": createIrohEndpoint, "hyperdht/1": createHyperEndpoint }, nativeIrohRelays: true, transport: createTauriTransport(), pollIntervals: DHT_POLL_INTERVALS, localFetch: tauriLocalFetch, platform: "desktop", invoke,
      // Wake-ups go from Rust: push services answer without CORS, which a WebView would enforce (WISP 401 § Wake-up push).
      pushSend: (request) => invoke<number>("push_send", { url: request.url, headers: Object.entries(request.headers), body: toBase64Url(request.body) }),
      // A new profile gets its default Mainnet wallets; never under an e2e suite (desktopUnderTest).
      defaultWallets: defaultWalletsAllowed(desktopUnderTest),
      // Mini-apps on in the e2e suite's build only (VITE_APPS_TEST, fixed when the build is made), reading its test store.
      ...(import.meta.env.VITE_APPS_TEST === "1" ? { apps: true, appFetch: appsTestFetch() } : {}),
      ...macPeerBudget(), ...callOptions },
    callMedia,
    onServer: serveServiceWindows,
    oidc: desktopOidc,
    atproto: desktopAtproto,
    // A WebView cannot hand a lightning: or bitcoin: link to the system; Rust does, for those two schemes only.
    openPaymentLink: (uri) => invoke("open_payment_link", { url: uri }),
    fullscreenWindow: (on) => invoke("plugin:window|set_fullscreen", { label: "main", value: on }),
    // Passport in the system browser: the SDK's relay brings the approval back either way.
    openPubkyPassport: (url) => invoke("open_pubky_passport", { url }),
    // Ring's cookie session: its homeserver requests through Rust, which keeps the cookie WKWebView drops.
    pubkyCookieSession,
    // "Keep this computer awake" (WISP 06): Rust holds the system's own sleep assertion, and it ends with the app.
    keepAwake: (on) => invoke<boolean>("keep_awake", { on }),
    // WKWebView has no Web Share API; the system's share sheet is shown by Rust (macOS; elsewhere false: the page copies).
    shareText: (text, anchor) => invoke<boolean>("share_text", { text, anchor }),
    // WKWebView's readText() shows a "Paste" callout that needs a second click; Rust reads the text (main window only, bounded).
    readClipboardText: () => invoke<string>("read_clipboard_text"),
    // A paste the webview showed the page nothing of (no files, no text): Rust looks for copied files or a picture.
    // Their bytes stay in Rust, read by token; the page never names a path.
    readClipboardFiles: async () => (await invoke<{ token: string; name: string | null; size: number; mime: string | null }[]>("read_clipboard_files"))
      .map(({ token, ...item }) => ({ ...item, read: async (offset: number, length: number) => {
        const bytes = await invoke<ArrayBuffer | number[]>("read_pasted_bytes", { token, offset, length });
        return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes);
      } })),
    // Rust asks in a native dialog naming the exact address (the page can neither draw nor answer it), and keeps the
    // answer per profile: `local_fetch` reaches only an address allowed there.
    requestLocalAccess: (_pattern, origin) => invoke<boolean>("local_service_allow", { space: fileSpace(), origin }),
    forgetLocalAccess: (origin) => invoke<void>("local_service_forget", { space: fileSpace(), origin }),
    async openService(peerPubKeyZ32, serviceId) {
      const service = engine.linkByPeer(peerPubKeyZ32)?.peerServices?.find((s) => s.id === serviceId);
      await invoke("open_service_window", { peer: peerPubKeyZ32, service: serviceId, title: service?.name ?? serviceId });
    },
  });
}
