import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fromBase64Url } from "@ghostly/core";
import type { EngineServer } from "@ghostly/browser/engine/server";
import { nodeLocalFetch } from "../services";
import { installFileFetch } from "./fileFetch";
import { openPersistentIndexedDb, type PersistentIndexedDb } from "./storage";
import type { ProfilePaths } from "../profiles";

/** What runs a profile: its store, the engine and the host around it. */
export interface Runtime {
  readonly paths: ProfilePaths;
  /** WebRTC runs here (node-datachannel loaded). */
  readonly webrtc: boolean;
  readonly server: EngineServer;
  readonly store: PersistentIndexedDb;
  /** Says goodbye to peers, then folds the store. */
  close(): Promise<void>;
}

/**
 * The HyperDHT network: `GHOSTLY_HYPERDHT_BOOTSTRAP` ("host:port,…") replaces the public bootstrap nodes, as it does
 * for the Desktop's sidecar; a network all on loopback (the tests') is announced on loopback too.
 */
export function hyperdhtNetwork(env = process.env.GHOSTLY_HYPERDHT_BOOTSTRAP): { bootstrap?: string[]; host?: string } {
  const bootstrap = (env ?? "").split(",").map((node) => node.trim()).filter(Boolean);
  if (!bootstrap.length) return {};
  const loopback = bootstrap.every((node) => /^(127\.0\.0\.1|localhost):\d+$/.test(node));
  return { bootstrap, ...(loopback ? { host: "127.0.0.1" } : {}) };
}

/**
 * WebRTC for the engine (WISP 101): libdatachannel through node-datachannel's W3C polyfill. Chats go live over it with
 * browsers directly, and groups need it (their links use WebRTC alone). A native module: without it, or with
 * `GHOSTLY_WEBRTC=0`, the CLI runs without WebRTC and says so.
 */
async function installWebRtc(): Promise<boolean> {
  if (process.env.GHOSTLY_WEBRTC === "0") return false;
  try {
    const polyfill = await import("node-datachannel/polyfill");
    const scope = globalThis as unknown as Record<string, unknown>;
    for (const name of ["RTCPeerConnection", "RTCSessionDescription", "RTCIceCandidate", "RTCDataChannel", "RTCDataChannelEvent", "RTCPeerConnectionIceEvent", "RTCCertificate"] as const) {
      scope[name] ??= (polyfill as unknown as Record<string, unknown>)[name];
    }
    return true;
  } catch (error) {
    process.stderr.write(`ghostly: WebRTC is unavailable (${error instanceof Error ? error.message : String(error)}); chats use HyperDHT, Iroh or the DHT\n`);
    return false;
  }
}

/** Server-sent events, which browsers have and Node does not: Arkade follows its server with them. */
async function installEventSource(): Promise<void> {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope.EventSource) return;
  scope.EventSource = (await import("eventsource")).EventSource;
}

/**
 * Arkade's descriptor library is CommonJS and `require`s `@scure/bip32`, which is ESM. When the engine's own imports
 * are still evaluating that module, Node's require(esm) hands the library a namespace without `HDKey` yet ("reading
 * 'fromMasterSeed'"). Loading it whole first avoids the race.
 */
async function preloadWalletModules(): Promise<void> {
  await import("@scure/bip32").catch(() => {});
  await import("@bitcoinerlab/descriptors-scure").catch(() => {});
}

/** Iroh's wasm, from next to the bundle (a package) or from the workspace (development and tests). */
function irohWasmBytes(): Buffer {
  const beside = fileURLToPath(new URL("./ghostly_iroh_web_bg.wasm", import.meta.url));
  if (existsSync(beside)) return readFileSync(beside);
  return readFileSync(createRequire(import.meta.url).resolve("@ghostly/iroh-web/wasm"));
}

/**
 * Starts the app's engine on this profile (WISP 11xx § Runtime): IndexedDB on disk, WebRTC through libdatachannel,
 * HyperDHT native in this process, Iroh's wasm build (relay only, as the web app), Pkarr through the relays in the
 * settings.
 * The caller holds the profile's lock.
 */
export async function startRuntime(paths: ProfilePaths): Promise<Runtime> {
  const store = await openPersistentIndexedDb(paths.db);
  const webrtc = await installWebRtc();
  installFileFetch();
  await installEventSource();
  await preloadWalletModules();
  // Loaded after IndexedDB is in place: nothing of the engine may open its database first.
  const iroh = await import("@ghostly/iroh-web");
  iroh.initSync({ module: irohWasmBytes() });
  // Files sent and received are real files in the profile's folder, as on the Desktop.
  const [{ registerFileBytes }, { NodeFileBytes }] = await Promise.all([import("@ghostly/browser/shared/fileBytes"), import("./fileBytes")]);
  registerFileBytes("native", async () => new NodeFileBytes(paths.files), true);
  const [{ EngineServer }, { createHyperEndpoint }] = await Promise.all([
    import("@ghostly/browser/engine/server"),
    import("../../../../native-transports/hyperdht/endpoint.mjs"),
  ]);
  const network = hyperdhtNetwork();
  const server = new EngineServer({
    irohWeb: true,
    nativeTransports: { "hyperdht/1": (seedB64: string) => createHyperEndpoint(fromBase64Url(seedB64), network) },
    // No wallet starts by itself: a bot has the wallets it made (WISP 11xx § Wallet SDKs on Node).
    automaticWallets: false,
    // Local web apps may be shared with a contact, reached on loopback only (src/services.ts).
    servicesSupport: true,
    localFetch: nodeLocalFetch,
  });
  try {
    await server.ready;
  } catch (error) {
    await store.close().catch(() => {});
    throw error;
  }
  let closing: Promise<void> | null = null;
  return {
    paths, server, store, webrtc,
    close: () => (closing ??= (async () => {
      await server.node.shutdown().catch(() => {});
      await store.close();
    })()),
  };
}
