import { afterEach, describe, expect, it, vi } from "vitest";
import { WAKE_LATE_MS, WAKE_TICK_MS, addressesKey, watchWake } from "../src/runtime/wakeWatch";
// covers: headless.daemon

/**
 * A daemon hears no `visibilitychange` or `online`: the watch calls the engine's wake when the machine comes back from
 * sleep (a tick far later than due) or moves to another network (its own addresses changed), and stays quiet otherwise.
 */

afterEach(() => { vi.useRealTimers(); });

function setup(initial = "en0/192.168.0.10") {
  vi.useFakeTimers();
  let clock = 1_000_000;
  let addresses = initial;
  const wakes: string[] = [];
  const stop = watchWake((why) => wakes.push(why), { now: () => clock, addresses: () => addresses });
  return {
    wakes, stop,
    tick: async (ms = WAKE_TICK_MS) => { clock += ms; await vi.advanceTimersByTimeAsync(WAKE_TICK_MS); },
    sleep: (ms: number) => { clock += ms; },
    move: (to: string) => { addresses = to; },
  };
}

describe("wake watch", () => {
  it("stays quiet while the machine runs on the same network", async () => {
    const w = setup();
    for (let i = 0; i < 30; i++) await w.tick();
    expect(w.wakes).toEqual([]);
    w.stop();
  });

  it("wakes the engine once after a sleep", async () => {
    const w = setup();
    await w.tick();
    w.sleep(10 * 60_000);
    await w.tick();
    await w.tick();
    expect(w.wakes).toEqual(["sleep"]);
    w.stop();
  });

  it("does not take a busy event loop for a sleep", async () => {
    const w = setup();
    await w.tick(WAKE_TICK_MS + WAKE_LATE_MS - 1);
    expect(w.wakes).toEqual([]);
    w.stop();
  });

  it("wakes the engine when the machine's addresses change, and when the network comes back", async () => {
    const w = setup();
    w.move("en1/10.0.0.7");
    await w.tick();
    expect(w.wakes).toEqual(["network"]);
    w.move("");
    await w.tick();
    expect(w.wakes).toEqual(["network"]);
    w.move("en1/10.0.0.7");
    await w.tick();
    expect(w.wakes).toEqual(["network", "network"]);
    w.move("en0/192.168.0.10");
    await w.tick();
    expect(w.wakes).toEqual(["network", "network", "network"]);
    w.stop();
  });

  it("stops ticking once stopped", async () => {
    const w = setup();
    w.stop();
    w.move("en1/10.0.0.7");
    await w.tick();
    expect(w.wakes).toEqual([]);
  });

  it("keys a network by its non-internal addresses, link-local IPv6 left out", () => {
    const key = addressesKey({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "00:00:00:00:00:00", cidr: null }],
      en0: [
        { address: "fe80::1", family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff::", mac: "aa:bb:cc:dd:ee:ff", cidr: null, scopeid: 4 },
        { address: "192.168.0.10", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "aa:bb:cc:dd:ee:ff", cidr: null },
      ],
    });
    expect(key).toBe("en0/192.168.0.10");
  });
});
