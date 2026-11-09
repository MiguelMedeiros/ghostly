import { afterEach, describe, expect, it, vi } from "vitest";
import { WAKE_GAP_MAX_MS, WAKE_LATE_MS, WAKE_TICK_MS, addressesKey, watchWake } from "../src/runtime/wakeWatch";
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
    // Back seconds later, and another change after it: one wake once the minute since the last one is over.
    w.move("en1/10.0.0.7");
    await w.tick();
    w.move("en0/192.168.0.10");
    await w.tick();
    expect(w.wakes).toEqual(["network"]);
    for (let i = 0; i < 2; i++) await w.tick();
    expect(w.wakes).toEqual(["network"]);
    await w.tick();
    expect(w.wakes).toEqual(["network", "network"]);
    for (let i = 0; i < 20; i++) await w.tick();
    expect(w.wakes).toEqual(["network", "network"]);
    w.stop();
  });

  it("wakes at once for a change after a quiet minute", async () => {
    const w = setup();
    w.move("en1/10.0.0.7");
    await w.tick();
    for (let i = 0; i < 6; i++) await w.tick();
    w.move("en0/192.168.0.10");
    await w.tick();
    expect(w.wakes).toEqual(["network", "network"]);
    w.stop();
  });

  it("spaces the wakes of a network that flaps every tick, and wakes at once again after it settles", async () => {
    const w = setup();
    const at: number[] = [];
    for (let i = 1; i <= 60; i++) {
      w.move(i % 2 ? "en0/10.0.0.2" : "en0/10.0.0.3");
      const before = w.wakes.length;
      await w.tick();
      if (w.wakes.length > before) at.push(i * WAKE_TICK_MS);
    }
    // Before: 60 wakes in these 10 minutes. The first at once, then 1, 2 and 4 minutes later.
    expect(at).toEqual([10_000, 70_000, 190_000, 430_000]);
    expect(new Set(w.wakes)).toEqual(new Set(["network"]));
    // It stops flapping: the change still held wakes when its gap (8 minutes) is over, then a whole gap with no change.
    for (let i = 0; i < 2 * WAKE_GAP_MAX_MS / WAKE_TICK_MS; i++) await w.tick();
    expect(w.wakes).toHaveLength(5);
    w.move("en1/192.168.1.4");
    await w.tick();
    expect(w.wakes).toHaveLength(6);
    w.stop();
  });

  it("a sleep wakes at once, a network change just held or not", async () => {
    const w = setup();
    w.move("en1/10.0.0.7");
    await w.tick();
    w.move("en0/192.168.0.10");
    await w.tick();
    w.sleep(10 * 60_000);
    await w.tick();
    expect(w.wakes).toEqual(["network", "sleep"]);
    for (let i = 0; i < 12; i++) await w.tick();
    expect(w.wakes).toEqual(["network", "sleep"]);
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

  it("leaves out the machine's own virtual bridges: a container network made or removed is not another network", () => {
    const v4 = (address: string) => [{ address, family: "IPv4" as const, internal: false, netmask: "255.255.0.0", mac: "02:42:ac:11:00:01", cidr: null }];
    const key = addressesKey({
      eno1: v4("192.168.0.10"),
      tailscale0: v4("100.81.12.5"),
      docker0: v4("172.17.0.1"),
      "br-412c27c5fe1f": v4("172.20.0.1"),
      virbr0: v4("192.168.122.1"),
      cni0: v4("10.88.0.1"),
      vboxnet0: v4("192.168.56.1"),
      vmnet8: v4("172.16.5.1"),
      bridge100: v4("192.168.64.1"),
      "vEthernet (WSL)": v4("172.29.80.1"),
      "vEthernet (Default Switch)": v4("172.30.16.1"),
    });
    expect(key).toBe("eno1/192.168.0.10,tailscale0/100.81.12.5");
  });

  it("a Hyper-V switch bound to the network card keeps its address in the key", () => {
    const key = addressesKey({
      "vEthernet (External)": [{ address: "192.168.0.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:15:5d:00:00:01", cidr: null }],
    });
    expect(key).toBe("vEthernet (External)/192.168.0.20");
  });
});
