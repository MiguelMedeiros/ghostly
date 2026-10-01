import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { NetworkWalletsView, WalletView } from "../src/shared/types";
// covers: wallet.backup-reminder

// The engine's side of the backup reminder: it records the first real money it sees, what a phrase shown or a
// backup file made ends, and "Later" and a profile backup through its call. Nothing here reaches a network.

const nodes: GhostlyNode[] = [];
function engine() {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  nodes.push(node);
  return node;
}
const empty = (patch: Partial<NetworkWalletsView> = {}): NetworkWalletsView => ({ mints: [], balance: 0, history: [], feesPaid: 0, ...patch });
/** A wallet view with a Mainnet Cashu wallet holding `sats` and a Mainnet USDT wallet holding `usdt` base units. */
function holding(node: GhostlyNode, sats: number, usdt = "0") {
  const mainnet = empty({ mints: [{ url: "https://mint.example", name: "m", balance: sats, info: null } as never], balance: sats,
    usdt: { configured: true, locked: false, balance: usdt, gasBalance: "0" } as never });
  const view: WalletView = { ...mainnet, networks: { mainnet, testnet: empty() },
    wallets: [{ id: "cashu:mainnet", type: "cashu", network: "mainnet", config: {} }, { id: "usdt:mainnet", type: "usdt", network: "mainnet", config: {} }] };
  node["walletView"] = view;
}
const stored = async () => (await db.getSettings()).backupReminders;

beforeEach(async () => { await transact([STORES.settings], (s) => s[STORES.settings].clear()); });
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); });

describe("the engine's backup reminders", () => {
  it("records the first real money it sees, once the profile's settings are read, and saves it with them", async () => {
    const node = engine();
    holding(node, 50);
    // Before start() read the settings, nothing is saved: a save then would write the defaults over them.
    await node["observeBackups"]();
    expect(await db.getSettings()).toEqual({});
    node["backupsLoaded"] = true;
    await node["observeBackups"]();
    expect((await stored())?.["cashu:mainnet"]?.funded).toEqual(expect.any(Number));
    expect(node["walletView"].backupReminders?.["cashu:mainnet"]?.funded).toEqual(expect.any(Number));
    expect((await stored())?.["usdt:mainnet"]).toBeUndefined();
  });

  it("a Mainnet phrase shown or a backup file made ends its wallet's reminder; a Testnet one records nothing", async () => {
    const node = engine();
    node["backupsLoaded"] = true;
    vi.spyOn(node["usdtWallets"].mainnet, "reveal").mockResolvedValue("word ".repeat(12).trim());
    vi.spyOn(node["usdtWallets"].testnet, "exportBackup").mockResolvedValue("{}");
    vi.spyOn(node["arkWallets"].mainnet, "exportBackup").mockResolvedValue("{}");
    await node.usdtReveal({ network: "mainnet" });
    await node.usdtExportBackup({ password: "a long password", network: "testnet" });
    await node.arkExportBackup({ password: "a long password", network: "mainnet" });
    const records = await stored();
    expect(records?.["usdt:mainnet"]?.backedUp).toEqual(expect.any(Number));
    expect(records?.["arkade:mainnet"]?.backedUp).toEqual(expect.any(Number));
    expect(records?.["usdt:testnet"]).toBeUndefined();
  });

  it("a phrase that could not be read ends nothing", async () => {
    const node = engine();
    node["backupsLoaded"] = true;
    vi.spyOn(node["usdtWallets"].mainnet, "reveal").mockRejectedValue(new Error("Wrong password"));
    await expect(node.usdtReveal({ network: "mainnet", password: "x" })).rejects.toThrow("Wrong password");
    expect(await stored()).toBeUndefined();
  });

  it("Later puts one wallet off with its balance then; a profile backup ends every funded one", async () => {
    const node = engine();
    node["backupsLoaded"] = true;
    holding(node, 50, "2000000");
    await node["observeBackups"]();
    await node.walletBackupReminder({ event: "later", wallet: "usdt:mainnet" });
    expect((await stored())?.["usdt:mainnet"]).toMatchObject({ laters: 1, laterBalance: "2000000" });
    await expect(node.walletBackupReminder({ event: "later", wallet: "bark:mainnet" })).rejects.toThrow("no such Mainnet wallet");
    await node.walletBackupReminder({ event: "profile" });
    const records = await stored();
    expect(records?.["cashu:mainnet"]?.backedUp).toEqual(expect.any(Number));
    expect(records?.["usdt:mainnet"]?.backedUp).toEqual(expect.any(Number));
  });

  it("a settings patch cannot write the reminders", async () => {
    const node = engine();
    await node.updateSettings({ settings: { nick: "Ann", backupReminders: { "cashu:mainnet": { funded: 1, backedUp: 2 } } } as never });
    expect(await stored()).toBeUndefined();
  });
});
