import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startRelay as startHyperdhtRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";
import { startRelay as startPushRelay } from "../../../infra/services/push-relay/relay.mjs";

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
});
