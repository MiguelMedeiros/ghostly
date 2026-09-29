import { describe, expect, it } from "vitest";
import { LATER_MS, backupDue, forgetWallet, mainnetBalances, markBackedUp, observeBalances, putOff, type BackupReminders, type WalletBalance } from "../src/shared/backupReminder";
import type { NetworkWalletsView, WalletInstanceView } from "../src/shared/types";
// covers: wallet.backup-reminder

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 29);
const wallet = (type: WalletInstanceView["type"], network: WalletInstanceView["network"] = "mainnet"): WalletInstanceView => ({ id: `${type}:${network}`, type, network, config: {} });
const cashu = wallet("cashu"), usdt = wallet("usdt"), testCashu = wallet("cashu", "testnet");
const held = (w: WalletInstanceView, balance: bigint): WalletBalance => ({ id: w.id, type: w.type, network: w.network, balance });
/** The records after the balances were seen at `now`. */
const see = (records: BackupReminders, balances: WalletBalance[], now: number) => observeBalances(records, balances, now).records;

describe("the backup reminder", () => {
  it("asks once a Mainnet wallet first holds money, never before", () => {
    let records = see({}, [held(cashu, 0n), held(usdt, 0n)], T0);
    expect(backupDue(records, [cashu, usdt], T0)).toEqual([]);
    records = see(records, [held(cashu, 50n), held(usdt, 0n)], T0 + 1);
    expect(backupDue(records, [cashu, usdt], T0 + 1)).toEqual([{ id: "cashu:mainnet", type: "cashu", backup: "profile" }]);
    records = see(records, [held(cashu, 50n), held(usdt, 2_000_000n)], T0 + 2);
    expect(backupDue(records, [cashu, usdt], T0 + 2)).toEqual([
      { id: "cashu:mainnet", type: "cashu", backup: "profile" },
      { id: "usdt:mainnet", type: "usdt", backup: "phrase" },
    ]);
    // The first time is kept: money going out and in again does not move it.
    expect(see(records, [held(cashu, 0n)], T0 + 3)["cashu:mainnet"].funded).toBe(T0 + 1);
  });

  it("never asks about test coins, nor about a wallet whose money is not on this device", () => {
    const { records, changed } = observeBalances({}, [held(testCashu, 10_000n), held(wallet("lightning"), 500n), held(wallet("bitcoin"), 500n)], T0);
    expect(changed).toBe(false);
    expect(backupDue(records, [testCashu], T0)).toEqual([]);
    // A record that somehow names a Testnet wallet still asks nothing.
    expect(backupDue({ "cashu:testnet": { funded: T0 } }, [testCashu], T0)).toEqual([]);
  });

  it("asks only about wallets the profile still has", () => {
    const records = see({}, [held(usdt, 1n)], T0);
    expect(backupDue(records, [cashu], T0)).toEqual([]);
    expect(forgetWallet(records, "usdt:mainnet")).toEqual({});
  });

  it("ends once the phrase is shown or a backup file made, before or after the money came", () => {
    let records = see({}, [held(usdt, 1n)], T0);
    records = markBackedUp(records, { kind: "phrase", id: "usdt:mainnet" }, T0 + 1);
    expect(backupDue(records, [usdt], T0 + 1)).toEqual([]);
    // Shown before any money: the phrase does not change with the money, so it never asks.
    let early = markBackedUp({}, { kind: "phrase", id: "usdt:mainnet" }, T0);
    early = see(early, [held(usdt, 5n)], T0 + 1);
    expect(backupDue(early, [usdt], T0 + 1)).toEqual([]);
  });

  it("ends with a profile backup made after the money arrived, for every wallet that holds some then", () => {
    let records = see({}, [held(cashu, 21n), held(usdt, 1n)], T0);
    records = markBackedUp(records, { kind: "profile" }, T0 + 1);
    expect(backupDue(records, [cashu, usdt], T0 + 1)).toEqual([]);
    // A profile backup made before a wallet held anything does not cover money that comes later.
    let before = markBackedUp({}, { kind: "profile" }, T0);
    before = see(before, [held(cashu, 21n)], T0 + 1);
    expect(backupDue(before, [cashu], T0 + 1)).toEqual([{ id: "cashu:mainnet", type: "cashu", backup: "profile" }]);
  });

  it("Later: back on the next receive", () => {
    let records = see({}, [held(cashu, 50n)], T0);
    records = putOff(records, "cashu:mainnet", 50n, T0 + 1);
    expect(backupDue(records, [cashu], T0 + 2)).toEqual([]);
    // Nothing new in: still put off.
    records = see(records, [held(cashu, 50n)], T0 + 3);
    expect(backupDue(records, [cashu], T0 + 3)).toEqual([]);
    records = see(records, [held(cashu, 80n)], T0 + 4);
    expect(backupDue(records, [cashu], T0 + 4)).toHaveLength(1);
  });

  it("Later: a spend lowers the mark, so the next receive still brings it back", () => {
    let records = see({}, [held(cashu, 50n)], T0);
    records = putOff(records, "cashu:mainnet", 50n, T0 + 1);
    records = see(records, [held(cashu, 10n)], T0 + 2);
    expect(records["cashu:mainnet"].laterBalance).toBe("10");
    records = see(records, [held(cashu, 30n)], T0 + 3);
    expect(backupDue(records, [cashu], T0 + 3)).toHaveLength(1);
  });

  it("Later: back after three days with nothing new", () => {
    let records = see({}, [held(usdt, 1n)], T0);
    records = putOff(records, "usdt:mainnet", 1n, T0);
    expect(backupDue(records, [usdt], T0 + LATER_MS - 1)).toEqual([]);
    expect(backupDue(records, [usdt], T0 + 3 * DAY)).toHaveLength(1);
  });

  it("Later comes back once: the second Later ends it", () => {
    let records = see({}, [held(cashu, 50n)], T0);
    records = putOff(records, "cashu:mainnet", 50n, T0);
    records = see(records, [held(cashu, 60n)], T0 + 1);
    expect(backupDue(records, [cashu], T0 + 1)).toHaveLength(1);
    records = putOff(records, "cashu:mainnet", 60n, T0 + 2);
    records = see(records, [held(cashu, 500n)], T0 + 3);
    expect(backupDue(records, [cashu], T0 + 30 * DAY)).toEqual([]);
  });

  it("reads the Mainnet balances from the views: Cashu's sats, USDT's token units, nothing from a locked wallet", () => {
    const view = { mints: [], balance: 42, history: [], feesPaid: 0,
      usdt: { configured: true, locked: false, balance: "1500000", gasBalance: "0" },
      ark: { configured: true, locked: true, balance: 7 } } as unknown as NetworkWalletsView;
    expect(mainnetBalances([cashu, usdt, wallet("arkade"), testCashu], view)).toEqual([held(cashu, 42n), held(usdt, 1_500_000n)]);
    expect(mainnetBalances([cashu], undefined)).toEqual([]);
  });
});
