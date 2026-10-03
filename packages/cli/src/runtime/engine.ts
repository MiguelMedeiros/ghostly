import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromBase64Url, setLinkTraceSink } from "@ghostly/core";
import type { EngineServer } from "@ghostly/browser/engine/server";
import { loadCallStack } from "../calls/media";
import { CliError } from "../errors";
import { nodeLocalFetch } from "../services";
import { nodeFedimintSdk } from "./fedimint";
import { installFileFetch } from "./fileFetch";
import { nodePushSend } from "./pushSend";
import { openPersistentIndexedDb, type PersistentIndexedDb } from "./storage";
import { RESTORED_MARK, type ProfilePaths } from "../profiles";

/** What runs a profile: its store, the engine and the host around it. */
export interface Runtime {
  readonly paths: ProfilePaths;
  /** WebRTC runs here (node-datachannel loaded). */
  readonly webrtc: boolean;
  /** Why voice calls cannot run here, or null when they can (node-datachannel's media and Opus loaded). */
  readonly callsUnavailable: string | null;
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
 * The Pkarr relays of a private network or a test, `GHOSTLY_PKARR_RELAYS` ("http://…,…"), the Desktop's name for it:
 * the only relays this process uses, whatever the profile's `relays` setting says, from its very first publish. Null
 * when unset.
 */
export function pkarrRelays(env = process.env): string[] | null {
  const relays = (env.GHOSTLY_PKARR_RELAYS ?? "").split(",").map((url) => url.trim()).filter(Boolean);
  if (!relays.length) return null;
  const bad = relays.find((url) => !/^https?:\/\/[^/\s]/i.test(url));
  if (bad) throw new CliError("usage", `GHOSTLY_PKARR_RELAYS takes http:// or https:// URLs, comma-separated, not ${JSON.stringify(bad)}`);
  return relays;
}

/**
 * The Mainline DHT, for Pkarr beside the relays (`RelaysAndDht`): `GHOSTLY_DHT=0` leaves it out (relays only, as the web
 * app), `GHOSTLY_DHT_BOOTSTRAP` ("host:port,…") replaces the public routers (a testnet; one all on loopback binds there).
 * `GHOSTLY_PKARR_RELAYS` without a bootstrap leaves it out too, as on the Desktop: a private network stays off the
 * public DHT.
 */
export function mainlineNetwork(env = process.env): { off: true } | { off: false; bootstrap?: string[]; host?: string } {
  if (env.GHOSTLY_DHT === "0") return { off: true };
  const bootstrap = (env.GHOSTLY_DHT_BOOTSTRAP ?? "").split(",").map((node) => node.trim()).filter(Boolean);
  if (!bootstrap.length && pkarrRelays(env)) return { off: true };
  if (!bootstrap.length) return { off: false };
  const loopback = bootstrap.every((node) => /^(127\.0\.0\.1|localhost):\d+$/.test(node));
  return { off: false, bootstrap, ...(loopback ? { host: "127.0.0.1" } : {}) };
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
  // Beside this chunk, wherever the bundler put it (the entry, or assets/); else the workspace's.
  for (const place of ["./ghostly_iroh_web_bg.wasm", "./assets/ghostly_iroh_web_bg.wasm"]) {
    const path = fileURLToPath(new URL(place, import.meta.url));
    if (existsSync(path)) return readFileSync(path);
  }
  return readFileSync(createRequire(import.meta.url).resolve("@ghostly/iroh-web/wasm"));
}

/** How a runtime starts: `deferGroups` leaves the groups' sessions unstarted (a one-shot for one chat). */
export interface RuntimeOptions { deferGroups?: boolean }

/**
 * Starts the app's engine on this profile (WISP 11xx § Runtime): IndexedDB on disk, WebRTC through libdatachannel,
 * HyperDHT native in this process, Iroh's wasm build (relay only, as the web app), Pkarr through the relays in the
 * settings and the Mainline DHT directly (read when the relays fail, written always).
 * The caller holds the profile's lock.
 */
/** The files a light backup left out, as the restore wrote them in the mark (an empty mark: none). */
function leftOutIn(mark: string): string[] {
  try {
    const ids = (JSON.parse(readFileSync(mark, "utf8") || "{}") as { leftOut?: unknown }).leftOut;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export async function startRuntime(paths: ProfilePaths, options: RuntimeOptions = {}): Promise<Runtime> {
  // `GHOSTLY_LINK_TRACE=<file>`: each step of each chat's way to live, one JSON line (packages/core/src/linkTrace.ts),
  // as the Desktop writes to its log. For measuring, not needed to run.
  // Read first: a mistyped one stops here, before anything opens.
  const pinned = pkarrRelays();
  const trace = process.env.GHOSTLY_LINK_TRACE;
  if (trace) setLinkTraceSink(line => appendFileSync(trace, line + "\n", { mode: 0o600 }));
  const store = await openPersistentIndexedDb(paths.db);
  // A profile a restore made, started for the first time: its store is the backup's, as old as the backup. Its ecash
  // is checked with the mints and its unfinished payment attempts authorize nothing, as in the app's restore. Done
  // before the engine reads any of it; the mark goes only once that is on disk, so a start cut short does it again.
  const restored = join(paths.dir, RESTORED_MARK);
  if (existsSync(restored)) {
    try {
      const rows = await import("@ghostly/browser/shared/restoredRows");
      await rows.markRestoredWallet();
      // The files a light backup left out: their records say so, as in the app's restore.
      await rows.markLeftOutFiles(leftOutIn(restored));
      await store.compact();
    } catch (error) {
      await store.close().catch(() => {});
      throw error;
    }
    rmSync(restored, { force: true });
  }
  const webrtc = await installWebRtc();
  // Voice calls (WISP 11xx § Calls): offered to contacts (calls/1) only where their media can run.
  const stack = webrtc ? await loadCallStack() : "Calls need WebRTC, which is off on this headless Ghostly";
  const callsUnavailable = typeof stack === "string" ? stack : null;
  installFileFetch();
  // `GHOSTLY_TEST_MINTS=<url,…>`: mints on this machine that are test servers with a fake Lightning backend (a regtest
  // or e2e stack). Only through them does a Testnet wallet pay a Bitcoin (lnbc) invoice, as through the public test mint.
  const testMints = process.env.GHOSTLY_TEST_MINTS;
  if (testMints) (await import("@ghostly/browser/shared/mints")).declareTestMints(testMints.split(","));
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
    import("../../../../native/transports/hyperdht/endpoint.mjs"),
  ]);
  const network = hyperdhtNetwork();
  const dht = mainlineNetwork();
  const mainline = dht.off ? null : new (await import("./mainline")).Mainline({ bootstrap: dht.bootstrap, host: dht.host });
  // `GHOSTLY_PKARR_RELAYS`: those relays only, in place before the engine publishes anything (the setting is not read).
  const transport = (mainline || pinned) ? new (await import("./mainline")).RelaysAndDht(mainline, pinned ? { relays: pinned } : {}, !!pinned) : null;
  const server = new EngineServer({
    ...(transport ? { transport } : {}),
    irohWeb: true,
    nativeTransports: { "hyperdht/1": (seedB64: string) => createHyperEndpoint(fromBase64Url(seedB64), network) },
    // No wallet starts by itself: a bot has the wallets it made (WISP 11xx § Wallet SDKs on Node).
    automaticWallets: false,
    // Fedimint's client databases are files of the profile, each in a worker thread (./fedimint.ts).
    fedimintSdk: nodeFedimintSdk(join(paths.dir, "fedimint")),
    // Local web apps may be shared with a contact, reached on loopback only (src/services.ts).
    servicesSupport: true,
    // A daemon stays online: a hub of the large private groups it is in (WISP 9xx · Group Mesh § Hubs), unless GHOSTLY_HUB=0.
    staysOnline: process.env.GHOSTLY_HUB !== "0",
    localFetch: nodeLocalFetch,
    // A wake-up goes to a push service only, on public addresses only (./pushSend.ts), as the Desktop's does.
    pushSend: (request) => nodePushSend(request),
    callsSupport: callsUnavailable === null,
    ...(callsUnavailable ? { callsUnavailable } : {}),
    ...(options.deferGroups ? { deferGroups: true } : {}),
    // Tests only: group links as an app from before native ones (test/groupCompat.test.ts).
    ...(process.env.GHOSTLY_TEST_WEBRTC_GROUP_LINKS === "1" ? { webrtcGroupLinks: true } : {}),
  });
  try {
    await server.ready;
  } catch (error) {
    await mainline?.destroy().catch(() => {});
    await store.close().catch(() => {});
    throw error;
  }
  let closing: Promise<void> | null = null;
  return {
    paths, server, store, webrtc, callsUnavailable,
    close: () => (closing ??= (async () => {
      await server.node.shutdown().catch(() => {});
      await mainline?.destroy().catch(() => {});
      await store.close();
    })()),
  };
}
