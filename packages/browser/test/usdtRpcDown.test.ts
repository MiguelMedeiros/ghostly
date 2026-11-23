import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsdtWallet } from "../src/engine/paymentAdapters/usdtWallet";
// covers: wallet.usdt.create, app.idle

/*
 * A USDT wallet whose RPC stops answering (down, rate-limited, the device offline) read its balance every 8 s for as
 * long as the app ran: about 1,500 failed requests an hour against the public RPC every new profile shares, with each
 * failed read asked twice. One that could not connect at all tried again every 30 s. Both now wait twice as long after
 * each failure, up to 5 minutes; an answer, and the app coming back (`wake`), go back to the usual pace at once.
 */

const HOUR = 3_600_000;
const rpc = { up: true, reads: 0 };

function usdtWallet() {
  const wallet = new UsdtWallet("testnet", vi.fn());
  Object.assign(wallet, { adapter: {
    config: { network: "sepolia", chainId: 11155111, provider: "http://127.0.0.1:8545", token: "0x1111111111111111111111111111111111111111", decimals: 6 },
    address: async () => "0xme",
    balances: async () => { rpc.reads++; if (!rpc.up) throw new Error("RPC unavailable"); return { balance: "1000", gasBalance: "0" }; },
    dispose: async () => {},
  } });
  return wallet;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); rpc.up = true; rpc.reads = 0; });
afterEach(() => { vi.useRealTimers(); });

it("reads the balance every 8 s while the RPC answers", async () => {
  const wallet = usdtWallet();
  await wallet.refresh();
  await vi.advanceTimersByTimeAsync(80_000);
  expect(rpc.reads).toBe(11);
  await wallet.lock();
});

it("reads less and less often while the RPC does not answer, and at the usual pace once it does", async () => {
  const wallet = usdtWallet();
  rpc.up = false;
  await wallet.refresh();
  await vi.advanceTimersByTimeAsync(HOUR);
  // 8 s, 16 s, 32 s… up to 5 min: 450 reads an hour at the fixed 8 s.
  expect(rpc.reads).toBeLessThanOrEqual(20);
  expect(wallet.view.error).toMatch(/RPC unavailable/);
  rpc.up = true;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(wallet.view.error).toBeUndefined();
  rpc.reads = 0;
  await vi.advanceTimersByTimeAsync(80_000);
  expect(rpc.reads).toBe(10);
  await wallet.lock();
});

it("reads at once when the app comes back, after a failed read", async () => {
  const wallet = usdtWallet();
  rpc.up = false;
  await wallet.refresh();
  await vi.advanceTimersByTimeAsync(HOUR);
  rpc.up = true;
  const before = rpc.reads;
  wallet.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(rpc.reads).toBe(before + 1);
  expect(wallet.view.error).toBeUndefined();
  // A wallet that reads fine is not read again by a wake: the tab coming to the front is not news for the chain.
  wallet.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(rpc.reads).toBe(before + 1);
  await wallet.lock();
});

it("tries to connect less and less often while the RPC does not answer, and at once when the app comes back", async () => {
  const wallet = usdtWallet();
  Object.assign(wallet, { adapter: undefined, saved: { deviceKey: "key", config: {}, seed: {} } });
  const unlock = vi.spyOn(wallet, "unlock").mockRejectedValue(new Error("RPC unavailable"));
  await wallet.ensureReady();
  await vi.advanceTimersByTimeAsync(HOUR);
  // 30 s, 60 s, 120 s… up to 5 min: 120 attempts an hour at the fixed 30 s.
  expect(unlock.mock.calls.length).toBeLessThanOrEqual(16);
  const before = unlock.mock.calls.length;
  wallet.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(unlock).toHaveBeenCalledTimes(before + 1);
  await wallet.stop();
});
