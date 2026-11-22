import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startRelay as startHyperdhtRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";
import { startRelay as startPushRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send, transport.hyperdht-relay

// GHOSTLY_RELAY_PROXIES=2 behind one proxy that appends the address it saw (nginx's `$proxy_add_x_forwarded_for`): an
// app writes no X-Forwarded-For, so its request carries the proxy's one entry. A client writing its own entry first
// gets two, and counted 2 from the end it would be counted by an address it chose, a new one per request.
describe("the relays behind fewer proxies than GHOSTLY_RELAY_PROXIES (infra/services)", () => {
  it("the push relay counts a client writing its own X-Forwarded-For by the proxy's entry once a request came with fewer", async () => {
    const relay = await startPushRelay({ proxies: 2 });
    const post = (forwarded: string) => fetch(`http://127.0.0.1:${relay.port}/`, { method: "POST", headers: { "X-Forwarded-For": forwarded }, body: "{}" }).then((response) => response.status);
    try {
      expect(await post("198.51.100.70")).not.toBe(429);
      const written: number[] = [];
      for (let i = 0; i < 40; i++) written.push(await post(`10.7.${i}.1, 198.51.100.60`));
      expect(written.filter((status) => status === 429)).toHaveLength(10);
      // Each honest client by its own address, not all as the proxy's.
      const honest: number[] = [];
      for (let i = 0; i < 39; i++) honest.push(await post(`198.51.100.${71 + (i % 3)}`));
      expect(honest.filter((status) => status === 429)).toHaveLength(0);
    } finally {
      await relay.close();
    }
  });

  it("the HyperDHT relay holds a client writing its own X-Forwarded-For to clientsPerAddress once an upgrade came with fewer", async () => {
    const relay = await startHyperdhtRelay({ testnet: 3, proxies: 2, limits: { clientsPerAddress: 2 } });
    const sockets: WebSocket[] = [];
    const open = (forwarded: string) => new Promise<number>((resolve) => {
      const ws = new WebSocket(relay.url, { headers: { "x-forwarded-for": forwarded } });
      sockets.push(ws);
      ws.once("open", () => resolve(101));
      ws.once("unexpected-response", (_, response) => resolve(response.statusCode ?? 0));
      ws.once("error", () => resolve(0));
    });
    try {
      expect(await open("198.51.100.70")).toBe(101);
      const written: number[] = [];
      for (let i = 0; i < 6; i++) written.push(await open(`10.7.${i}.1, 198.51.100.60`));
      expect(written).toEqual([101, 101, 429, 429, 429, 429]);
    } finally {
      for (const ws of sockets) ws.terminate();
      await relay.close();
    }
  }, 60_000);
});
