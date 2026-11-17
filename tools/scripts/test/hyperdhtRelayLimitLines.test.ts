import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { DEFAULT_LIMITS, limitReasons, startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

/**
 * An operator whose users report the relay unreachable finds `refused address` or `refused full` in the log. The first
 * line of each limit kind says which limit it was and the setting that moves it, so they need not read relay.mjs.
 */
const upgrade = (url: string) => new Promise<{ ws: WebSocket; status: number }>((resolve) => {
  const ws = new WebSocket(url);
  ws.once("open", () => resolve({ ws, status: 101 }));
  ws.once("unexpected-response", (_request, response) => resolve({ ws, status: response.statusCode ?? 0 }));
  ws.once("error", () => resolve({ ws, status: 0 }));
});

it("names the limit and its setting on the first line of a full relay's and of one address's refusals, then stays short", async () => {
  const run = async (limits: Record<string, number>) => {
    const lines: string[] = [];
    const relay = await startRelay({ testnet: 2, limits, log: (...words: unknown[]) => { lines.push(words.join(" ")); } });
    const sockets: WebSocket[] = [];
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const { ws, status } = await upgrade(relay.url);
        sockets.push(ws);
        statuses.push(status);
      }
      return { statuses, lines: lines.filter(line => line.startsWith("refused")) };
    } finally {
      for (const ws of sockets) ws.terminate();
      await relay.close();
    }
  };
  expect(await run({ clientsPerAddress: 2 })).toEqual({
    statuses: [101, 101, 429, 429],
    lines: ["refused address: 2 clients from one address (GHOSTLY_RELAY_CLIENTS_PER_ADDRESS)", "refused address"],
  });
  expect(await run({ clients: 2 })).toEqual({
    statuses: [101, 101, 503, 503],
    lines: ["refused full: 2 clients (GHOSTLY_RELAY_CLIENTS)", "refused full"],
  });
}, 60_000);

it("says each limit with the value it is set to", () => {
  expect(limitReasons(DEFAULT_LIMITS).get("dropped idle")).toBe("no listen and no dial for 30 s (GHOSTLY_RELAY_IDLE_MS)");
  expect(limitReasons({ ...DEFAULT_LIMITS, idleMs: 1500 }).get("dropped idle")).toBe("no listen and no dial for 1500 ms (GHOSTLY_RELAY_IDLE_MS)");
  expect(limitReasons({ ...DEFAULT_LIMITS, queuedBytes: 1000 }).get("dropped queue")).toBe("1000 bytes waiting for the client and its far peers (GHOSTLY_RELAY_QUEUED_BYTES)");
  // Every setting a reason names is one the relay reads.
  for (const reason of limitReasons(DEFAULT_LIMITS).values()) {
    for (const [name] of reason.matchAll(/GHOSTLY_RELAY_[A-Z_]+/g)) {
      expect(Object.keys(DEFAULT_LIMITS).map(limit => `GHOSTLY_RELAY_${limit.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`)).toContain(name);
    }
  }
});

it("lists every limit's log word in the README, for an operator who searches it", () => {
  const readme = readFileSync(new URL("../../../infra/services/hyperdht-relay/README.md", import.meta.url), "utf8");
  for (const kind of limitReasons(DEFAULT_LIMITS).keys()) expect(readme).toContain(`\`${kind}\``);
});
