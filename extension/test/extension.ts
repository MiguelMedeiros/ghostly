import { vi } from "vitest";
import manifest from "../public/manifest.json";
import { fire, installFakeChrome, settle, type FakeWorld } from "./fakeChrome";
import { engineControl, type FakeEngineServer } from "./fakeEngine";

/** A peer key and a service a contact shares, as the viewer addresses them. */
export const PEER = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u";
export const OTHER_PEER = "h769ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqx";
export const SERVICE = "atlas";

/**
 * The extension as Chrome runs it: the service worker loaded, and the offscreen
 * document loaded the first time the worker creates it. Every call starts from
 * fresh modules; `@ghostly/browser/engine/server` must be mocked by the test.
 */
export async function bootExtension(edit?: (manifest: chrome.runtime.Manifest) => void): Promise<FakeWorld> {
  vi.resetModules();
  const copy = structuredClone(manifest) as chrome.runtime.Manifest;
  edit?.(copy);
  const world = installFakeChrome(copy);
  let documents = 0;
  world.onCreateDocument = async () => {
    // A new document runs its script afresh; the first one shares the boot's fresh modules.
    if (documents++) vi.resetModules();
    await world.load("offscreen", () => import("../src/offscreen.ts"));
  };
  await world.load("background", () => import("../src/background.ts"));
  return world;
}

/** Chrome stopped the idle worker and starts it again: new module state, same browser. */
export async function restartServiceWorker(world: FakeWorld): Promise<void> {
  world.restartServiceWorker();
  vi.resetModules();
  await world.load("background", () => import("../src/background.ts"));
}

export function engine(): FakeEngineServer {
  const servers = engineControl().servers;
  if (servers.length !== 1) throw new Error(`expected one engine, found ${servers.length}`);
  return servers[0];
}

/** Opens a viewer tab for PEER's service from a page, and returns the tab id. */
export async function openViewer(world: FakeWorld, peer = PEER, service = SERVICE): Promise<number> {
  const reply = (await world.chrome.runtime.sendMessage({
    target: "background",
    type: "open-service",
    peerPubKeyZ32: peer,
    serviceId: service,
  })) as { ok: boolean; error?: string };
  if (!reply.ok) throw new Error(reply.error);
  const tab = [...world.tabs.values()].find((t) => t.url === `https://${service}.${peer}.invalid/`);
  if (!tab) throw new Error("no viewer tab");
  return tab.id;
}

/** DevTools pauses a request in a viewer tab; returns what the worker told DevTools to do with it. */
export async function pauseRequest(
  world: FakeWorld,
  tabId: number,
  request: { url: string; method?: string; headers?: Record<string, string>; postData?: string; postDataEntries?: { bytes?: string }[] },
): Promise<{ method: string; params: Record<string, unknown> }> {
  const before = world.callsTo("debugger.sendCommand").length;
  const requestId = `r${Math.random()}`;
  fire(world.chrome.debugger.onEvent, { tabId }, "Fetch.requestPaused", { requestId, request: { method: "GET", headers: {}, ...request } });
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

export function bodyText(params: Record<string, unknown>): string {
  return Buffer.from(params.body as string, "base64").toString("utf8");
}

/** A page makes profile `id` the one in use, as `switchProfile` writes it (src/lib/profiles.ts). */
export function useProfile(world: FakeWorld, id: string, others: string[] = []): void {
  const profiles = [{ id: "", name: "Personal", createdAt: 0 }, ...[...new Set([id, ...others])].filter(Boolean).map((p) => ({ id: p, name: p, createdAt: 1 }))];
  world.storage.set("ghostly_profiles", JSON.stringify({ version: 1, active: id, profiles }));
}
