import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArkWallet } from "../src/engine/paymentAdapters/arkWallet";
import { BarkWallet } from "../src/engine/paymentAdapters/barkWallet";
import { SparkWallet } from "../src/engine/paymentAdapters/sparkWallet";
// covers: wallet.ark.create, wallet.bark.create, wallet.spark.create, app.idle

/*
 * An Ark, Bark or Spark wallet whose server stops answering (down, the device offline) was refreshed every 10 s for as
 * long as the app ran: 360 refreshes an hour, each several failed requests, per wallet and per network. One that could
 * not connect tried again every 30 s. Both now wait twice as long after each failure, up to 5 minutes; an answer, and
 * the app coming back (`wake`), go back to the usual pace at once.
 */

const HOUR = 3_600_000;
const server = { up: true, reads: 0 };
const balance = async <T>(value: T) => { server.reads++; if (!server.up) throw new Error("server unavailable"); return value; };
const answer = async <T>(value: T) => { if (!server.up) throw new Error("server unavailable"); return value; };

type Wallet = ArkWallet | BarkWallet | SparkWallet;
interface Kind { name: string; wallet: () => Wallet; connect: (wallet: Wallet) => string }

const kinds: Kind[] = [
  {
    name: "Ark",
    wallet: () => Object.assign(new ArkWallet("testnet", vi.fn()), { adapter: {
      config: { network: "mutinynet", provider: "http://127.0.0.1:7070" },
      address: async () => "tark1me", boardingAddress: async () => "tb1me",
      balances: () => balance({ balance: 1_000, incoming: 0 }),
      expired: () => answer({ recoverable: 0, sweeping: 0, small: 0 }),
      dispose: async () => {},
    } }),
    // A wallet with a device key opens by itself.
    connect: (wallet) => { Object.assign(wallet, { adapter: undefined, saved: { deviceKey: "key", config: {}, seed: {} } }); return "unlock"; },
  },
  {
    name: "Bark",
    wallet: () => Object.assign(new BarkWallet("testnet", vi.fn()), { lastMaintenance: Infinity, adapter: {
      config: { network: "signet", provider: "http://127.0.0.1:3535" },
      address: async () => "tark1me", onchainAddress: async () => "tb1me",
      sync: () => answer(undefined),
      balance: () => balance({ spendableSats: 1_000, pendingInRoundSats: 0, pendingBoardSats: 0, pendingLightningSendSats: 0, claimableLightningReceiveSats: 0, pendingExitSats: 0 }),
      onchainBalance: () => answer({ totalSats: 0 }), expiry: () => answer(undefined),
      dispose: async () => {},
    } }),
    connect: (wallet) => { Object.assign(wallet, { adapter: undefined, saved: { config: {} } }); return "open"; },
  },
  {
    name: "Spark",
    wallet: () => Object.assign(new SparkWallet("testnet", vi.fn()), { adapter: {
      address: async () => "sparkrt1me",
      balance: () => balance(1_000), history: () => answer([]),
      close: async () => {},
    } }),
    connect: (wallet) => { Object.assign(wallet, { adapter: undefined, saved: { network: "regtest" } }); return "open"; },
  },
];

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); vi.spyOn(console, "warn").mockImplementation(() => {}); server.up = true; server.reads = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(kinds)("$name", ({ wallet: make, connect }) => {
  it("refreshes every 10 s while its server answers", async () => {
    const wallet = make();
    await wallet.refresh();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(server.reads).toBe(11);
    await wallet.lock();
  });

  it("refreshes less and less often while its server does not answer, and at the usual pace once it does", async () => {
    const wallet = make();
    server.up = false;
    await wallet.refresh();
    await vi.advanceTimersByTimeAsync(HOUR);
    // 10 s, 20 s, 40 s… up to 5 min: 360 refreshes an hour at the fixed 10 s.
    expect(server.reads).toBeLessThanOrEqual(20);
    expect(wallet.view.error).toMatch(/Could not read the .*balance/);
    server.up = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(wallet.view.error).toBeUndefined();
    server.reads = 0;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(server.reads).toBe(10);
    await wallet.lock();
  });

  it("refreshes at once when the app comes back, after a failed refresh", async () => {
    const wallet = make();
    server.up = false;
    await wallet.refresh();
    await vi.advanceTimersByTimeAsync(HOUR);
    server.up = true;
    const before = server.reads;
    wallet.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.reads).toBe(before + 1);
    expect(wallet.view.error).toBeUndefined();
    // A wallet that reads fine is not refreshed again by a wake: the tab coming to the front is no news for the server.
    wallet.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.reads).toBe(before + 1);
    await wallet.lock();
  });

  it("tries to connect less and less often while its server does not answer, and at once when the app comes back", async () => {
    const wallet = make();
    const opens = vi.spyOn(wallet as never, connect(wallet) as never).mockRejectedValue(new Error("server unavailable") as never);
    await wallet.ensureReady();
    await vi.advanceTimersByTimeAsync(HOUR);
    // 30 s, 60 s, 120 s… up to 5 min: 120 attempts an hour at the fixed 30 s.
    expect(opens.mock.calls.length).toBeLessThanOrEqual(16);
    const before = opens.mock.calls.length;
    wallet.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(opens).toHaveBeenCalledTimes(before + 1);
    await wallet.stop();
  });
});
