import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORES, openDb, transact } from "../src/shared/idb";
import type { NodeOptions } from "../src/engine/node";
// covers: wallet.instances.first-run

// Every server is faked: no test here reaches a mint, an Ethereum RPC or an Esplora server.
const inspect = vi.fn(async (config: object) => ({ ...config, decimals: 6, codeHash: "0xfixture" }));
vi.mock("../src/engine/paymentAdapters/usdt", () => ({
  UsdtAdapter: {
    inspect: (config: object) => inspect(config),
    connect: vi.fn(async (config: object) => ({ config, address: async () => "0x00000000000000000000000000000000000000aa", balances: async () => ({ balance: "0", gasBalance: "0" }), dispose: vi.fn() })),
  },
}));
const { GhostlyNode } = await import("../src/engine/node");
const { db } = await import("../src/engine/db");

const transport = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) } as never;
const running: InstanceType<typeof GhostlyNode>[] = [];

/** A peer on this profile's storage, its mints answering unless `mintsDown`. */
function peer(options: NodeOptions = {}, { mintsDown = false } = {}) {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, ...options });
  vi.spyOn(node["wallet"], "checkMint").mockImplementation(async (url: string) => {
    if (mintsDown) throw new Error(`Could not reach ${new URL(url).host}.`);
    return { url, name: new URL(url).host };
  });
  running.push(node);
  const wallets = () => node.getState().wallet.wallets?.map((w) => w.id) ?? [];
  return { node, wallets };
}

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No network in this test"); }));
  await openDb();
  await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); });
});
afterEach(async () => {
  for (const node of running.splice(0)) await node.shutdown();
  vi.unstubAllGlobals();
});

describe("a new profile's Mainnet wallets, made on first run", () => {
  it("made once in the background; one removed stays removed after a restart", async () => {
    const first = peer({ defaultWallets: true });
    await first.node.start();
    await vi.waitFor(() => expect(first.wallets()).toEqual(expect.arrayContaining(["cashu:mainnet", "usdt:mainnet"])));
    await vi.waitFor(() => expect(first.node.getState().wallet.setup).toBeUndefined());
    // On-chain has no Mainnet wallet here yet: it waits, and is no failure.
    expect(first.wallets().some((id) => id.startsWith("bitcoin"))).toBe(false);
    expect(first.node["settings"].walletSetup).toEqual({ left: ["bitcoin"] });

    await first.node.walletRemove({ type: "usdt", network: "mainnet" });
    await first.node.shutdown();
    const again = peer({ defaultWallets: true });
    const create = vi.spyOn(again.node, "walletCreate");
    await again.node.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(create).not.toHaveBeenCalled();
    expect(again.wallets()).not.toContain("usdt:mainnet");
  });

  it("the CLI, the tests and any host that does not ask make nothing, and remember nothing", async () => {
    const { node, wallets } = peer();
    const create = vi.spyOn(node, "walletCreate");
    await node.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(create).not.toHaveBeenCalled();
    expect(wallets()).toEqual([]);
    expect(node["settings"].walletSetup).toBeUndefined();
  });

  it("the host's switch says no (under test): nothing is made", async () => {
    const { node, wallets } = peer({ defaultWallets: async () => false });
    await node.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wallets()).toEqual([]);
  });

  it("a profile from before (settings stored) is never set up, even with no wallet", async () => {
    await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: false });
    const { node, wallets } = peer({ defaultWallets: true });
    await node.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wallets()).toEqual([]);
    expect(node["settings"].walletSetup).toBeUndefined();
  });

  it("a mint down: the page says why, the next start tries again quietly, and Try again makes it", async () => {
    const first = peer({ defaultWallets: true }, { mintsDown: true });
    await first.node.start();
    await vi.waitFor(() => expect(first.node.getState().wallet.setup?.running).toBe(false));
    expect(first.wallets()).toEqual(["usdt:mainnet"]);
    expect(first.node.getState().wallet.setup?.failed).toEqual([{ type: "cashu", network: "mainnet", reason: expect.stringContaining("Could not create the Mainnet Cashu wallet") }]);
    await first.node.shutdown();

    const second = peer({ defaultWallets: true }, { mintsDown: true });
    const create = vi.spyOn(second.node, "walletCreate");
    await second.node.start();
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ type: "cashu", network: "mainnet" }));
    await vi.waitFor(() => expect(second.node.getState().wallet.setup?.running).toBe(false));
    expect(create).toHaveBeenCalledTimes(1);

    vi.mocked(second.node["wallet"].checkMint).mockImplementation(async (url: string) => ({ url, name: new URL(url).host }));
    await second.node.walletSetupRetry({ type: "cashu" });
    expect(second.wallets()).toContain("cashu:mainnet");
    expect(second.node.getState().wallet.setup).toBeUndefined();
  });

  it("the record is the engine's: a settings patch cannot write it", async () => {
    const { node } = peer();
    await node.start();
    await node.updateSettings({ settings: { walletSetup: { left: ["cashu"] } } });
    expect(node["settings"].walletSetup).toBeUndefined();
  });
});
