import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { addressKey, addressOf, startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

const req = (headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress: "10.0.0.1" } });

describe("the HyperDHT relay's count of a client's address (infra/services/hyperdht-relay)", () => {
  it("behind proxies, counts the X-Forwarded-For entry that many from the end, not the ones the client writes", () => {
    expect(addressOf(req({ "x-forwarded-for": "10.9.1.1, 203.0.113.7" }), { proxies: 1 })).toBe("203.0.113.7");
    expect(addressOf(req({ "x-forwarded-for": "10.9.2.1, 203.0.113.7" }), { proxies: 1 })).toBe("203.0.113.7");
    expect(addressOf(req({ "x-forwarded-for": "9.9.9.9, 203.0.113.7, 172.16.0.2" }), { proxies: 2 })).toBe("203.0.113.7");
    expect(addressOf(req(), { proxies: 1 })).toBe("10.0.0.1");
    expect(addressOf(req({ "x-forwarded-for": "203.0.113.7" }), { proxies: 2 })).toBe("10.0.0.1");
  });

  it("takes CF-Connecting-IP only when told it is behind Cloudflare, and no header at all when told nothing", () => {
    const spoofed = req({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2" });
    expect(addressOf(spoofed)).toBe("10.0.0.1");
    expect(addressOf(spoofed, { proxies: 1 })).toBe("198.51.100.2");
    expect(addressOf(spoofed, { cloudflare: true })).toBe("198.51.100.1");
    expect(addressOf(req(), { cloudflare: true })).toBe("10.0.0.1");
  });

  it("counts an IPv6 client by its /64 and an IPv4-mapped one as its IPv4 address", () => {
    expect(addressKey("2001:db8:1:2:aaaa::1")).toBe(addressKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
    expect(addressKey("2001:db8:1:2::14")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:3::1")).not.toBe(addressKey("2001:db8:1:2::1"));
    expect(addressKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(addressKey("198.51.100.7")).toBe("198.51.100.7");
  });

  it("refuses a client past clientsPerAddress when each one comes from a new address in the same IPv6 /64", async () => {
    const relay = await startRelay({ testnet: 3, proxies: 1, limits: { clientsPerAddress: 3 } });
    const sockets: WebSocket[] = [];
    const open = (from: string) => new Promise<number>((resolve) => {
      const ws = new WebSocket(relay.url, { headers: { "x-forwarded-for": from } });
      sockets.push(ws);
      ws.once("open", () => resolve(101));
      ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      ws.once("error", () => resolve(0));
    });
    try {
      const statuses = [];
      for (let n = 1; n <= 4; n++) statuses.push(await open(`2001:db8:1:2::${n.toString(16)}`));
      expect(statuses).toEqual([101, 101, 101, 429]);
      expect(await open("2001:db8:1:3::1")).toBe(101);
    } finally {
      for (const ws of sockets) ws.terminate();
      await relay.close();
    }
  }, 30_000);
});
