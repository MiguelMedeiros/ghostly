import { vi } from "vitest";
import manifest from "../public/manifest.json";
import { fire, installFakeChrome, settle, type FakeWorld } from "./fakeChrome";
import { engineControl, resetEngine, type FakeEngineServer } from "./fakeEngine";

/** A peer key and a service a contact shares, as the viewer addresses them. */
export const PEER = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1o";
export const OTHER_PEER = "h769ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqy";
export const SERVICE = "atlas";
/** This profile's chat with PEER (`viewerTag`), and another profile's chat with the same contact. */
export const TAG = "ybndrfg8ejkmcpqx";
export const OTHER_TAG = "ot1uwisza345h769";

/**
 * The extension as Chrome runs it: the service worker loaded, and the offscreen
 * document loaded the first time the worker creates it, which it does as it
 * loads: `bootExtension` returns once that start is over. `before` sets up the
 * browser the worker finds (the profile registry, a lock). Every call starts from
 * fresh modules; `@ghostly/browser/engine/server` must be mocked by the test.
 */
export async function bootExtension(edit?: (manifest: chrome.runtime.Manifest) => void, before?: (world: FakeWorld) => void): Promise<FakeWorld> {
  vi.resetModules();
  const copy = structuredClone(manifest) as chrome.runtime.Manifest;
  edit?.(copy);
  const world = installFakeChrome(copy);
  before?.(world);
  let documents = 0;
  world.onCreateDocument = async () => {
    // A new document runs its script afresh; the first one shares the boot's fresh modules.
    if (documents++) vi.resetModules();
    await world.load("offscreen", () => import("../src/offscreen.ts"));
  };
  await world.load("background", () => import("../src/background.ts"));
  await workerStarted(world, 0);
  return world;
}

/** Chrome stopped the idle worker and starts it again: new module state, same browser. */
export async function restartServiceWorker(world: FakeWorld): Promise<void> {
  world.restartServiceWorker();
  vi.resetModules();
  const from = world.calls.length;
  await world.load("background", () => import("../src/background.ts"));
  await workerStarted(world, from);
}

/**
 * Waits for the start of the peer the worker makes as it loads (or for its failure), as an `ensure-engine` would: handed
 * to the worker's listener directly, so nothing of it shows in `calls`. Only a start the worker made by itself (a
 * document created, or a running one asked) is waited on: this wait never starts the peer.
 */
async function workerStarted(world: FakeWorld, from: number): Promise<void> {
  await settle();
  const own = world.calls.slice(from).some(({ api, args }) => api === "offscreen.createDocument" || (api === "runtime.sendMessage" && (args[0] as { type?: string })?.type === "ping"));
  if (!own) return;
  const sender = { id: world.chrome.runtime.id, url: world.chrome.runtime.getURL("app.html") };
  await new Promise((resolve) => fire(world.chrome.runtime.onMessage, { target: "background", type: "ensure-engine" }, sender, resolve));
}

/**
 * Chrome reloads the extension (Update and restart, a reload in chrome://extensions, turned off and on): its pages, its
 * session storage, its offscreen document and its debugger sessions go, and a new worker starts. Every other tab stays,
 * a contact's app in one included. `meanwhile` runs before the new worker starts, as a page may do anything then.
 */
export async function reloadExtension(world: FakeWorld, meanwhile?: () => void): Promise<void> {
  const own = world.chrome.runtime.getURL("");
  for (const tab of [...world.tabs.values()]) if (tab.url.startsWith(own)) world.tabs.delete(tab.id);
  world.session.clear();
  world.endOffscreen();
  resetEngine();
  meanwhile?.();
  await restartServiceWorker(world);
}

export function engine(): FakeEngineServer {
  const servers = engineControl().servers;
  if (servers.length !== 1) throw new Error(`expected one engine, found ${servers.length}`);
  return servers[0];
}

/** Opens a viewer tab for PEER's service from a page of `profile` (the first one's by default), and returns the tab id. */
export async function openViewer(world: FakeWorld, peer = PEER, service = SERVICE, tag = TAG, page?: unknown, relayOnly?: unknown, profile = ""): Promise<number> {
  const reply = (await world.chrome.runtime.sendMessage({
    target: "background",
    type: "open-service",
    peerPubKeyZ32: peer,
    serviceId: service,
    tag,
    profile,
    page,
    ...(relayOnly !== undefined ? { relayOnly } : {}),
  })) as { ok: boolean; error?: string };
  if (!reply.ok) throw new Error(reply.error);
  const tab = [...world.tabs.values()].find((t) => t.url === `https://${service}.${peer}.${tag}.invalid/`);
  if (!tab) throw new Error("no viewer tab");
  return tab.id;
}

/** DevTools pauses a request in a viewer tab; returns what the worker told DevTools to do with it. */
export async function pauseRequest(
  world: FakeWorld,
  tabId: number,
  request: { url: string; method?: string; headers?: Record<string, string>; postData?: string; postDataEntries?: { bytes?: string }[] },
  resourceType?: string,
): Promise<{ method: string; params: Record<string, unknown> }> {
  const before = world.callsTo("debugger.sendCommand").length;
  const requestId = `r${Math.random()}`;
  fire(world.chrome.debugger.onEvent, { tabId }, "Fetch.requestPaused", { requestId, request: { method: "GET", headers: {}, ...request }, ...(resourceType ? { resourceType } : {}) });
  for (let i = 0; i < 50; i++) {
    const answer = world
      .callsTo("debugger.sendCommand")
      .slice(before)
      .find(([, , params]) => (params as { requestId?: string })?.requestId === requestId);
    if (answer) return { method: answer[1] as string, params: answer[2] as Record<string, unknown> };
    await settle(1);
  }
  throw new Error("the paused request was never answered");
}

/**
 * Asks the peer for a contact's app's request over the viewer port, as the worker does (`askPeer`), as `sender`: the
 * worker by default. Undefined when the port closes with no answer.
 */
export async function askPeer(
  world: FakeWorld,
  request: Partial<{ peerPubKeyZ32: string; serviceId: string; method: string; path: string; headers: [string, string][]; bodyB64: string | null }> = {},
  sender: chrome.runtime.MessageSender = { id: world.chrome.runtime.id, url: world.chrome.runtime.getURL("background.js") },
): Promise<unknown> {
  const port = world.connectFrom(sender, "viewer");
  return new Promise((resolve) => {
    port.onMessage.addListener((message: unknown) => resolve((message as { reply: unknown }).reply));
    port.onDisconnect.addListener(() => resolve(undefined));
    port.postMessage({ id: 1, request: { peerPubKeyZ32: PEER, serviceId: SERVICE, method: "GET", path: "/", headers: [], bodyB64: null, ...request } });
  });
}

export function bodyText(params: Record<string, unknown>): string {
  return Buffer.from(params.body as string, "base64").toString("utf8");
}

/**
 * The peer the worker started as it loaded goes away by itself (`endOffscreen`), and what it did with it is forgotten:
 * for a test of the start that comes next.
 */
export function endBootPeer(world: FakeWorld): void {
  world.endOffscreen();
  resetEngine();
}

/** A page makes profile `id` the one in use, as `switchProfile` writes it (apps/ui/src/lib/profiles.ts). */
export function useProfile(world: FakeWorld, id: string, others: string[] = []): void {
  const profiles = [{ id: "", name: "Personal", createdAt: 0 }, ...[...new Set([id, ...others])].filter(Boolean).map((p) => ({ id: p, name: p, createdAt: 1 }))];
  world.storage.set("ghostly_profiles", JSON.stringify({ version: 1, active: id, profiles }));
}
