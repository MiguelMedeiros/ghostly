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

/** When each read happened, as gaps in seconds. */
function readGaps(times: number[]) { return times.slice(1).map((t, i) => (t - times[i]) / 1000); }

it("waits 8, 16, 32 s… up to 5 min between failed reads, and starts again at 8 s after an answer", async () => {
  const times: number[] = [];
  const wallet = usdtWallet();
  const balances = (wallet.adapter as unknown as { balances: () => Promise<unknown> }).balances;
  Object.assign(wallet.adapter!, { balances: async () => { times.push(Date.now()); return balances(); } });
  rpc.up = false;
  await wallet.refresh();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(readGaps(times).slice(0, 9)).toEqual([8, 16, 32, 64, 128, 256, 300, 300, 300]);
  rpc.up = true;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  rpc.up = false; times.length = 0;
  await vi.advanceTimersByTimeAsync(8_000 + 8_000 + 16_000);
  // The first read after the outage is a fresh failure: 8 s, then 16 s, not the 5 min it had reached.
  expect(readGaps(times)).toEqual([8, 16]);
  await wallet.lock();
});

it("a wake whose read fails starts the ramp again at 8 s", async () => {
  const times: number[] = [];
  const wallet = usdtWallet();
  const balances = (wallet.adapter as unknown as { balances: () => Promise<unknown> }).balances;
  Object.assign(wallet.adapter!, { balances: async () => { times.push(Date.now()); return balances(); } });
  rpc.up = false;
  await wallet.refresh();
  await vi.advanceTimersByTimeAsync(HOUR);
  times.length = 0;
  wallet.wake();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(readGaps(times)).toEqual([8]);
  await wallet.lock();
});

it("one network's dead RPC leaves the other network's wallet at the 8 s pace", async () => {
  const dead = usdtWallet(), alive = new UsdtWallet("mainnet", vi.fn());
  let aliveReads = 0;
  Object.assign(alive, { adapter: { ...dead.adapter!, balances: async () => { aliveReads++; return { balance: "1", gasBalance: "0" }; } } });
  rpc.up = false;
  await dead.refresh(); await alive.refresh();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(aliveReads).toBe(76);
  // And the answers of the live one do not reset the dead one's wait: 0, 8, 24, 56, 120, 248, 504 s.
  expect(rpc.reads).toBe(7);
  await dead.lock(); await alive.lock();
});

it("waits 30, 60, 120, 240 s, then 5 min between failed connects, and 30 s again after a good one", async () => {
  const wallet = usdtWallet();
  Object.assign(wallet, { adapter: undefined, saved: { deviceKey: "key", config: {}, seed: {} } });
  const times: number[] = [];
  let up = false;
  const unlock = vi.spyOn(wallet, "unlock").mockImplementation(async () => { times.push(Date.now()); if (!up) throw new Error("RPC unavailable"); });
  await wallet.ensureReady();
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(readGaps(times).slice(0, 7)).toEqual([30, 60, 120, 240, 300, 300, 300]);
  up = true;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  // Connected, then dropped again (stand-in: still no adapter): the next failure waits 30 s, not 5 min.
  up = false; times.length = 0;
  await wallet.ensureReady();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(readGaps(times)).toEqual([30]);
  expect(unlock).toHaveBeenCalled();
  await wallet.stop();
});

it("a lock starts the connect pace again: the next failed connect waits 30 s, not 5 min", async () => {
  const wallet = usdtWallet();
  Object.assign(wallet, { adapter: undefined, saved: { deviceKey: "key", config: {}, seed: {} } });
  const times: number[] = [];
  vi.spyOn(wallet, "unlock").mockImplementation(async () => { times.push(Date.now()); throw new Error("RPC unavailable"); });
  await wallet.ensureReady();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  await wallet.lock();
  times.length = 0;
  await wallet.ensureReady();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(readGaps(times)).toEqual([30]);
  await wallet.stop();
});
