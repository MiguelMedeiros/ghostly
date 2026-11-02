import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSettings as pushSettings } from "../../../infra/services/push-relay/relay.mjs";
import { DEFAULT_LIMITS, readSettings as hyperdhtSettings } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: push.wake.send, transport.hyperdht-relay

/**
 * The two relays' settings from their environment (infra/services/*\/server.mjs): one that is there but empty or not of
 * its kind stops the start with a line naming it. An empty `PORT=` in an env file was a random port, and
 * `GHOSTLY_RELAY_PROXIES=one` was no proxy at all (every user counted as the proxy's one address, and the push relay on
 * 0.0.0.0, not loopback), with nothing said.
 */
const SERVICES = resolve(import.meta.dirname, "../../../infra/services");

describe("the relays' settings", () => {
  it("are the defaults when left out, and taken as given when of their kind", () => {
    expect(pushSettings({})).toEqual({ port: 49480, host: "0.0.0.0", origins: [], proxies: 0 });
    expect(pushSettings({ PORT: "8443", GHOSTLY_RELAY_PROXIES: "1", GHOSTLY_RELAY_ORIGINS: "https://a.example, https://b.example" }))
      .toEqual({ port: 8443, host: "127.0.0.1", origins: ["https://a.example", "https://b.example"], proxies: 1 });
    expect(pushSettings({ GHOSTLY_RELAY_PROXIES: "1", HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(hyperdhtSettings({})).toEqual({ port: 49443, host: "0.0.0.0", bootstrap: [], testnet: undefined, origins: [], proxies: 0, cloudflare: false, limits: {} });
    expect(hyperdhtSettings({ GHOSTLY_RELAY_CLOUDFLARE: "1", GHOSTLY_RELAY_CLIENTS_PER_ADDRESS: "64", GHOSTLY_RELAY_IDLE_MS: "60000", GHOSTLY_HYPERDHT_TESTNET: "3" }))
      .toMatchObject({ cloudflare: true, testnet: 3, limits: { clientsPerAddress: 64, idleMs: 60_000 } });
    expect(hyperdhtSettings({ GHOSTLY_RELAY_CLOUDFLARE: "0" }).cloudflare).toBe(false);
    expect(Object.keys(DEFAULT_LIMITS)).toContain("clientsPerAddress");
  });

  it.each([
    ["PORT", "", "a port from 1 to 65535"],
    ["PORT", "abc", "a port from 1 to 65535"],
    ["PORT", "0", "a port from 1 to 65535"],
    ["PORT", "99999", "a port from 1 to 65535"],
    ["HOST", "", "a value (leave it out for the default)"],
    ["GHOSTLY_RELAY_PROXIES", "one", "a whole number of 0 or more"],
    ["GHOSTLY_RELAY_PROXIES", "abc", "a whole number of 0 or more"],
    ["GHOSTLY_RELAY_PROXIES", "", "a whole number of 0 or more"],
    ["GHOSTLY_RELAY_PROXIES", "-1", "a whole number of 0 or more"],
  ])("both refuse %s=%j", (name, value, expected) => {
    for (const read of [pushSettings, hyperdhtSettings]) {
      expect(() => read({ [name]: value })).toThrow(`${name}=${JSON.stringify(value)}: expected ${expected}`);
    }
  });

  it.each([
    ["GHOSTLY_RELAY_CLIENTS", "lots", "a whole number above 0"],
    ["GHOSTLY_RELAY_IDLE_MS", "0", "a whole number above 0"],
    ["GHOSTLY_RELAY_STREAMS", "1.5", "a whole number above 0"],
    ["GHOSTLY_RELAY_CLOUDFLARE", "true", "1 or 0"],
    ["GHOSTLY_HYPERDHT_TESTNET", "three", "a whole number of 0 or more"],
  ])("the HyperDHT relay refuses %s=%j", (name, value, expected) => {
    expect(() => hyperdhtSettings({ [name]: value })).toThrow(`${name}=${JSON.stringify(value)}: expected ${expected}`);
  });

  it.each(["push-relay", "hyperdht-relay"])("stop %s's start with one line naming the setting, and exit 1", (service) => {
    const run = spawnSync(process.execPath, ["server.mjs"], { cwd: resolve(SERVICES, service), env: { ...process.env, PORT: "47999", GHOSTLY_RELAY_PROXIES: "one" }, encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr.trim()).toMatch(/^\S+ Ghostly (push|HyperDHT) relay not started: GHOSTLY_RELAY_PROXIES="one": expected a whole number of 0 or more$/);
  });
});
