import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { connectDaemon } from "../src/client";
import { CliError } from "../src/errors";
import { serve, type Host } from "../src/host";
import { daemonSecretPath, proof } from "../src/daemonProof";
import { createProfile, profilePaths } from "../src/profiles";
import { error, ghostly } from "./support/cli";
// covers: headless.daemon, headless.cli

/**
 * Whatever listens where a profile's daemon should (on Windows a named pipe any account may open first) is sent
 * nothing but the hello until it has proved, over the client's own nonce, that it read the secret the daemon wrote
 * in the profile's owner-only folder.
 */
const root = mkdtempSync("/tmp/gh-proof-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

type Line = { id?: unknown; method?: string; params?: { nonce?: string } };

/** A listener on `socket` that keeps every line it reads and answers each as `answer` says (null: no answer). */
async function impostor(socket: string, answer: (line: Line) => object | null): Promise<{ lines: string[]; server: Server }> {
  const lines: string[] = [];
  const server = createServer((s: Socket) => {
    s.on("error", () => {});
    createInterface({ input: s }).on("line", (text) => {
      lines.push(text);
      let line: Line = {};
      try { line = JSON.parse(text) as Line; } catch { /* kept as it came */ }
      const reply = answer(line);
      if (reply) s.write(JSON.stringify(reply) + "\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { lines, server };
}

const methods = (lines: string[]) => lines.map((text) => { try { return (JSON.parse(text) as Line).method; } catch { return text; } });

/** A profile folder of this user's with a socket path in it, and the secret a daemon of it wrote. */
function profileAt(name: string): { dir: string; socket: string } {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  return { dir, socket: join(dir, "daemon.sock") };
}

/** An events hub with nothing in it: enough for `events.subscribe` on a daemon served by `serve`. */
const quietHub = { lastSeq: 7, replay: () => [], onEvent: () => () => {} };

describe.skipIf(process.platform === "win32")("a listener that is not this profile's daemon gets no request", () => {
  it("a command to a listener that answers everything but cannot prove the secret is refused, and only the hello reached it", async () => {
    const dir = join(root, "cli-home");
    createProfile(dir, "default");
    const paths = profilePaths(dir, "default");
    // The daemon's secret is there (one ran before); the listener cannot read it.
    writeFileSync(daemonSecretPath(paths.dir), "ab".repeat(32) + "\n", { mode: 0o600 });
    const seen = await impostor(paths.socket, (line) => ({ id: line.id ?? null, result: { running: true, profile: "default", proof: "00".repeat(32), version: "9.9.9" } }));

    const status = error(await ghostly(["--home", dir, "daemon", "status"]), "refused", 1);
    expect(status.message).toContain("ghostly daemon restart");
    const token = "cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlIAJofKTJT5B5hcIOkYWEQYXN4QGZha2U";
    error(await ghostly(["--home", dir, "wallet", "redeem"], { input: token + "\n" }), "refused", 1);

    expect(methods(seen.lines).every((method) => method === "daemon.hello"), seen.lines.join("\n")).toBe(true);
    expect(seen.lines.join("\n")).not.toContain(token);
  });

  it("a wrong proof, a proof replayed from another hello, the client's own role, or an older daemon's error: refused with nothing sent", async () => {
    const { dir, socket } = profileAt("replay");
    // A real daemon first, to capture one genuine proof over a nonce of an earlier hello.
    const real = await serve({ ctx: { runtime: { paths: { dir, socket } }, hub: quietHub } } as unknown as Host);
    // A hello made by hand: what a listener that once relayed a client to the daemon would have seen go by.
    const nonce = "11".repeat(16);
    const captured = await new Promise<string>((resolve) => {
      const s = connect(socket, () => s.write(JSON.stringify({ id: "h", method: "daemon.hello", params: { nonce } }) + "\n"));
      createInterface({ input: s }).once("line", (text) => { s.destroy(); resolve((JSON.parse(text) as { result: { proof: string } }).result.proof); });
    });
    await real.close();
    rmSync(socket, { force: true });
    const secret = Buffer.from(readFileSync(daemonSecretPath(dir), "utf8").trim(), "hex");
    expect(captured).toBe(proof(secret, "daemon", nonce));

    const answers: [string, (line: Line) => object | null][] = [
      ["wrong proof", (line) => ({ id: line.id, result: { proof: "00".repeat(32) } })],
      ["replayed proof", (line) => ({ id: line.id, result: { proof: captured } })],
      ["the client's role", (line) => ({ id: line.id, result: { proof: proof(secret, "client", line.params?.nonce ?? "") } })],
      ["older daemon", (line) => ({ id: line.id, error: { code: "bad_request", message: "Unknown method daemon.hello" } })],
      ["no proof at all", (line) => ({ id: line.id, result: { running: true } })],
    ];
    for (const [what, answer] of answers) {
      const seen = await impostor(socket, answer);
      const client = await connectDaemon({ dir, socket }, 1_000);
      expect(client, what).not.toBeNull();
      const failure = await client!.call("chat.send", { chat: "bob", text: "a secret plan" }, { timeoutMs: 2_000 }).catch((e: unknown) => e) as CliError;
      expect(failure, what).toBeInstanceOf(CliError);
      expect(failure.code, what).toBe("refused");
      expect(failure.message, what).toContain("ghostly daemon restart");
      expect(methods(seen.lines), what).toEqual(["daemon.hello"]);
      await new Promise<void>((resolve) => seen.server.close(() => resolve()));
      rmSync(socket, { force: true });
    }
  });

  it("a secret file anyone else may read, or none, proves nothing", async () => {
    for (const mode of ["open", "missing"] as const) {
      const { dir, socket } = profileAt(`secret-${mode}`);
      const secret = Buffer.from("cd".repeat(32), "hex");
      if (mode === "open") { writeFileSync(daemonSecretPath(dir), secret.toString("hex") + "\n"); chmodSync(daemonSecretPath(dir), 0o644); }
      // The listener knows the secret here: only the file's place and mode can tell it is not the daemon's.
      const seen = await impostor(socket, (line) => ({ id: line.id, result: { proof: proof(secret, "daemon", line.params?.nonce ?? "") } }));
      const client = await connectDaemon({ dir, socket }, 1_000);
      const failure = await client!.call("status", {}, { timeoutMs: 2_000 }).catch((e: unknown) => e) as CliError;
      expect(failure.code, mode).toBe("refused");
      expect(methods(seen.lines), mode).toEqual(["daemon.hello"]);
      await new Promise<void>((resolve) => seen.server.close(() => resolve()));
    }
  });

  it("the profile's real daemon proves itself, and its requests go through", async () => {
    const { dir, socket } = profileAt("real");
    const served = await serve({ ctx: { runtime: { paths: { dir, socket } }, hub: quietHub } } as unknown as Host);
    cleanups.push(() => served.close());
    const client = await connectDaemon({ dir, socket }, 1_000);
    expect(client).not.toBeNull();
    expect(await client!.subscribe(undefined, () => {})).toEqual({ subscribed: true, lastSeq: 7 });
    client!.close();
    // A fresh secret at every start, owner-only.
    expect(statSync(daemonSecretPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("daemon stop still ends an older release's daemon, which cannot prove itself, through the process that holds the profile", async () => {
    const dir = join(root, "old-daemon");
    createProfile(dir, "default");
    const paths = profilePaths(dir, "default");
    await impostor(paths.socket, (line) => ({ id: line.id ?? null, error: { code: "bad_request", message: "Unknown method" } }));
    const old = spawn("sh", ["-c", "while :; do sleep 1; done"], { stdio: "ignore" });
    cleanups.push(() => { old.kill("SIGKILL"); });
    writeFileSync(paths.lock, String(old.pid));
    const ended = new Promise<string | null>((resolve) => old.once("exit", (_, signalName) => resolve(signalName)));
    const result = await ghostly(["--home", dir, "daemon", "stop", "--timeout", "5"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json).toEqual({ stopped: true, pid: old.pid });
    expect(result.stderr).toContain("did not prove it is this profile's daemon");
    expect(await ended).toBe("SIGTERM");
  });

  it("daemon stop with nobody holding the profile refuses what answers on its socket", async () => {
    const dir = join(root, "squatted");
    createProfile(dir, "default");
    const paths = profilePaths(dir, "default");
    const seen = await impostor(paths.socket, (line) => ({ id: line.id ?? null, result: { pid: 1 } }));
    error(await ghostly(["--home", dir, "daemon", "stop", "--timeout", "2"]), "refused", 1);
    expect(methods(seen.lines)).toEqual(["daemon.hello"]);
  });
});
