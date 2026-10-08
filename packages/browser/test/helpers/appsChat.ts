import { expect, vi } from "vitest";
import { GhostLink, chatAppId, createIdentity, createLink, identityFromSeedB64, toZ32, type AppFrameEvent, type PairingState } from "@ghostly/core";
import { EngineServer, type EngineClientSink } from "../../src/engine/server";
import { db } from "../../src/engine/db";
import type { EngineEvent, RpcResponse } from "../../src/shared/rpc";
import { FakeNativeNet } from "./fakeNative";

/**
 * A real engine with one paired 1:1 chat, live with its contact's link over a stand-in for Iroh, as reactions.test.ts
 * does: for the mini-app tests (WISP 1200 § In a chat: `apps/1`). `apps` is the engine's option, absent when not given.
 * Each chat's teardown goes on `cleanup`, for the test's `afterEach` to run.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

export type Call = (method: string, params?: unknown) => Promise<unknown>;

export async function appsChat(cleanup: (() => Promise<void>)[], { apps, contactApps = true, beforeLive }: { apps?: boolean; contactApps?: boolean; beforeLive?: (call: Call, linkId: string, ref: string) => Promise<void> } = {}) {
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
