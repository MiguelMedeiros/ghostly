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

  it("counts an IPv4-mapped address as its IPv4 address however it is written", () => {
    expect(addressKey("::ffff:c000:201")).toBe("192.0.2.1");
    expect(addressKey("::ffff:c000:202")).toBe("192.0.2.2");
    expect(addressKey("0:0:0:0:0:ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(addressKey("0000:0000:0000:0000:0000:FFFF:C000:0201")).toBe("192.0.2.1");
    expect(addressKey("::FFFF:192.0.2.1")).toBe("192.0.2.1");
    expect(addressKey("::ffff:192.0.2.1%eth0")).toBe("192.0.2.1");
    expect(addressKey("[::ffff:c000:201]:443")).toBe("192.0.2.1");
    expect(addressKey("::ffff:0:c000:201")).toBe("0:0:0:0::/64");
    expect(addressKey("1::2:3:4:5:1.2.3.4")).toBe("1:0:2:3::/64");
  });

  it("counts an address a proxy wrote with its port, or in brackets, as the address alone", () => {
    expect(addressKey("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(addressKey("203.0.113.7:51235")).toBe("203.0.113.7");
    expect(addressKey("[2001:db8:1:2::1]:443")).toBe("2001:db8:1:2::/64");
    expect(addressKey("[2001:db8:1:2::1]")).toBe("2001:db8:1:2::/64");
    expect(addressKey("[::ffff:198.51.100.7]:51234")).toBe("198.51.100.7");
    expect(addressKey(addressOf(req({ "cf-connecting-ip": "198.51.100.1:443" }), { cloudflare: true }))).toBe("198.51.100.1");
  });

  it("refuses a client past clientsPerAddress behind a proxy that writes its port, though each connection has a new one", async () => {
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
      for (let n = 1; n <= 4; n++) statuses.push(await open(`203.0.113.7:5000${n}`));
      expect(statuses).toEqual([101, 101, 101, 429]);
      expect(await open("[2001:db8:1:2::1]:443")).toBe(101);
    } finally {
      for (const ws of sockets) ws.terminate();
      await relay.close();
    }
  }, 30_000);

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

  it("counts IPv4 clients apart when the proxy writes their IPv4-mapped address in hex", async () => {
    const relay = await startRelay({ testnet: 3, proxies: 1, limits: { clientsPerAddress: 2 } });
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
      for (let n = 1; n <= 4; n++) statuses.push(await open(`::ffff:c000:20${n}`));
      expect(statuses).toEqual([101, 101, 101, 101]);
    } finally {
      for (const ws of sockets) ws.terminate();
      await relay.close();
    }
  }, 30_000);
});

describe("the HyperDHT relay's allowed origins (infra/services/hyperdht-relay)", () => {
  it("lets in the origin set with a trailing slash or in upper case, refuses others with 403, and logs each refused one once", async () => {
    const lines: string[] = [];
    const relay = await startRelay({ testnet: 3, origins: ["HTTPS://App.Ghostly.Tools/"], log: (...words: unknown[]) => { lines.push(words.join(" ")); } });
    const sockets: WebSocket[] = [];
    const open = (origin?: string) => new Promise<number>((resolve) => {
      const ws = new WebSocket(relay.url, origin ? { origin } : {});
      sockets.push(ws);
      ws.once("open", () => resolve(101));
      ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      ws.once("error", () => resolve(0));
    });
    try {
      expect(await open("https://app.ghostly.tools")).toBe(101);
      expect([await open("https://evil.example"), await open("https://evil.example"), await open("https://evil.example"), await open()]).toEqual([403, 403, 403, 403]);
      expect(relay.stats().refused).toBe(4);
      expect(lines.filter((line) => line.startsWith("refused"))).toEqual(['refused origin "https://evil.example"', "refused origin (none)"]);
    } finally {
      for (const ws of sockets) ws.terminate();
      await relay.close();
    }
  }, 30_000);
});
