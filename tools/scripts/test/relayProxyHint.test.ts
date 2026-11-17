import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { nearbyAddress, startRelay as startHyperdhtRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";
import { nearbyAddress as pushNearbyAddress, startRelay as startPushRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send, transport.hyperdht-relay

const hint = (header: string, setting: string) => `requests carry ${header} but ${setting} is not set: every client counts as the proxy`;

describe("the relays' hint that proxy headers arrive untrusted (infra/services)", () => {
  it("the push relay says once per start that requests carry X-Forwarded-For it ignores", async () => {
    for (const proxies of [0, 1]) {
      const lines: string[] = [];
      const relay = await startPushRelay({ proxies, log: (...words: unknown[]) => lines.push(words.join(" ")) });
      try {
        for (let i = 1; i <= 3; i++) {
          await fetch(`http://127.0.0.1:${relay.port}/`, { method: "POST", headers: { Origin: "https://app.ghostly.tools", "X-Forwarded-For": `198.51.100.${i}` }, body: "{}" });
        }
      } finally {
        await relay.close();
      }
      expect(lines.filter((line) => line.startsWith("requests carry"))).toEqual(proxies ? [] : [hint("X-Forwarded-For", "GHOSTLY_RELAY_PROXIES")]);
    }
  });

  it("the HyperDHT relay says so once per header, naming Cloudflare's setting when Cloudflare's header is there", async () => {
    const run = async (options: Record<string, unknown>, headers: Record<string, string>[]) => {
      const lines: string[] = [];
      const relay = await startHyperdhtRelay({ testnet: 3, ...options, log: (...words: unknown[]) => lines.push(words.join(" ")) });
      const sockets: WebSocket[] = [];
      try {
        for (const sent of headers) {
          await new Promise<void>((resolve) => {
            const ws = new WebSocket(relay.url, { headers: sent });
            sockets.push(ws);
            ws.once("open", () => resolve());
            ws.once("unexpected-response", () => resolve());
            ws.once("error", () => resolve());
          });
        }
      } finally {
        for (const ws of sockets) ws.terminate();
        await relay.close();
      }
      return lines.filter((line) => line.startsWith("requests carry"));
    };
    const forwarded = [{ "x-forwarded-for": "198.51.100.1" }, { "x-forwarded-for": "198.51.100.2" }];
    const cloudflare = [{ "cf-connecting-ip": "198.51.100.3", "x-forwarded-for": "198.51.100.3" }, { "cf-connecting-ip": "198.51.100.4", "x-forwarded-for": "198.51.100.4" }];
    expect(await run({}, forwarded)).toEqual([hint("X-Forwarded-For", "GHOSTLY_RELAY_PROXIES")]);
    expect(await run({}, cloudflare)).toEqual([hint("CF-Connecting-IP", "GHOSTLY_RELAY_CLOUDFLARE")]);
    expect(await run({ proxies: 1 }, [...forwarded, ...cloudflare])).toEqual([]);
    expect(await run({ cloudflare: true }, [...forwarded, ...cloudflare])).toEqual([]);
  }, 60_000);

  // A proxy that writes no header (nginx without `proxy_set_header X-Forwarded-For`, a TCP pass-through): every client
  // reaches the relay from the proxy's address, so they share one address's limits, and the log only said `refused address`.
  const missing = (header: string, setting: string) => `requests arrive without ${header} though ${setting} is set: each counts as the proxy, so have the proxy write it or leave the setting out`;

  it("the push relay told of a proxy says once per start that requests arrive without the X-Forwarded-For entry it counts by", async () => {
    const run = async (proxies: number, sent: Record<string, string>[]) => {
      const lines: string[] = [];
      const relay = await startPushRelay({ proxies, log: (...words: unknown[]) => lines.push(words.join(" ")) });
      try {
        for (const headers of sent) await fetch(`http://127.0.0.1:${relay.port}/`, { method: "POST", headers, body: "{}" });
      } finally {
        await relay.close();
      }
      return lines.filter((line) => line.startsWith("requests arrive"));
    };
    expect(await run(1, [{}, {}, {}])).toEqual([missing("X-Forwarded-For", "GHOSTLY_RELAY_PROXIES")]);
    // Fewer entries than proxies counts by the socket too.
    expect(await run(2, [{ "X-Forwarded-For": "198.51.100.1" }])).toEqual([missing("X-Forwarded-For", "GHOSTLY_RELAY_PROXIES")]);
    expect(await run(1, [{ "X-Forwarded-For": "198.51.100.1" }, { "X-Forwarded-For": "198.51.100.2" }])).toEqual([]);
    expect(await run(0, [{}, {}])).toEqual([]);
  });

  it("the HyperDHT relay told of a proxy or Cloudflare says once per start that requests arrive without the header it counts by", async () => {
    const run = async (options: Record<string, unknown>, headers: Record<string, string>[]) => {
      const lines: string[] = [];
      const relay = await startHyperdhtRelay({ testnet: 3, ...options, log: (...words: unknown[]) => lines.push(words.join(" ")) });
      const sockets: WebSocket[] = [];
      try {
        for (const sent of headers) {
          await new Promise<void>((resolve) => {
            const ws = new WebSocket(relay.url, { headers: sent });
            sockets.push(ws);
            ws.once("open", () => resolve());
            ws.once("unexpected-response", () => resolve());
            ws.once("error", () => resolve());
          });
        }
      } finally {
        for (const ws of sockets) ws.terminate();
        await relay.close();
      }
      return lines.filter((line) => line.startsWith("requests arrive"));
    };
    expect(await run({ proxies: 1 }, [{}, {}])).toEqual([missing("X-Forwarded-For", "GHOSTLY_RELAY_PROXIES")]);
    expect(await run({ proxies: 2 }, [{ "x-forwarded-for": "198.51.100.1" }])).toEqual([missing("X-Forwarded-For", "GHOSTLY_RELAY_PROXIES")]);
    expect(await run({ cloudflare: true }, [{}, { "x-forwarded-for": "198.51.100.1" }])).toEqual([missing("CF-Connecting-IP", "GHOSTLY_RELAY_CLOUDFLARE")]);
    // Cloudflare's header missing but the proxies' entry there: the client still counts by its own address.
    expect(await run({ cloudflare: true, proxies: 1 }, [{ "x-forwarded-for": "198.51.100.1" }])).toEqual([]);
    expect(await run({ proxies: 1 }, [{ "x-forwarded-for": "198.51.100.1" }])).toEqual([]);
    expect(await run({}, [{}, {}])).toEqual([]);
  }, 60_000);

  // A proxy that writes no header and that the relay was not told about: every browser comes from the proxy's own
  // loopback or private address, no header makes the hints above fire, and the 17th browser was refused with only
  // `refused address` in the log.
  const nearby = "clients refused at GHOSTLY_RELAY_CLIENTS_PER_ADDRESS (2) come from a loopback or private address: if they come through a proxy, have it write X-Forwarded-For and set GHOSTLY_RELAY_PROXIES (GHOSTLY_RELAY_CLOUDFLARE behind Cloudflare), or every client counts as the proxy";

  it("the HyperDHT relay with no proxy setting says once that clients refused at one address's limit come from a loopback or private address", async () => {
    const run = async (options: Record<string, unknown>, headers: Record<string, string>) => {
      const lines: string[] = [];
      const relay = await startHyperdhtRelay({ testnet: 3, ...options, limits: { clientsPerAddress: 2 }, log: (...words: unknown[]) => lines.push(words.join(" ")) });
      const sockets: WebSocket[] = [];
      const statuses: number[] = [];
      try {
        for (let i = 0; i < 5; i++) {
          statuses.push(await new Promise<number>((resolve) => {
            const ws = new WebSocket(relay.url, { headers });
            sockets.push(ws);
            ws.once("open", () => resolve(101));
            ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
            ws.once("error", () => resolve(0));
          }));
        }
      } finally {
        for (const ws of sockets) ws.terminate();
        await relay.close();
      }
      return { statuses, hints: lines.filter((line) => line.startsWith("clients refused")) };
    };
    expect(await run({}, {})).toEqual({ statuses: [101, 101, 429, 429, 429], hints: [nearby] });
    // A header there: its own hint names the setting, this one stays quiet.
    expect((await run({}, { "x-forwarded-for": "198.51.100.1" })).hints).toEqual([]);
    // Told of a proxy: `requests arrive without` covers it.
    expect((await run({ proxies: 1 }, {})).hints).toEqual([]);
  }, 60_000);

  it("the push relay with no proxy setting says once that requests refused at the rate come from a loopback or private address", async () => {
    const run = async (proxies: number) => {
      const lines: string[] = [];
      const relay = await startPushRelay({ proxies, limits: { perMinute: 1 }, log: (...words: unknown[]) => lines.push(words.join(" ")) });
      try {
        for (let i = 0; i < 4; i++) await fetch(`http://127.0.0.1:${relay.port}/`, { method: "POST", headers: { Origin: "https://app.ghostly.tools" }, body: "{}" });
      } finally {
        await relay.close();
      }
      return lines.filter((line) => line.startsWith("requests refused"));
    };
    expect(await run(0)).toEqual(["requests refused at the rate of 1 a minute from one address come from a loopback or private address: if they come through a proxy, have it write X-Forwarded-For and set GHOSTLY_RELAY_PROXIES, or every client shares that rate"]);
    expect(await run(1)).toEqual([]);
  });

  it("counts loopback, private and link-local addresses as nearby, and public ones not", () => {
    for (const nearbyOf of [nearbyAddress, pushNearbyAddress]) {
      for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.1.20", "100.64.0.1", "fd12::1", "fe80::1"]) expect(nearbyOf(address), address).toBe(true);
      for (const address of ["203.0.113.7", "8.8.8.8", "172.32.0.1", "2001:db8::1", "::ffff:198.51.100.1", "", undefined]) expect(nearbyOf(address), String(address)).toBe(false);
    }
  });
});
