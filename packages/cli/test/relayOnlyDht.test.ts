import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createSocket, type Socket } from "node:dgram";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { profilePaths, type ProfilePaths } from "../src/profiles";
import type { Runtime } from "../src/runtime/engine";
import { isolatedNetworkEnv } from "./support/network";
// covers: headless.daemon, settings.network.relay-only

/*
 * Hide my IP from contacts (`relayOnly`) on a CLI profile and the Mainline DHT: while it is on, the daemon puts and reads
 * its Pkarr packets through the relays alone, and sends no UDP to a DHT node (WISP 100 § Relay only), as the Desktop.
 * The runtime is the daemon's own (`startRuntime`), in this process. The DHT's only node is a UDP socket on loopback
 * that counts what comes (`GHOSTLY_DHT_BOOTSTRAP`); the relays and the TURN server are loopback ports nobody listens on.
 */

const TURN = { urls: "turn:127.0.0.1:5601", username: "u", credential: "p" };
const root = mkdtempSync(join(tmpdir(), "ghostly-relay-only-dht-"));
const before: Record<string, string | undefined> = {};
let router: Socket;
let received = 0;
let runtime: Runtime | undefined;

beforeAll(async () => {
  router = createSocket("udp4");
  router.on("message", () => { received += 1; });
  await new Promise<void>((resolve) => router.bind(0, "127.0.0.1", resolve));
  const env = { ...isolatedNetworkEnv(), GHOSTLY_DHT: "1", GHOSTLY_DHT_BOOTSTRAP: `127.0.0.1:${router.address().port}`, GHOSTLY_WEBRTC: "0" };
  for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; process.env[key] = value; }
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

afterAll(() => {
  for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  router?.close();
  rmSync(root, { recursive: true, force: true });
});

async function start(paths: ProfilePaths): Promise<Runtime> {
  // A runtime per module graph: the engine keeps the store it opened.
  vi.resetModules();
  runtime = await (await import("../src/runtime/engine")).startRuntime(paths);
  return runtime;
}

function profile(name: string): ProfilePaths {
  const paths = profilePaths(join(root, "home"), name);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return paths;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

describe("a CLI profile with Hide my IP from contacts", () => {
  it("sends the Mainline DHT nothing while it is on, also after a restart; off again, its packets go there", async () => {
    const paths = profile("dht");
    const first = await start(paths);
    // On (a raw engine call: the CLI's own API refuses it), before anything is published.
    await first.server.node.updateSettings({ settings: { iceServers: [TURN], relayOnly: true } });
    received = 0;
    await first.server.node.createLink();
    await settle();
    expect(received).toBe(0);
    await first.close();
    runtime = undefined;

    // Started again on that store, as a profile that arrives with it on.
    received = 0;
    const { server } = await start(paths);
    expect(server.node.getState().settings.relayOnly).toBe(true);
    await server.node.createLink();
    await settle();
    expect(received).toBe(0);

    // Off: the packets go to the DHT beside the relays again.
    await server.node.updateSettings({ settings: { relayOnly: false } });
    await server.node.createLink();
    await settle();
    expect(received).toBeGreaterThan(0);
  }, 60_000);
});
