import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createLink } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";

const transport = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const FAST = { active: 300, idle: 300, fast: 300, background: 300, connected: 300 };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let node: GhostlyNode | undefined;
afterEach(async () => { await node?.shutdown(); node = undefined; vi.unstubAllGlobals(); });

/** Reads of a quiet chat: its link's polls (start and end) and its DHT mailbox's ticks, as an idle profile runs them. */
async function quietChat() {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const onState = vi.fn();
  node = new GhostlyNode({ onState, onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: transport as never, automaticWallets: false, nativeTransports: {}, pollIntervals: FAST });
  await node.start();
  const { linkId } = await node.ensureLink({ ...createLink().mine, profile: "paired-chat/1" });
  const live = (node as unknown as { links: Map<string, { poll: { nextAt: number }; lastSyncAt: number; link: { dht: { tick(): Promise<void> } } }> }).links.get(linkId)!;
  await vi.waitFor(() => expect(live.lastSyncAt).toBeGreaterThan(0), { timeout: 5000 });
  await wait(600);
  return { onState, live, linkId };
}

it("a quiet chat's polls and DHT mailbox reads post no state while nothing a row shows changes", async () => {
  const { onState, live } = await quietChat();
  onState.mockClear();
  // Who asked for a state, so a failure names the callback.
  const stacks: string[] = [];
  const original = (node as unknown as { emitState: (d?: number) => void }).emitState.bind(node);
  (node as unknown as { emitState: (d?: number) => void }).emitState = (d?: number) => { stacks.push(new Error().stack!.split("\n").slice(2, 6).join(" | ")); original(d); };
  const polledBefore = live.poll.nextAt;
  for (let i = 0; i < 4; i++) { await live.link.dht.tick(); await wait(300); }
  // The link kept polling and the mailbox kept being read, but nothing the chat list shows moved.
  expect(live.poll.nextAt).toBeGreaterThan(polledBefore);
  expect(stacks).toEqual([]);
  expect(onState).not.toHaveBeenCalled();
}, 20000);

it("the open chat's polls still reach its connection panel", async () => {
  const { onState, live, linkId } = await quietChat();
  node!.setActiveLink({ linkId });
  await wait(100);
  onState.mockClear();
  const syncedBefore = live.lastSyncAt;
  await wait(1200);
  expect(live.lastSyncAt).toBeGreaterThan(syncedBefore);
  expect(onState).toHaveBeenCalled();
  const shown = onState.mock.calls.at(-1)![0].links.find((l: { id: string }) => l.id === linkId);
  expect(shown.lastSyncAt).toBeGreaterThan(syncedBefore);
}, 20000);
