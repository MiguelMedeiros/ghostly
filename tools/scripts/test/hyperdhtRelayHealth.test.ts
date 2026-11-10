import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

const health = async (url: string) => {
  const response = await fetch(`${url.replace(/^ws/, "http")}/healthz`);
  return { status: response.status, body: await response.json() };
};

describe("the HyperDHT relay's health check (infra/services/hyperdht-relay)", () => {
  it("is unhealthy while its HyperDHT node reaches no other node, and says so in the start log", async () => {
    const logged: string[] = [];
    // A closed port: what a host with no outgoing UDP (a firewall, a tunnel, a container network) sees of every node.
    const relay = await startRelay({ bootstrap: ["127.0.0.1:1"], log: (...words: string[]) => { logged.push(words.join(" ")); } });
    try {
      const { status, body } = await health(relay.url);
      expect(status).toBe(503);
      expect(body).toMatchObject({ ok: false, nodes: 0 });
      expect(Object.keys(body).sort()).toEqual(["firewalled", "nodes", "ok"]);
      expect(relay.stats().sinceAnswerMs).toBeNull();
      expect(logged).toContain("bootstrap reached no node");
    } finally {
      await relay.close();
    }
  }, 30_000);

  it("is healthy once its node is in a network, with the size of its routing table and no count", async () => {
    const logged: string[] = [];
    const relay = await startRelay({ testnet: 3, log: (...words: string[]) => { logged.push(words.join(" ")); } });
    try {
      const { status, body } = await health(relay.url);
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, firewalled: false });
      expect(body.nodes).toBeGreaterThan(0);
      expect(Object.keys(body).sort()).toEqual(["firewalled", "nodes", "ok"]);
      expect(relay.stats().sinceAnswerMs).toBeGreaterThanOrEqual(0);
      expect(relay.stats().sinceAnswerMs).toBeLessThan(10_000);
      expect(logged).not.toContain("bootstrap reached no node");
    } finally {
      await relay.close();
    }
  }, 30_000);

  it("reads the same to a stranger before, during and after an allowed browser's connection", async () => {
    const relay = await startRelay({ testnet: 3, origins: ["https://app.example"] });
    try {
      const read = async () => (await fetch(`${relay.url.replace(/^ws/, "http")}/healthz`, { headers: { Origin: "https://stranger.example" } })).json();
      const before = await read();
      const ws = new WebSocket(relay.url, { origin: "https://app.example" });
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      await vi.waitFor(() => expect(relay.stats()).toMatchObject({ clients: 1, accepted: 1 }));
      expect(await read()).toEqual(before);
      const closed = new Promise((resolve) => ws.once("close", resolve));
      ws.close();
      await closed;
      await vi.waitFor(() => expect(relay.stats()).toMatchObject({ clients: 0 }));
      expect(await read()).toEqual(before);
    } finally {
      await relay.close();
    }
  }, 30_000);
});
