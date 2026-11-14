import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSettings as pushSettings } from "../../../infra/services/push-relay/relay.mjs";
import { DEFAULT_LIMITS, networkOf as hyperdhtNetwork, readSettings as hyperdhtSettings } from "../../../infra/services/hyperdht-relay/relay.mjs";

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
    expect(pushSettings({})).toEqual({ port: 49480, host: "0.0.0.0", origins: [], proxies: 0, ignored: [] });
    expect(pushSettings({ PORT: "8443", GHOSTLY_RELAY_PROXIES: "1", GHOSTLY_RELAY_ORIGINS: "https://a.example, https://b.example" }))
      .toEqual({ port: 8443, host: "127.0.0.1", origins: ["https://a.example", "https://b.example"], proxies: 1, ignored: [] });
    expect(pushSettings({ GHOSTLY_RELAY_PROXIES: "1", HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(hyperdhtSettings({})).toEqual({ port: 49443, host: "0.0.0.0", bootstrap: [], testnet: undefined, origins: [], proxies: 0, cloudflare: false, limits: {}, ignored: [] });
    expect(hyperdhtSettings({ GHOSTLY_RELAY_CLOUDFLARE: "1", GHOSTLY_RELAY_CLIENTS_PER_ADDRESS: "64", GHOSTLY_RELAY_IDLE_MS: "60000", GHOSTLY_HYPERDHT_TESTNET: "3" }))
      .toMatchObject({ cloudflare: true, testnet: 3, limits: { clientsPerAddress: 64, idleMs: 60_000 } });
    expect(hyperdhtSettings({ GHOSTLY_RELAY_CLOUDFLARE: "0" }).cloudflare).toBe(false);
    expect(Object.keys(DEFAULT_LIMITS)).toContain("clientsPerAddress");
  });

  // A misspelt name was a quiet default, the less safe one: any origin, every client counted as the proxy.
  it("name each GHOSTLY_RELAY_* and GHOSTLY_HYPERDHT_* variable they do not read, with the closest one they do", () => {
    const env = {
      GHOSTLY_RELAY_ORIGIN: "https://app.example", GHOSTLY_RELAY_PROXY: "1", GHOSTLY_RELAY_CLIENT_PER_ADDRESS: "2",
      GHOSTLY_RELAY_CLOUDFLARE: "1", GHOSTLY_RELAY_PER_MINUTE: "5", GHOSTLY_HYPERDHT_BOOTSTRAPS: "127.0.0.1:1", GHOSTLY_OTHER: "x", PORTS: "1",
    };
    expect(pushSettings(env)).toMatchObject({ origins: [], proxies: 0 });
    expect(pushSettings(env).ignored).toEqual([
      "GHOSTLY_HYPERDHT_BOOTSTRAPS", "GHOSTLY_RELAY_CLIENT_PER_ADDRESS", "GHOSTLY_RELAY_CLOUDFLARE",
      "GHOSTLY_RELAY_ORIGIN (GHOSTLY_RELAY_ORIGINS?)", "GHOSTLY_RELAY_PER_MINUTE", "GHOSTLY_RELAY_PROXY (GHOSTLY_RELAY_PROXIES?)",
    ]);
    const { GHOSTLY_RELAY_CLOUDFLARE: _, ...hyperdhtEnv } = env;
    expect(hyperdhtSettings(hyperdhtEnv)).toMatchObject({ origins: [], proxies: 0, bootstrap: [], limits: {} });
    expect(hyperdhtSettings(hyperdhtEnv).ignored).toEqual([
      "GHOSTLY_HYPERDHT_BOOTSTRAPS (GHOSTLY_HYPERDHT_BOOTSTRAP?)", "GHOSTLY_RELAY_CLIENT_PER_ADDRESS (GHOSTLY_RELAY_CLIENTS_PER_ADDRESS?)",
      "GHOSTLY_RELAY_ORIGIN (GHOSTLY_RELAY_ORIGINS?)", "GHOSTLY_RELAY_PER_MINUTE", "GHOSTLY_RELAY_PROXY (GHOSTLY_RELAY_PROXIES?)",
    ]);
    expect(hyperdhtSettings({ GHOSTLY_RELAY_CLOUDFLARE: "1", GHOSTLY_RELAY_CLIENTS: "8", GHOSTLY_HYPERDHT_TESTNET: "3" }).ignored).toEqual([]);
  });

  it.each([
    ["push-relay", { GHOSTLY_RELAY_ORIGIN: "https://app.example", GHOSTLY_RELAY_PROXY: "1" },
      /^\S+ GHOSTLY_RELAY_ORIGIN \(GHOSTLY_RELAY_ORIGINS\?\), GHOSTLY_RELAY_PROXY \(GHOSTLY_RELAY_PROXIES\?\) are not settings of this relay; ignored$/],
    ["hyperdht-relay", { GHOSTLY_RELAY_ORIGIN: "https://app.example", GHOSTLY_HYPERDHT_TESTNET: "3" },
      /^\S+ GHOSTLY_RELAY_ORIGIN \(GHOSTLY_RELAY_ORIGINS\?\) is not a setting of this relay; ignored$/],
  ])("%s starts, and says which variables it ignored", async (service, settings, line) => {
    const others = Object.entries(process.env).filter(([name]) => !/^GHOSTLY_(RELAY|HYPERDHT)_/.test(name));
    const env = { ...Object.fromEntries(others), HOST: "127.0.0.1", PORT: String(await freePort()), ...settings };
    const lines = await linesUntilStart(service, env);
    expect(lines.filter((text) => text.includes(" setting"))).toEqual([expect.stringMatching(line)]);
    expect(lines.at(-1)).toMatch(/ any origin$/);
  }, 30_000);

  // Behind a proxy or Cloudflare, a client that reaches the port past it could write the header it is counted by.
  it.each([
    [{}, "0.0.0.0"],
    [{ GHOSTLY_RELAY_PROXIES: "0" }, "0.0.0.0"],
    [{ GHOSTLY_RELAY_PROXIES: "1" }, "127.0.0.1"],
    [{ GHOSTLY_RELAY_PROXIES: "2" }, "127.0.0.1"],
    [{ GHOSTLY_RELAY_PROXIES: "1", HOST: "0.0.0.0" }, "0.0.0.0"],
    [{ HOST: "192.0.2.1" }, "192.0.2.1"],
  ])("both listen where %j says: %s", (env, host) => {
    expect(pushSettings(env).host).toBe(host);
    expect(hyperdhtSettings(env).host).toBe(host);
  });

  it.each([
    [{ GHOSTLY_RELAY_CLOUDFLARE: "0" }, "0.0.0.0"],
    [{ GHOSTLY_RELAY_CLOUDFLARE: "1" }, "127.0.0.1"],
    [{ GHOSTLY_RELAY_CLOUDFLARE: "1", GHOSTLY_RELAY_PROXIES: "1" }, "127.0.0.1"],
    [{ GHOSTLY_RELAY_CLOUDFLARE: "1", HOST: "0.0.0.0" }, "0.0.0.0"],
  ])("the HyperDHT relay listens where %j says: %s", (env, host) => {
    expect(hyperdhtSettings(env).host).toBe(host);
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

  // Node runs a timer past 2147483647 ms after 1 ms: "about 35 days" would drop every client as it connects.
  it.each([
    ["GHOSTLY_RELAY_IDLE_MS", "3000000000"],
    ["GHOSTLY_RELAY_PING_MS", "2592000000"],
    ["GHOSTLY_RELAY_HANDSHAKE_MS", "2147483648"],
    ["GHOSTLY_RELAY_REQUEST_MS", "9007199254740991"],
  ])("the HyperDHT relay refuses %s=%j, longer than a timer can wait", (name, value) => {
    expect(() => hyperdhtSettings({ [name]: value })).toThrow(`${name}=${JSON.stringify(value)}: expected a whole number above 0, at most 2147483647 (about 24 days)`);
  });

  it("the HyperDHT relay takes a time limit of 2147483647 ms, and a count past it", () => {
    expect(hyperdhtSettings({ GHOSTLY_RELAY_IDLE_MS: "2147483647", GHOSTLY_RELAY_QUEUED_TOTAL_BYTES: "3000000000" }).limits)
      .toEqual({ idleMs: 2_147_483_647, queuedTotalBytes: 3_000_000_000 });
  });

  it("stop the HyperDHT relay's start on a time limit past 2147483647 ms, in one line", () => {
    const env = { ...process.env, HOST: "127.0.0.1", PORT: "47998", GHOSTLY_HYPERDHT_TESTNET: "3", GHOSTLY_RELAY_IDLE_MS: "3000000000" };
    const run = spawnSync(process.execPath, ["server.mjs"], { cwd: resolve(SERVICES, "hyperdht-relay"), env, encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr.trim()).toMatch(/^\S+ Ghostly HyperDHT relay not started: GHOSTLY_RELAY_IDLE_MS="3000000000": expected a whole number above 0, at most 2147483647 \(about 24 days\)$/);
  });

  it("the HyperDHT relay keeps a client with the longest idle and ping limits a timer takes", async () => {
    const port = await freePort();
    const env = { ...process.env, HOST: "127.0.0.1", PORT: String(port), GHOSTLY_HYPERDHT_TESTNET: "3", GHOSTLY_RELAY_IDLE_MS: "2147483647", GHOSTLY_RELAY_PING_MS: "2147483647" };
    const child = spawn(process.execPath, ["server.mjs"], { cwd: resolve(SERVICES, "hyperdht-relay"), env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((done, fail) => {
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; if (out.includes(" relay on port ")) done(); });
        child.once("exit", (code) => fail(new Error(`exited ${code}`)));
      });
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const closed = new Promise<number>((done) => socket.addEventListener("close", (event) => done(event.code)));
      await new Promise((done) => socket.addEventListener("open", done));
      expect(await Promise.race([closed, new Promise((done) => setTimeout(() => done("open"), 1500))])).toBe("open");
      socket.close();
    } finally {
      child.kill("SIGTERM");
    }
  }, 30_000);

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

  it("the HyperDHT relay refuses a testnet with bootstrap nodes, which it would drop without a word", () => {
    expect(() => hyperdhtSettings({ GHOSTLY_HYPERDHT_TESTNET: "3", GHOSTLY_HYPERDHT_BOOTSTRAP: "127.0.0.1:1" }))
      .toThrow('GHOSTLY_HYPERDHT_TESTNET="3": expected no GHOSTLY_HYPERDHT_BOOTSTRAP with it (the testnet is a network of its own)');
    expect(hyperdhtSettings({ GHOSTLY_HYPERDHT_TESTNET: "0", GHOSTLY_HYPERDHT_BOOTSTRAP: "127.0.0.1:1" }).bootstrap).toEqual(["127.0.0.1:1"]);
  });

  it("the HyperDHT relay's start line names its network: its own testnet, the bootstrap nodes or the public one", () => {
    expect(hyperdhtNetwork({ testnet: 3, bootstrap: [] })).toBe("(own testnet of 3 nodes)");
    expect(hyperdhtNetwork({ testnet: 1, bootstrap: [] })).toBe("(own testnet of 1 node)");
    expect(hyperdhtNetwork({ bootstrap: ["127.0.0.1:1"] })).toBe("(bootstrap 1 node)");
    expect(hyperdhtNetwork({ bootstrap: ["127.0.0.1:1", "127.0.0.1:2"] })).toBe("(bootstrap 2 nodes)");
    expect(hyperdhtNetwork({ bootstrap: [] })).toBe("(public HyperDHT)");
  });

  it.each(["push-relay", "hyperdht-relay"])("stop %s's start with one line naming the setting, and exit 1", (service) => {
    const run = spawnSync(process.execPath, ["server.mjs"], { cwd: resolve(SERVICES, service), env: { ...process.env, PORT: "47999", GHOSTLY_RELAY_PROXIES: "one" }, encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr.trim()).toMatch(/^\S+ Ghostly (push|HyperDHT) relay not started: GHOSTLY_RELAY_PROXIES="one": expected a whole number of 0 or more$/);
  });

  it("both read GHOSTLY_RELAY_ORIGINS as a browser writes an origin: lower case, no default port, no trailing slash", () => {
    const GHOSTLY_RELAY_ORIGINS = "https://App.Ghostly.Tools/, HTTP://localhost:5173, https://a.example:443, https://b.example:8443/, chrome-extension://nbedaagicniejlmfcncndfjcejaidbcf/, https://app.ghostly.tools";
    for (const read of [pushSettings, hyperdhtSettings]) {
      expect(read({ GHOSTLY_RELAY_ORIGINS }).origins).toEqual([
        "https://app.ghostly.tools", "http://localhost:5173", "https://a.example", "https://b.example:8443", "chrome-extension://nbedaagicniejlmfcncndfjcejaidbcf",
      ]);
      expect(read({ GHOSTLY_RELAY_ORIGINS: "" }).origins).toEqual([]);
    }
  });

  it.each([
    "https://app.ghostly.tools/app", "https://app.ghostly.tools/?", "https://app.ghostly.tools?x=1", "https://app.ghostly.tools/#top",
    "app.ghostly.tools", "localhost:5173", "file:///srv/app", "https://me@app.ghostly.tools", "*",
  ])("both refuse the entry %j in GHOSTLY_RELAY_ORIGINS, naming it", (entry) => {
    const value = `https://ok.example, ${entry}`;
    for (const read of [pushSettings, hyperdhtSettings]) {
      expect(() => read({ GHOSTLY_RELAY_ORIGINS: value }))
        .toThrow(`GHOSTLY_RELAY_ORIGINS=${JSON.stringify(value)}: expected origins like https://app.example, comma-separated: a scheme, a host and a port only (${JSON.stringify(entry)} is not one)`);
    }
  });

  it.each(["push-relay", "hyperdht-relay"])("stop %s's start on an origin with a path, in one line", (service) => {
    // Loopback and its own HyperDHT network, should a build start anyway (as dev did): never the public one.
    const env = { ...process.env, HOST: "127.0.0.1", PORT: "47999", GHOSTLY_HYPERDHT_TESTNET: "3", GHOSTLY_RELAY_ORIGINS: "https://app.ghostly.tools/chat" };
    const run = spawnSync(process.execPath, ["server.mjs"], { cwd: resolve(SERVICES, service), env, encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr.trim()).toMatch(/^\S+ Ghostly (push|HyperDHT) relay not started: GHOSTLY_RELAY_ORIGINS="https:\/\/app\.ghostly\.tools\/chat": expected origins like https:\/\/app\.example, comma-separated: a scheme, a host and a port only \("https:\/\/app\.ghostly\.tools\/chat" is not one\)$/);
  });

  it.each([
    ["push-relay", "origins set", {}, /^\S+ Ghostly push relay on port (\d+) \(no proxy, on 127\.0\.0\.1\), origins https:\/\/app\.ghostly\.tools http:\/\/localhost:5173$/],
    ["push-relay", "none set", { GHOSTLY_RELAY_ORIGINS: undefined }, /^\S+ Ghostly push relay on port (\d+) \(no proxy, on 127\.0\.0\.1\), any origin$/],
    ["hyperdht-relay", "origins set", { GHOSTLY_HYPERDHT_TESTNET: "3" }, /^\S+ Ghostly HyperDHT relay on port (\d+) \(own testnet of 3 nodes\) on 127\.0\.0\.1, clients by their own address, origins https:\/\/app\.ghostly\.tools http:\/\/localhost:5173$/],
    ["hyperdht-relay", "none set", { GHOSTLY_HYPERDHT_TESTNET: "3", GHOSTLY_RELAY_ORIGINS: undefined }, /^\S+ Ghostly HyperDHT relay on port (\d+) \(own testnet of 3 nodes\) on 127\.0\.0\.1, clients by their own address, any origin$/],
  ])("%s's start line says which origins it serves (%s)", async (service, _label, extra, line) => {
    const env: Record<string, string | undefined> = { ...process.env, HOST: "127.0.0.1", PORT: String(await freePort()), GHOSTLY_RELAY_ORIGINS: "HTTPS://App.Ghostly.Tools:443/,http://localhost:5173/", ...extra };
    for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name];
    expect(await startLine(service, env)).toMatch(line);
  }, 30_000);
});

/** A loopback port nothing listens on just now. */
const freePort = () => new Promise<number>((done) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    server.close(() => done(port));
  });
});

/** The relay's start line on stdout, then SIGTERM. */
const startLine = async (service: string, env: Record<string, string | undefined>) => (await linesUntilStart(service, env)).at(-1);

/** The relay's lines on stdout up to its start line, then SIGTERM. */
function linesUntilStart(service: string, env: Record<string, string | undefined>): Promise<string[]> {
  const child = spawn(process.execPath, ["server.mjs"], { cwd: resolve(SERVICES, service), env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  return new Promise<string[]>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`no start line: ${err}`)), 25_000);
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const lines = out.split("\n").slice(0, -1);
      const start = lines.findIndex((text) => text.includes(" relay on port "));
      if (start >= 0) { clearTimeout(timer); done(lines.slice(0, start + 1)); }
    });
    child.once("exit", (code) => { clearTimeout(timer); fail(new Error(`exited ${code}: ${err}`)); });
  }).finally(() => { child.kill("SIGTERM"); });
}

describe("the HyperDHT relay's container", () => {
  it("listens on every interface of the container, so the published port and a Cloudflare tunnel still reach it", async () => {
    const { readFileSync } = await import("node:fs");
    const dockerfile = readFileSync(resolve(__dirname, "../../../infra/services/hyperdht-relay/Dockerfile"), "utf8");
    const env = dockerfile.split("\n").filter((line) => /^ENV\s/.test(line)).join(" ");
    expect(env).toMatch(/\bHOST=0\.0\.0\.0\b/);
    // The compose file turns the Cloudflare setting on by default; the Dockerfile's HOST must still win over it.
    expect(hyperdhtSettings({ HOST: "0.0.0.0", GHOSTLY_RELAY_CLOUDFLARE: "1" }).host).toBe("0.0.0.0");
  });

  // The Desktop with "Hide my IP from contacts" on dials HyperDHT through the relay from its webview, which sends the
  // webview's own origin (measured in WebKitGTK: `tauri://localhost`): left out, every chat of it was refused (403).
  it("lets in by default every Ghostly client that opens it from a page: the web app, the extension and the Desktop", async () => {
    const { readFileSync } = await import("node:fs");
    const compose = readFileSync(resolve(__dirname, "../../../infra/services/hyperdht-relay/docker-compose.yml"), "utf8");
    const GHOSTLY_RELAY_ORIGINS = /GHOSTLY_RELAY_ORIGINS: \$\{GHOSTLY_RELAY_ORIGINS:-([^}]*)\}/.exec(compose)?.[1];
    expect(hyperdhtSettings({ GHOSTLY_RELAY_ORIGINS }).origins).toEqual(expect.arrayContaining([
      "https://app.ghostly.tools", "chrome-extension://nbedaagicniejlmfcncndfjcejaidbcf",
      // macOS and Linux, then Windows and Android (apps/ui/src/lib/url.ts).
      "tauri://localhost", "http://tauri.localhost",
    ]));
  });
});
