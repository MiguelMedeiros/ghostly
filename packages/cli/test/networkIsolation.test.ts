import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { irohRelays, publicStun, withoutPublicStun } from "../src/runtime/engine";
import { ghostly, home, ok, Running } from "./support/cli";
import { isolatedNetworkEnv, PUBLIC_NET_OPT_IN, publicNetworkIn, testNetworkEnv } from "./support/network";
// covers: headless.daemon

/**
 * A test's `ghostly` stays on this machine: no public Pkarr relay, Mainline DHT, HyperDHT bootstrap, Iroh relay or STUN
 * server, unless the run opts in (GHOSTLY_TEST_PUBLIC_NET=1). Each case sets the opt-in itself, off or on, so a shell
 * or a CI job that opts in does not change what it checks.
 */
const OFF = { [PUBLIC_NET_OPT_IN]: "0" };
const ON = { [PUBLIC_NET_OPT_IN]: "1" };

describe("a test's network", () => {
  it("is loopback or nowhere by default, for every network the CLI reaches", () => {
    const env = isolatedNetworkEnv(OFF);
    expect(publicNetworkIn(env)).toEqual([]);
    expect(env).toMatchObject({ GHOSTLY_DHT: "0", GHOSTLY_STUN: "0", GHOSTLY_HYPERDHT_BOOTSTRAP: "127.0.0.1:9", GHOSTLY_PKARR_RELAYS: "http://127.0.0.1:9", GHOSTLY_IROH_RELAYS: "http://127.0.0.1:9" });
    // The e2e infra's Iroh relay, when the shell has it.
    expect(isolatedNetworkEnv({ ...OFF, GHOSTLY_IROH_RELAY_URL: "http://127.0.0.1:47085" }).GHOSTLY_IROH_RELAYS).toBe("http://127.0.0.1:47085");
  });

  it("names each public network a test's environment would reach", () => {
    expect(publicNetworkIn({})).toHaveLength(5);
    const base = isolatedNetworkEnv(OFF);
    expect(publicNetworkIn({ ...base, GHOSTLY_PKARR_RELAYS: "http://127.0.0.1:4000,https://pkarr.pubky.app" })).toEqual(["Pkarr relay https://pkarr.pubky.app"]);
    expect(publicNetworkIn({ ...base, GHOSTLY_IROH_RELAYS: "https://use1-1.relay.n0.iroh.link/" })).toEqual(["Iroh relay https://use1-1.relay.n0.iroh.link/"]);
    expect(publicNetworkIn({ ...base, GHOSTLY_HYPERDHT_BOOTSTRAP: "node1.hyperdht.org:49737" })).toEqual(["HyperDHT node node1.hyperdht.org:49737"]);
    expect(publicNetworkIn({ ...base, GHOSTLY_DHT: "1", GHOSTLY_DHT_BOOTSTRAP: "router.bittorrent.com:6881" })).toEqual(["Mainline DHT node router.bittorrent.com:6881"]);
    expect(publicNetworkIn({ ...base, GHOSTLY_STUN: "1" })).toEqual(["WebRTC: the apps' public STUN servers (no GHOSTLY_STUN=0)"]);
    // Loopback testnets and relays are fine; so is WebRTC off, STUN and all.
    expect(publicNetworkIn({ ...base, GHOSTLY_DHT: "1", GHOSTLY_DHT_BOOTSTRAP: "127.0.0.1:6881", GHOSTLY_HYPERDHT_BOOTSTRAP: "localhost:1,127.0.0.1:2" })).toEqual([]);
    expect(publicNetworkIn({ ...base, GHOSTLY_STUN: undefined, GHOSTLY_WEBRTC: "0" })).toEqual([]);
  });

  it("refuses a test's own environment that reaches a public network, unless the run opts in", () => {
    expect(() => testNetworkEnv(OFF, { GHOSTLY_PKARR_RELAYS: "https://relay.pkarr.org" })).toThrow(/public network[\s\S]*Pkarr relay https:\/\/relay\.pkarr\.org/);
    expect(() => testNetworkEnv(OFF, { GHOSTLY_STUN: undefined })).toThrow(/STUN/);
    expect(testNetworkEnv(OFF, { GHOSTLY_PKARR_RELAYS: "http://127.0.0.1:4000" })).toMatchObject({ GHOSTLY_PKARR_RELAYS: "http://127.0.0.1:4000", GHOSTLY_STUN: "0" });
    // Opted in: the app's own networks (the Mainline DHT still off).
    const open = testNetworkEnv(ON, { GHOSTLY_PKARR_RELAYS: undefined, GHOSTLY_HYPERDHT_BOOTSTRAP: undefined, GHOSTLY_IROH_RELAYS: undefined, GHOSTLY_STUN: undefined });
    expect(open.GHOSTLY_DHT).toBe("0");
    expect(publicNetworkIn(open).length).toBeGreaterThan(0);
  });
});

describe("the CLI's knobs for a private network", () => {
  it("GHOSTLY_IROH_RELAYS: the only Iroh relays, https or http on loopback", () => {
    expect(irohRelays({})).toBeNull();
    expect(irohRelays({ GHOSTLY_IROH_RELAYS: " http://127.0.0.1:4020 , https://iroh.lan/ ," })).toEqual(["http://127.0.0.1:4020", "https://iroh.lan/"]);
    expect(() => irohRelays({ GHOSTLY_IROH_RELAYS: "http://iroh.lan" })).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/GHOSTLY_IROH_RELAYS: Use an https:\/\/ relay/) }));
  });

  it("GHOSTLY_STUN=0: the apps' public STUN servers out, the profile's own kept", () => {
    expect(publicStun({})).toBe(true);
    expect(publicStun({ GHOSTLY_STUN: "0" })).toBe(false);
    const config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: ["stun:stun1.l.google.com:19302", "stun:127.0.0.1:3478"] }, { urls: "turn:turn.lan", username: "u", credential: "p" }] };
    expect(withoutPublicStun(config)?.iceServers).toEqual([{ urls: ["stun:127.0.0.1:3478"] }, { urls: ["turn:turn.lan"], username: "u", credential: "p" }]);
    expect(withoutPublicStun(undefined)).toBeUndefined();
  });
});

describe("a daemon the helpers start", { timeout: 60_000 }, () => {
  const dir = home("isolated");
  let daemon: Running;
  beforeAll(() => { daemon = new Running(["--home", dir, "daemon"], OFF); });
  afterAll(() => daemon?.stop());

  it("homes Pkarr and Iroh on loopback only", async () => {
    await daemon.waitFor((line) => line.daemon === "ready");
    const state = ok(await ghostly(["--home", dir, "engine", "getState"], { env: OFF })) as { transport: { relays: string[]; iroh?: { relays: string[] } } };
    const hosts = [...state.transport.relays, ...(state.transport.iroh?.relays ?? [])].map((url) => new URL(url).hostname);
    expect(state.transport.iroh?.relays.length).toBeGreaterThan(0);
    expect(hosts.length).toBeGreaterThan(1);
    expect(hosts.filter((host) => !["127.0.0.1", "localhost", "[::1]"].includes(host))).toEqual([]);
  });
});
