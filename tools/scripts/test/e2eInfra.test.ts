import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** A service's lines in e2e/infra/docker-compose.yml, up to the next service (read as text: no YAML parser here). */
function service(name: string): string {
  const lines = readFileSync(resolve(import.meta.dirname, "../../../e2e/infra/docker-compose.yml"), "utf8").split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `no service ${name}`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, i) => i > start && /^ {2}[a-z0-9-]+:$|^\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("the e2e stack (e2e/infra)", () => {
  it("Anvil's memory stays bounded while the stack stays up, and it comes back if it dies", () => {
    const anvil = service("anvil");
    // A count of states, not the bare flag: that keeps the newest state alone, and a read of "latest" a block overtakes fails.
    expect(anvil).toMatch(/"--prune-history", "\d+"/);
    expect(anvil).toMatch(/^ {4}restart: on-failure$/m);
  });
});

describe("the HyperDHT relay (e2e/infra/env.mjs)", () => {
  it("is ready once its own HyperDHT node is reachable, not merely when it answers", async () => {
    const { hyperdhtRelayReady } = await import("../../../e2e/infra/env.mjs");
    const { startRelay } = await import("../../../infra/services/hyperdht-relay/relay.mjs");
    const { default: DHT } = await import("hyperdht");
    const reachable = await startRelay({ testnet: 3 });
    // A node made as any new one is: firewalled until dht-rpc's first network check, about 20 minutes in. Two browsers
    // on such a relay never reach each other until then (a relay image from before it was made reachable on loopback).
    const node = new DHT({ bootstrap: reachable.bootstrap, host: "127.0.0.1" });
    const firewalled = await startRelay({ dht: node });
    try {
      expect(await hyperdhtRelayReady(reachable.url)).toBe(true);
      expect(await hyperdhtRelayReady(firewalled.url)).toBe(false);
      expect(await hyperdhtRelayReady("ws://127.0.0.1:1")).toBe(false);
    } finally {
      await firewalled.close();
      await node.destroy();
      await reachable.close();
    }
  }, 30_000);
});

describe("the regtest chain (e2e/infra/chain.mjs)", () => {
  it("mines one block when the shared chain's tip is old, so a Lightning node counts as synced; never when it is fresh", async () => {
    const { freshTip, TIP_MAX_AGE_S } = await import("../../../e2e/infra/chain.mjs");
    const now = 1_800_000_000_000, mined: number[] = [];
    const mineOne = () => { mined.push(1); };
    expect(freshTip(now, () => now / 1000 - 60, mineOne), "a block a minute old").toBe(false);
    expect(freshTip(now, () => now / 1000 - TIP_MAX_AGE_S, mineOne), "just at the limit").toBe(false);
    expect(mined).toEqual([]);
    expect(freshTip(now, () => now / 1000 - 4 * 24 * 3600, mineOne), "a chain idle for days").toBe(true);
    expect(mined).toEqual([1]);
  });
});

describe("the Fedimint federation (e2e/support/fedimint-regtest/regtest.mjs)", () => {
  const FEDERATION = "f".repeat(64), NODE = "02".repeat(33);
  /** The stack's answers, as `status` asks for them: the gateway's CLI and each LND node's. A missing one throws, as a container that is not up does. */
  function stack(answers: { info?: unknown; balances?: unknown; peerChannels?: unknown[]; gatewayChannels?: unknown[] }) {
    const asked: string[] = [];
    const gateway = (...args: string[]) => {
      asked.push(`gateway ${args.join(" ")}`);
      const answer = args[0] === "info" ? answers.info : answers.balances;
      if (answer === undefined) throw new Error("Error response from daemon: container is not running");
      return answer;
    };
    const node = (name: string, ...args: string[]) => {
      asked.push(`${name} ${args.join(" ")}`);
      if (args[0] === "getinfo") return { identity_pubkey: NODE };
      const channels = name === "fedimint-lnd-peer" ? answers.peerChannels : answers.gatewayChannels;
      if (!channels) throw new Error("Error response from daemon: container is not running");
      return { channels };
    };
    return { gateway, node, asked };
  }
  const serving = {
    info: { federations: [{ federation_id: FEDERATION }] },
    balances: { ecash_balances: [{ federation_id: FEDERATION, ecash_balance_msats: 4_999_000_000 }] },
    peerChannels: [{ remote_pubkey: NODE, active: true }],
    gatewayChannels: [{ active: true }],
  };

  it("says whether Lightning routes in and out of the federation, by reading only", async () => {
    const { status } = await import("../../../e2e/support/fedimint-regtest/regtest.mjs");
    const of = (answers: Parameters<typeof stack>[0]) => { const s = stack(answers); return { ...status(s.gateway, s.node), asked: s.asked }; };

    const up = of(serving);
    expect(up).toMatchObject({ federation: FEDERATION, channel: true, gatewayEcashMsats: 4_999_000_000, routes: true });
    // Nothing that sets the stack up: no connect-fed, no channel opened, no peg-in.
    expect(up.asked.sort()).toEqual(["fedimint-lnd getinfo", "fedimint-lnd listchannels", "fedimint-lnd-peer listchannels", "gateway get-balances", "gateway info"]);

    // The guardian answers and has its invite code, but the gateway is not serving the federation yet.
    expect(of({}), "the gateway's container is not up").toMatchObject({ federation: null, routes: false });
    expect(of({ ...serving, info: { federations: [] } }), "the gateway has not joined the federation").toMatchObject({ federation: null, routes: false });
    expect(of({ ...serving, peerChannels: [] }), "no channel from the peer").toMatchObject({ federation: FEDERATION, channel: false, routes: false });
    expect(of({ ...serving, peerChannels: [{ remote_pubkey: NODE, active: false }] }), "the channel is not active yet").toMatchObject({ channel: false, routes: false });
    expect(of({ ...serving, gatewayChannels: undefined }), "the gateway's node is not up").toMatchObject({ channel: false, routes: false });
    expect(of({ ...serving, balances: { ecash_balances: [] } }), "the gateway has no ecash to pay in with").toMatchObject({ channel: true, gatewayEcashMsats: 0, routes: false });
  });
});

describe("the NWC hubs (e2e/support/nwc-regtest/regtest.mjs)", () => {
  const RELAY = "ws://nwc-relay:7777";
  const state = (online: boolean) => ({ running: true, network: "regtest", relays: [{ url: RELAY, online }] });

  it("restarts a running hub whose relay stays offline, once, and goes on when it is back", async () => {
    const { hubRunning } = await import("../../../e2e/support/nwc-regtest/regtest.mjs");
    // A hub with no app yet never dials the relay again once it dropped: only a restart brings it back.
    let restarts = 0;
    const info = async () => state(restarts > 0);
    const restart = () => { restarts++; };
    await expect(hubRunning("bob", { info, restart, tries: 10, stuck: 3, every: 0 })).resolves.toMatchObject({ running: true });
    expect(restarts).toBe(1);

    // Booting, then running with no relay reported yet, then online on its own: nothing to restart.
    const states = [Promise.reject(new Error("ECONNREFUSED")), { running: false, startupState: "Launching" }, { running: true, relays: null }, state(false), state(true)];
    let n = 0;
    const own = await hubRunning("alice", { info: async () => states[Math.min(n++, states.length - 1)], restart, tries: 10, stuck: 3, every: 0 });
    expect(own.relays).toEqual([{ url: RELAY, online: true }]);
    expect(restarts).toBe(1);
  });

  it("says which relay stayed offline, or why the hub is not running, when it gives up", async () => {
    const { hubRunning } = await import("../../../e2e/support/nwc-regtest/regtest.mjs");
    let restarts = 0;
    const offline = hubRunning("bob", { info: async () => state(false), restart: () => { restarts++; }, tries: 6, stuck: 3, every: 0 });
    await expect(offline).rejects.toThrow(`Timed out waiting for bob's hub to run: relay offline: ${RELAY}, even after a restart`);
    expect(restarts).toBe(1);

    const failed = hubRunning("bob", { info: async () => ({ running: false, startupError: "LND unreachable" }), restart: () => {}, tries: 3, every: 0 });
    await expect(failed).rejects.toThrow("Timed out waiting for bob's hub to run: LND unreachable");
  });
});
