import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listenProblem as pushListenProblem } from "../../../infra/services/push-relay/relay.mjs";
import { listenProblem as hyperdhtListenProblem } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: push.wake.send, transport.hyperdht-relay

/**
 * The two relays when the listen itself fails (infra/services/*\/server.mjs): a port in use, a port below 1024 for a
 * user, a HOST that is no address here. Each stops with one line naming the setting (listenProblem), not a stack.
 */
const SERVICES = resolve(import.meta.dirname, "../../../infra/services");

describe("the relays' listen problems", () => {
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
 * A port below 1024 is left to the unit test above: whether a user may take one depends on the host (macOS lets a user
 * take one on 0.0.0.0, a runner as root takes any).
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
