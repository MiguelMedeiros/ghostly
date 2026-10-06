import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPS_CAPABILITY, GhostLink, chatAppId, createIdentity, createLink, identityFromSeedB64, toZ32, type AppFrameEvent, type PairingState } from "@ghostly/core";
import { EngineServer, type EngineClientSink } from "../src/engine/server";
import { db } from "../src/engine/db";
import { APPS_ENABLED } from "../src/shared/features";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: apps.chat.wire

/**
 * Mini-apps in the engine (WISP 1200 § In a chat: `apps/1`): the pages open an app in a paired chat by its reference,
 * talk to the same app on the contact's side through the engine's calls, and hear the contact's frames as `app-frame`
 * events. A real engine and its contact's link over a stand-in for Iroh, as reactions.test.ts does. Behind a flag:
 * off, nothing is offered and every call is refused.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

type Call = (method: string, params?: unknown) => Promise<unknown>;

async function setup({ apps, contactApps = true, beforeLive }: { apps?: boolean; contactApps?: boolean; beforeLive?: (call: Call, linkId: string, ref: string) => Promise<void> } = {}) {
  const net = new FakeNativeNet();
  const invitation = createLink();
  const [mine, theirs] = [createIdentity().seedB64, createIdentity().seedB64];
  const id = `apps-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: mine, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(theirs).pubKeyZ32, peerTrust: { version: 1 },
    peerTransports: ["iroh/1"], peerFallback: true, preferredTransport: "iroh/1", transportFallback: true,
    peerDescriptors: { "iroh/1": { id: "contact:iroh/1" } } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const server = new EngineServer({ transport, automaticWallets: false, nativeTransports: { "iroh/1": async () => net.endpoint("iroh/1", "app") },
    ...(apps !== undefined && { apps }) });
  // One page: what the engine tells it, and its calls answered in order.
  const events: EngineEvent[] = [];
  const answers = new Map<number, RpcResponse>();
  const page: EngineClientSink = { post: message => { if (message.kind === "response") answers.set(message.id, message); else events.push(message); } };
  server.attach(page);
  let next = 0;
  const call: Call = async (method, params) => {
    const request = { kind: "request" as const, id: ++next, method, params } as Parameters<EngineServer["handle"]>[1];
    await server.handle(page, request);
    const answer = answers.get(request.id)!;
    if (answer.error !== undefined) throw new Error(answer.error);
    return answer.result;
  };
  let contactState: PairingState = { status: "connecting" };
  const contactGot: AppFrameEvent[] = [];
  const contact = new GhostLink({
    params: { ...invitation.invite, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: theirs, peerKey: identityFromSeedB64(mine).pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1"], peerFallback: true, peerDescriptors: { "iroh/1": { id: "app:iroh/1" } } },
    transport, createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    appsSupport: contactApps,
    events: { onPairingState: state => { contactState = state; }, onAppFrame: event => { contactGot.push(event); } },
  });
  cleanup.push(async () => { await contact.stop(false); await server.stop(); await db.deleteLink(id); });
  await server.ready;
  server.node.setActiveLink({ linkId: id });
  const view = () => server.node.getState().links.find(l => l.id === id)!;
  await vi.waitFor(() => expect(view().availableTransports).toHaveLength(1));
  const ref = `${toZ32(createIdentity().publicKey)}/chess`;
  // Before the contact's endpoint is there: the chat cannot be live.
  await beforeLive?.(call, id, ref);
  contact.registerEndpoint(net.endpoint("iroh/1", "contact"));
  void contact.connect(5_000).catch(() => {});
  await vi.waitFor(() => expect([view().pairing?.status, contactState.status]).toEqual(["ready", "ready"]));
  await vi.waitFor(() => expect(contact.sessionOffers.peer).not.toBeNull());
  // The id as the contact computes it, from its own side of the two pinned keys.
  const app = chatAppId(identityFromSeedB64(theirs).publicKey, identityFromSeedB64(mine).publicKey, ref);
  const appEvents = () => events.filter((e): e is Extract<EngineEvent, { kind: "app-frame" }> => e.kind === "app-frame");
  return { server, page, call, contact, contactGot, id, ref, app, appEvents };
}

describe("apps in the engine (apps/1)", () => {
  it("are off in this build: nothing is offered, every call is refused", async () => {
    expect(APPS_ENABLED).toBe(false);
    const { call, contact, id, ref, app, appEvents } = await setup();
    expect(contact.sessionOffers.peer).not.toContain(APPS_CAPABILITY);
    expect(contact.supportsApps).toBe(false);
    for (const [method, params] of [["appId", { linkId: id, ref }], ["appOpen", { linkId: id, ref, version: "1.0.0" }], ["appClose", { linkId: id, ref }], ["appSend", { linkId: id, ref, data: 1 }]] as const)
      await expect(call(method, params), method).rejects.toThrow("Apps are unavailable in this release");
    // What the contact says anyway is dropped.
    contact.openApp(app, "1.0.0");
    (contact as unknown as { channel: { send(data: string): void } }).channel.send(JSON.stringify({ t: "paired-app", a: app, o: "open", v: "1.0.0" }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(appEvents()).toEqual([]);
  });

  it("on: the page opens an app by its reference, the contact hears it under the same chat app id, and they talk", async () => {
    const { call, contact, contactGot, id, ref, app, appEvents } = await setup({ apps: true });
    await vi.waitFor(() => expect(contact.supportsApps).toBe(true));
    expect(await call("appId", { linkId: id, ref })).toEqual({ app });
    expect(await call("appOpen", { linkId: id, ref, version: "1.0.0" })).toEqual({ app });
    await vi.waitFor(() => expect(contactGot).toEqual([{ app, o: "open", v: "1.0.0" }]));
    // The contact has not opened it yet.
    expect(await call("appSend", { linkId: id, ref, data: { move: "e2e4" } })).toEqual({ error: "peer-closed" });
    contact.openApp(app, "1.0.1");
    await vi.waitFor(() => expect(appEvents().map(e => [e.linkId, e.event])).toEqual([[id, { app, o: "open", v: "1.0.1" }]]));
    expect(await call("appSend", { linkId: id, ref, data: { move: "e2e4" } })).toEqual({ error: null });
    await vi.waitFor(() => expect(contactGot.at(-1)).toEqual({ app, d: { move: "e2e4" } }));
    expect(contact.sendAppData(app, { move: "e7e5" })).toBeNull();
    await vi.waitFor(() => expect(appEvents().at(-1)?.event).toEqual({ app, d: { move: "e7e5" } }));
    expect(await call("appSend", { linkId: id, ref, data: "x".repeat(32 * 1024) })).toEqual({ error: "too-large" });
    await call("appClose", { linkId: id, ref });
    await vi.waitFor(() => expect(contactGot.at(-1)).toEqual({ app, o: "close" }));
    expect(await call("appSend", { linkId: id, ref, data: 1 })).toEqual({ error: "not-open" });
  });

  it("on: refuses what is not an app reference, a version, or a paired chat", async () => {
    const { call, id, ref } = await setup({ apps: true });
    await expect(call("appOpen", { linkId: id, ref: "chess", version: "1.0.0" })).rejects.toThrow("Not an app reference");
    await expect(call("appOpen", { linkId: id, ref, version: "1.0" })).rejects.toThrow("Not an app version");
    await expect(call("appOpen", { linkId: "nope", ref, version: "1.0.0" })).rejects.toThrow("No such chat");
  });

  it("on: the contact's app without apps/1 (an older app) gets no frame, and a send says so", async () => {
    const { call, contact, contactGot, id, ref } = await setup({ apps: true, contactApps: false });
    expect(contact.sessionOffers.peer).toContain(APPS_CAPABILITY);
    await call("appOpen", { linkId: id, ref, version: "1.0.0" });
    expect(await call("appSend", { linkId: id, ref, data: 1 })).toEqual({ error: "peer-closed" });
    await call("appClose", { linkId: id, ref });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(contactGot).toEqual([]);
  });

  it("on: when the last page goes, its apps close and the contact hears it", async () => {
    const { server, page, call, contact, contactGot, id, ref, app } = await setup({ apps: true });
    await vi.waitFor(() => expect(contact.supportsApps).toBe(true));
    await call("appOpen", { linkId: id, ref, version: "1.0.0" });
    await vi.waitFor(() => expect(contactGot).toEqual([{ app, o: "open", v: "1.0.0" }]));
    server.detach(page);
    await vi.waitFor(() => expect(contactGot.at(-1)).toEqual({ app, o: "close" }));
  });

  it("on: an app opened while the chat is offline says open once the session is live", async () => {
    const offline: unknown[] = [];
    const { contactGot, app } = await setup({ apps: true, beforeLive: async (call, linkId, ref) => {
      await call("appOpen", { linkId, ref, version: "1.0.0" });
      offline.push(await call("appSend", { linkId, ref, data: 1 }));
    } });
    // Nothing was kept to send later: only the open goes.
    expect(offline).toEqual([{ error: "offline" }]);
    await vi.waitFor(() => expect(contactGot).toEqual([{ app, o: "open", v: "1.0.0" }]));
  });
});
