import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type PkarrTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
// covers: devices.enroll

/*
 * The engine's side of adding a device (WISP 06): what it refuses to give up as a standby, and how it stops when
 * another device took the turn while it ran. Nothing leaves the process.
 */

const transport: PkarrTransport = {
  publish: async () => {}, publishPayload: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }),
  turnRead: async () => [], turnPut: async () => [],
};
const nodes: GhostlyNode[] = [];
function node() {
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onDeviceGate: vi.fn() };
  const made = new GhostlyNode(events, { transport, automaticWallets: false });
  nodes.push(made);
  return { node: made, events, inner: made as unknown as Record<string, unknown> };
}
afterEach(() => { nodes.splice(0); vi.restoreAllMocks(); });

describe("a running active device that another device replaced", () => {
  it("stops without a goodbye to any contact and publishes nothing more", async () => {
    const { node: n, events, inner } = node();
    const link = { depart: vi.fn(), stop: vi.fn(async () => {}) };
    (inner.links as Map<string, unknown>).set("chat-1", { stored: { id: "chat-1" }, link });
    const emit = vi.spyOn(inner as unknown as { emitState(): void }, "emitState");
    await (inner as unknown as { stopReplaced(view: unknown): Promise<void> }).stopReplaced({ state: "superseded", activeDevice: "Phone" });
    expect(events.onDeviceGate).toHaveBeenCalledWith({ state: "superseded", activeDevice: "Phone" });
    expect(link.depart).not.toHaveBeenCalled();
    // Stopped without announcing: no departure in the link's packets either.
    expect(link.stop).toHaveBeenCalledWith(false);
    // The pages hear nothing more of this engine.
    (inner as unknown as { emitState(): void }).emitState();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events.onState).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalled();
    // A later stop (the page going away) stays quiet too.
    await n.shutdown();
    expect(link.depart).not.toHaveBeenCalled();
  });

  it("an ordinary stop still says goodbye", async () => {
    const { node: n, inner } = node();
    const link = { depart: vi.fn(), stop: vi.fn(async () => {}) };
    (inner.links as Map<string, unknown>).set("chat-1", { stored: { id: "chat-1" }, link });
    await n.shutdown();
    expect(link.depart).toHaveBeenCalled();
    expect(link.stop).toHaveBeenCalledWith(true);
  });
});

describe("joining a profile in place of the one this device runs", () => {
  const refuse = async (setup: (inner: Record<string, unknown>) => void) => {
    const { node: n, inner } = node();
    (inner as { settings: { online: boolean } }).settings.online = true;
    setup(inner);
    await expect(n.deviceEnrollJoin({ code: "ghostly1zx", name: "Phone" })).rejects.toThrow(/^enroll-in-use:/);
  };

  it("is refused when that profile holds an identity, money, a payment, or a wallet with keys of its own", async () => {
    const view = (patch: Record<string, unknown>) => (inner: Record<string, unknown>) => { inner.walletView = { mints: [], balance: 0, history: [], feesPaid: 0, ...patch }; };
    await refuse((inner) => { vi.spyOn((inner.identities as { views(): unknown[] }), "views").mockReturnValue([{ id: "x" }]); });
    await refuse(view({ balance: 5 }));
    await refuse(view({ history: [{ id: "p" }] }));
    await refuse(view({ wallets: [{ id: "w", type: "ark", network: "testnet", config: {} }] }));
    await refuse(view({ networks: { mainnet: { balance: 0, history: [{ id: "p" }] }, testnet: { balance: 0, history: [] } } }));
    await refuse((inner) => { (inner.links as Map<string, unknown>).set("chat", { stored: { id: "chat", seedB64: createIdentity().seedB64 } }); });
  });

  it("is not refused for the wallets a new profile gets by itself, empty", async () => {
    const { node: n, inner } = node();
    (inner as { settings: { online: boolean } }).settings.online = true;
    inner.walletView = { mints: [], balance: 0, history: [], feesPaid: 0, wallets: [{ id: "c", type: "cashu", network: "mainnet", config: {} }, { id: "u", type: "usdt", network: "mainnet", config: {} }] };
    // Past the check: the code is what is refused now.
    await expect(n.deviceEnrollJoin({ code: "ghostly1zx", name: "Phone" })).rejects.toThrow(/^enroll-(typo|not-ghostly|damaged):/);
  });
});
