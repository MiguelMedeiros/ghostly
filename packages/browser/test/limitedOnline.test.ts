import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type PkarrTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { replaceDeviceGate, resetDeviceGates } from "../src/devices/gate";
import { openTurnKeeper } from "../src/devices/setup";
import { db } from "../src/engine/db";
import { STORES, databaseName, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: devices.turn.limited

/*
 * The person turns the network on as the active device of a device set (WISP 06 § When a device checks): the turn is
 * read before anything is dialled or published, and while that read is out the engine is in limited mode, so nothing
 * the person does in those seconds can publish before a good read says this device is still the active one.
 */

vi.mock("../src/devices/setup", async (original) => ({ ...(await original<typeof import("../src/devices/setup")>()), openTurnKeeper: vi.fn() }));

const transport: PkarrTransport = {
  publish: async () => {}, publishPayload: async () => {}, resolve: async () => null, describe: () => ({ protocol: "test", relays: [] }),
  turnRead: async () => [], turnPut: async () => [],
};
const chat = (): StoredLink => ({ id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 });

const nodes: GhostlyNode[] = [];
beforeEach(async () => {
  const stores = [STORES.settings, STORES.links, STORES.messages, STORES.services];
  await transact(stores, (s) => { for (const name of stores) s[name].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown().catch(() => {}); resetDeviceGates(); vi.restoreAllMocks(); });

describe("going online as the active device", () => {
  it("is limited while the turn is read, and goes online only once a good read says it is still the active one", async () => {
    await db.putSettings({ online: false } as never);
    await db.putLink(chat());
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
    nodes.push(node);
    const inner = node as unknown as Record<string, unknown>;
    const startLink = vi.spyOn(inner as unknown as { startLink(id: string): void }, "startLink").mockImplementation(() => {});
    vi.spyOn(inner as unknown as { startWallets(): Promise<void> }, "startWallets").mockResolvedValue();
    vi.spyOn(inner as unknown as { openStartedWallets(fresh: boolean): void }, "openStartedWallets").mockImplementation(() => {});
    vi.spyOn(inner as unknown as { startGroupEntries(): void }, "startGroupEntries").mockImplementation(() => {});
    vi.spyOn(inner as unknown as { prepareSpare(ms: number): void }, "prepareSpare").mockImplementation(() => {});
    vi.spyOn((inner as unknown as { did: { publishNow(): Promise<void> } }).did, "publishNow").mockResolvedValue();
    vi.spyOn((inner as unknown as { hold: { start(): void } }).hold, "start").mockImplementation(() => {});
    await node.start();
    replaceDeviceGate({ profile: databaseName(), state: "active", full: true, view: null });

    let answer: (outcome: { kind: string }) => void = () => {};
    vi.mocked(openTurnKeeper).mockResolvedValue({ check: () => new Promise((resolve) => { answer = resolve; }) } as never);
    const going = node.updateSettings({ settings: { online: true } });
    await vi.waitFor(() => expect(node.limited).toBe(true));
    // The read is out: nothing dialled, and the pages are told it is limited.
    expect(startLink).not.toHaveBeenCalled();
    expect(node.getState().limited).toBe(true);
    answer({ kind: "start" });
    await going;
    expect(node.limited).toBe(false);
    expect(startLink).toHaveBeenCalledOnce();
  });
});
