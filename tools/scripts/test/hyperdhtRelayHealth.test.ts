import { describe, expect, it } from "vitest";
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
      expect(body).toMatchObject({ ok: false, nodes: 0, sinceAnswerMs: null });
      expect(logged).toContain("bootstrap reached no node");
    } finally {
      await relay.close();
    }
  }, 30_000);

  it("is healthy once its node is in a network, with the size of its routing table and how long ago a node answered", async () => {
    const logged: string[] = [];
    const relay = await startRelay({ testnet: 3, log: (...words: string[]) => { logged.push(words.join(" ")); } });
    try {
      const { status, body } = await health(relay.url);
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, firewalled: false });
      expect(body.nodes).toBeGreaterThan(0);
      expect(body.sinceAnswerMs).toBeGreaterThanOrEqual(0);
      expect(body.sinceAnswerMs).toBeLessThan(10_000);
      expect(logged).not.toContain("bootstrap reached no node");
    } finally {
      await relay.close();
    }
  }, 30_000);
});
