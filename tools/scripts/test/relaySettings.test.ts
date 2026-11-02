import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listenProblem as pushListenProblem, readSettings as pushSettings } from "../../../infra/services/push-relay/relay.mjs";
import { DEFAULT_LIMITS, listenProblem as hyperdhtListenProblem, readSettings as hyperdhtSettings } from "../../../infra/services/hyperdht-relay/relay.mjs";

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

  it("the HyperDHT relay takes host:port bootstrap nodes, HyperDHT's ip@host:port ones too", () => {
    expect(hyperdhtSettings({ GHOSTLY_HYPERDHT_BOOTSTRAP: "127.0.0.1:49737, 88.99.3.86@node1.hyperdht.org:49737" }).bootstrap)
      .toEqual(["127.0.0.1:49737", "88.99.3.86@node1.hyperdht.org:49737"]);
  });

  it.each(["127.0.0.1", "not-a-node", "127.0.0.1:0", "127.0.0.1:99999", "node.example:abc", "127.0.0.1:49737,node.example", "", " "])(
    "the HyperDHT relay refuses GHOSTLY_HYPERDHT_BOOTSTRAP=%j",
    (value) => {
      expect(() => hyperdhtSettings({ GHOSTLY_HYPERDHT_BOOTSTRAP: value }))
        .toThrow(`GHOSTLY_HYPERDHT_BOOTSTRAP=${JSON.stringify(value)}: expected host:port nodes, comma-separated, each port from 1 to 65535`);
    },
  );

  it.each([
    ["EADDRINUSE", "port 47480 on 127.0.0.1 is already in use (PORT)"],
    ["EACCES", "port 47480 on 127.0.0.1 needs more rights than this user has (PORT): below 1024, root or the cap_net_bind_service capability"],
    ["EADDRNOTAVAIL", "cannot listen on 127.0.0.1: it is no address of this machine (HOST)"],
    ["ENOTFOUND", 'cannot listen on "127.0.0.1": no such host (HOST)'],
    ["EAI_AGAIN", 'cannot listen on "127.0.0.1": no such host (HOST)'],
    ["ECONNRESET", null],
  ])("both say why they could not listen on %s, naming the setting", (code, line) => {
    const error = Object.assign(new Error(code), { code });
    for (const problem of [pushListenProblem, hyperdhtListenProblem]) {
      expect(problem(error, { port: 47480, host: "127.0.0.1" })).toBe(line);
    }
    expect(pushListenProblem(new Error("no code"), { port: 1, host: "x" })).toBeNull();
  });
});

/**
 * What the operator sees when the listen itself fails: one line naming the setting, exit 1, not Node's "Unhandled 'error'
 * event" and a 20-line stack. Every relay here is pinned to loopback and the HyperDHT one to its own in-process network
 * (GHOSTLY_HYPERDHT_TESTNET=3), so even a build without the fix never listens on 0.0.0.0 or reaches the public HyperDHT.
 * A port below 1024 is left to the unit test above: whether a user may take one depends on the host (macOS lets it).
 */
describe("the relays' start, when they cannot listen", () => {
  // Only the settings each case gives: none of the caller's own GHOSTLY_*, PORT or HOST leaks into the relay.
  const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GHOSTLY_|PORT$|HOST$)/.test(name)));
  const run = (service: string, env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, ["server.mjs"], { cwd: resolve(SERVICES, service), env: { ...cleanEnv(), HOST: "127.0.0.1", GHOSTLY_HYPERDHT_TESTNET: "3", ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("close", (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
    });
  const NAME = { "push-relay": "push", "hyperdht-relay": "HyperDHT" } as const;
  const oneLine = (service: keyof typeof NAME, result: { status: number | null; stdout: string; stderr: string }, says: string) => {
    expect(result.stdout).not.toContain("relay on port");
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr.trim()).toBe(`${result.stderr.trim().split(" ")[0]} Ghostly ${NAME[service]} relay not started: ${says}`);
    expect(result.status).toBe(1);
  };

  it.each(["push-relay", "hyperdht-relay"] as const)("%s on a port another program holds", async (service) => {
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, "127.0.0.1", done));
    const { port } = holder.address() as { port: number };
    try {
      oneLine(service, await run(service, { PORT: String(port) }), `port ${port} on 127.0.0.1 is already in use (PORT)`);
    } finally {
      holder.close();
    }
  }, 30_000);

  it.each(["push-relay", "hyperdht-relay"] as const)("%s on a HOST that names nothing", async (service) => {
    oneLine(service, await run(service, { PORT: "47998", HOST: "no.such.host.invalid" }), 'cannot listen on "no.such.host.invalid": no such host (HOST)');
  }, 30_000);

  it("the HyperDHT relay with a bootstrap node without a port", async () => {
    // No testnet here (it would stand in for the bootstrap), and the node named is loopback: nothing leaves the machine.
    const result = await run("hyperdht-relay", { PORT: "47997", GHOSTLY_HYPERDHT_TESTNET: "0", GHOSTLY_HYPERDHT_BOOTSTRAP: "127.0.0.1" });
    oneLine("hyperdht-relay", result, 'GHOSTLY_HYPERDHT_BOOTSTRAP="127.0.0.1": expected host:port nodes, comma-separated, each port from 1 to 65535 (leave it out for the public HyperDHT); "127.0.0.1" is not one');
  }, 30_000);
});
