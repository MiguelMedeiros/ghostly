import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { connectDaemon } from "../src/client";
import { CliError } from "../src/errors";
import { serve, type Host } from "../src/host";
import { daemonSecretPath, greeting, newDaemonSecret, proof, provesGreeting } from "../src/daemonProof";
import { createProfile, lockPath, profilePaths } from "../src/profiles";
import { error, ghostly } from "./support/cli";
// covers: headless.daemon, headless.cli

/**
 * Whatever listens where a profile's daemon should (on Windows a named pipe any account may open first) is sent
 * nothing at all until its greeting has proved, with the secret the daemon wrote in the profile's owner-only folder,
 * that it is the process holding the profile, now; then nothing but the hello until it has proved the same over the
 * client's own nonce. A listener that reads nothing from a pipe's client cannot impersonate it on Windows.
 */
const root = mkdtempSync("/tmp/gh-proof-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

type Line = { id?: unknown; method?: string; params?: { nonce?: string } };

/**
 * A listener on `socket` that writes `greet()` first on each connection (null: nothing), keeps every byte and line it
 * reads, and answers each line as `answer` says (null: no answer).
 */
async function impostor(socket: string, answer: (line: Line) => object | null, greet: () => object | string | null = () => null): Promise<{ lines: string[]; bytes: () => number; server: Server }> {
  const lines: string[] = [];
  let bytes = 0;
  const server = createServer((s: Socket) => {
    s.on("error", () => {});
    s.on("data", (chunk) => { bytes += chunk.length; });
    const first = greet();
    if (first !== null) s.write((typeof first === "string" ? first : JSON.stringify(first)) + "\n");
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
  return { lines, bytes: () => bytes, server };
}

const closed = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const methods = (lines: string[]) => lines.map((text) => { try { return (JSON.parse(text) as Line).method; } catch { return text; } });
const answersEverything = (line: Line) => ({ id: line.id ?? null, result: { running: true, profile: "default", proof: "00".repeat(32), version: "9.9.9" } });

/** A profile folder of this user's with a socket path in it, held (its lock) by this test's process. */
function profileAt(name: string): { dir: string; socket: string } {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(lockPath(dir), String(process.pid));
  return { dir, socket: join(dir, "daemon.sock") };
}

/** The pid of a process that has ended. */
async function deadPid(): Promise<number> {
  const child = spawn("true", { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

/** The first line a real daemon writes on a connection to `socket`, read without writing anything. */
function firstLine(socket: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const s = connect(socket);
    createInterface({ input: s }).once("line", (text) => { s.destroy(); resolve(text); });
  });
}

/** An events hub with nothing in it: enough for `events.subscribe` on a daemon served by `serve`. */
const quietHub = { lastSeq: 7, replay: () => [], onEvent: () => () => {} };

describe("a daemon's greeting", () => {
  it("proves the secret, the pid that holds the profile and the time; nothing else passes", async () => {
    const { dir } = profileAt("greeting-unit");
    const secret = newDaemonSecret(dir);
    const now = Date.now();
    expect(provesGreeting(secret, dir, greeting(secret, process.pid, now), now)).toBe(true);
    expect(provesGreeting(secret, dir, greeting(secret, process.pid, now - 9_000), now)).toBe(true);
    expect(provesGreeting(secret, dir, greeting(secret, process.pid, now - 11_000), now), "too old").toBe(false);
    expect(provesGreeting(secret, dir, greeting(secret, process.pid, now + 11_000), now), "from the future").toBe(false);
    expect(provesGreeting(Buffer.alloc(32), dir, greeting(secret, process.pid, now), now), "another secret").toBe(false);
    const forged = { greeting: { ...greeting(secret, process.pid, now).greeting, at: now + 1 } };
    expect(provesGreeting(secret, dir, forged, now), "a time it does not prove").toBe(false);
    expect(provesGreeting(secret, dir, { greeting: { pid: process.pid, at: now, proof: proof(secret, "daemon", `${process.pid}:${now}`) } }, now), "another role's proof").toBe(false);
    expect(provesGreeting(secret, dir, greeting(secret, 1, now), now), "a pid that does not hold the profile").toBe(false);
    const dead = await deadPid();
    writeFileSync(lockPath(dir), String(dead));
    expect(provesGreeting(secret, dir, greeting(secret, dead, now), now), "a holder that is gone").toBe(false);
    rmSync(lockPath(dir));
    expect(provesGreeting(secret, dir, greeting(secret, process.pid, now), now), "nobody holds the profile").toBe(false);
    for (const junk of [null, {}, { greeting: null }, { greeting: { pid: "1", at: now, proof: "00" } }, { id: "hello", result: { proof: "00".repeat(32) } }]) {
      expect(provesGreeting(secret, dir, junk, now), JSON.stringify(junk)).toBe(false);
    }
  });
});

describe.skipIf(process.platform === "win32")("a listener that is not this profile's daemon gets nothing", () => {
  it("a command to a listener that answers everything but cannot prove the secret is refused, and the listener read not a byte", async () => {
    const dir = join(root, "cli-home");
    createProfile(dir, "default");
    const paths = profilePaths(dir, "default");
    // The daemon's secret is there (one ran before); the listener cannot read it.
    writeFileSync(daemonSecretPath(paths.dir), "ab".repeat(32) + "\n", { mode: 0o600 });
    const seen = await impostor(paths.socket, answersEverything, () => ({ greeting: { pid: process.pid, at: Date.now(), proof: "00".repeat(32) } }));

    const status = error(await ghostly(["--home", dir, "daemon", "status"]), "refused", 1);
    expect(status.message).toContain("ghostly daemon restart");
    const token = "cashuBo2FteBtodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlIAJofKTJT5B5hcIOkYWEQYXN4QGZha2U";
    error(await ghostly(["--home", dir, "wallet", "redeem"], { input: token + "\n" }), "refused", 1);

    expect(seen.bytes(), seen.lines.join("\n")).toBe(0);
  });

  it("no greeting, a wrong one, a stale one, one from a pid that does not hold the profile, or junk: refused, with nothing written", async () => {
    const { dir, socket } = profileAt("greetings");
    const secret = newDaemonSecret(dir);
    const dead = await deadPid();
    const greets: [string, () => object | string | null][] = [
      ["no greeting (an older release's daemon, or one waiting for the client to speak)", () => null],
      ["a wrong proof", () => ({ greeting: { pid: process.pid, at: Date.now(), proof: "00".repeat(32) } })],
      ["a stale one", () => greeting(secret, process.pid, Date.now() - 60_000)],
      ["a pid that does not hold the profile", () => greeting(secret, dead, Date.now())],
      ["an answer instead", () => ({ id: "hello", result: { proof: proof(secret, "daemon", "00".repeat(16)) } })],
      ["not JSON", () => "hello?"],
    ];
    for (const [what, greet] of greets) {
      const seen = await impostor(socket, answersEverything, greet);
      const client = await connectDaemon({ dir, socket }, 1_000, { greetingMs: 300 });
      expect(client, what).not.toBeNull();
      const failure = await client!.call("chat.send", { chat: "bob", text: "a secret plan" }, { timeoutMs: 3_000 }).catch((e: unknown) => e) as CliError;
      expect(failure, what).toBeInstanceOf(CliError);
      expect(failure.code, what).toBe("refused");
      expect(failure.message, what).toContain("ghostly daemon restart");
      expect(seen.bytes(), what).toBe(0);
      await closed(seen.server);
      rmSync(socket, { force: true });
    }
  });

  it("a greeting copied from a real daemon proves nothing once that daemon stopped", async () => {
    const { dir, socket } = profileAt("copied");
    const real = await serve({ ctx: { runtime: { paths: { dir, socket } }, hub: quietHub } } as unknown as Host);
    // Any account may connect to a pipe read-only and read the greeting the daemon writes unasked.
    const copied = await firstLine(socket);
    const secret = Buffer.from(readFileSync(daemonSecretPath(dir), "utf8").trim(), "hex");
    expect(provesGreeting(secret, dir, JSON.parse(copied))).toBe(true);
    await real.close();
    rmSync(socket, { force: true });
    expect(existsSync(daemonSecretPath(dir)), "a daemon that stops removes its secret").toBe(false);

    const seen = await impostor(socket, answersEverything, () => copied);
    const client = await connectDaemon({ dir, socket }, 1_000, { greetingMs: 300 });
    expect((await client!.call("status", {}, { timeoutMs: 3_000 }).catch((e: unknown) => e) as CliError).code).toBe("refused");
    expect(seen.bytes()).toBe(0);
    await closed(seen.server);
    rmSync(socket, { force: true });

    // The residual: the secret left behind (a daemon that died without stopping) and its pid held, within the window,
    // by a live process of this user's (here the test's own). The copy then passes, and the hello is all that goes:
    // its answer must be over this client's nonce, which no copy can be.
    writeFileSync(daemonSecretPath(dir), secret.toString("hex") + "\n", { mode: 0o600 });
    const again = await impostor(socket, answersEverything, () => copied);
    const replayed = await connectDaemon({ dir, socket }, 1_000, { greetingMs: 300 });
    expect((await replayed!.call("status", {}, { timeoutMs: 3_000 }).catch((e: unknown) => e) as CliError).code).toBe("refused");
    expect(methods(again.lines)).toEqual(["daemon.hello"]);
  });

  it("after a good greeting: a wrong proof, a proof replayed from another hello, the client's own role, or an older daemon's error: refused, and only the hello was sent", async () => {
    const { dir, socket } = profileAt("replay");
    // A real daemon first, to capture one genuine proof over a nonce of an earlier hello.
    const real = await serve({ ctx: { runtime: { paths: { dir, socket } }, hub: quietHub } } as unknown as Host);
    // A hello made by hand: what a listener that once relayed a client to the daemon would have seen go by.
    const nonce = "11".repeat(16);
    const captured = await new Promise<string>((resolve) => {
      const s = connect(socket);
      const lines = createInterface({ input: s });
      lines.once("line", () => {
        s.write(JSON.stringify({ id: "h", method: "daemon.hello", params: { nonce } }) + "\n");
        lines.once("line", (text) => { s.destroy(); resolve((JSON.parse(text) as { result: { proof: string } }).result.proof); });
      });
    });
    const secret = Buffer.from(readFileSync(daemonSecretPath(dir), "utf8").trim(), "hex");
    await real.close();
    rmSync(socket, { force: true });
    expect(captured).toBe(proof(secret, "daemon", nonce));
    // A listener that read the secret (same user here) gets past the greeting: what the hello itself still refuses.
    writeFileSync(daemonSecretPath(dir), secret.toString("hex") + "\n", { mode: 0o600 });

    const answers: [string, (line: Line) => object | null][] = [
      ["wrong proof", (line) => ({ id: line.id, result: { proof: "00".repeat(32) } })],
      ["replayed proof", (line) => ({ id: line.id, result: { proof: captured } })],
      ["the client's role", (line) => ({ id: line.id, result: { proof: proof(secret, "client", line.params?.nonce ?? "") } })],
      ["an error", (line) => ({ id: line.id, error: { code: "bad_request", message: "Unknown method daemon.hello" } })],
      ["no proof at all", (line) => ({ id: line.id, result: { running: true } })],
    ];
    for (const [what, answer] of answers) {
      const seen = await impostor(socket, answer, () => greeting(secret));
      const client = await connectDaemon({ dir, socket }, 1_000);
      expect(client, what).not.toBeNull();
      const failure = await client!.call("chat.send", { chat: "bob", text: "a secret plan" }, { timeoutMs: 2_000 }).catch((e: unknown) => e) as CliError;
      expect(failure, what).toBeInstanceOf(CliError);
      expect(failure.code, what).toBe("refused");
      expect(failure.message, what).toContain("ghostly daemon restart");
      expect(methods(seen.lines), what).toEqual(["daemon.hello"]);
      await closed(seen.server);
      rmSync(socket, { force: true });
    }
  });

  it("a secret file anyone else may read, or none, proves nothing, and nothing is written", async () => {
    for (const mode of ["open", "missing"] as const) {
      const { dir, socket } = profileAt(`secret-${mode}`);
      const secret = Buffer.from("cd".repeat(32), "hex");
      if (mode === "open") { writeFileSync(daemonSecretPath(dir), secret.toString("hex") + "\n"); chmodSync(daemonSecretPath(dir), 0o644); }
      // The listener knows the secret here: only the file's place and mode can tell it is not the daemon's.
      const seen = await impostor(socket, (line) => ({ id: line.id, result: { proof: proof(secret, "daemon", line.params?.nonce ?? "") } }), () => greeting(secret));
      const client = await connectDaemon({ dir, socket }, 1_000);
      const failure = await client!.call("status", {}, { timeoutMs: 2_000 }).catch((e: unknown) => e) as CliError;
      expect(failure.code, mode).toBe("refused");
      expect(seen.bytes(), mode).toBe(0);
      await closed(seen.server);
    }
  });

  it("the profile's real daemon greets, proves itself, and its requests go through; its secret goes when it stops", async () => {
    const { dir, socket } = profileAt("real");
    const served = await serve({ ctx: { runtime: { paths: { dir, socket } }, hub: quietHub } } as unknown as Host);
    cleanups.push(() => served.close());
    const client = await connectDaemon({ dir, socket }, 1_000);
    expect(client).not.toBeNull();
    expect(await client!.subscribe(undefined, () => {})).toEqual({ subscribed: true, lastSeq: 7 });
    client!.close();
    // A fresh secret at every start, owner-only.
    expect(statSync(daemonSecretPath(dir)).mode & 0o777).toBe(0o600);
    await served.close();
    expect(existsSync(daemonSecretPath(dir))).toBe(false);
  });

  it("daemon stop still ends an older release's daemon, which does not greet, through the process that holds the profile", async () => {
    const dir = join(root, "old-daemon");
    createProfile(dir, "default");
    const paths = profilePaths(dir, "default");
    const seen = await impostor(paths.socket, (line) => ({ id: line.id ?? null, error: { code: "bad_request", message: "Unknown method" } }));
    const old = spawn("sh", ["-c", "while :; do sleep 1; done"], { stdio: "ignore" });
    cleanups.push(() => { old.kill("SIGKILL"); });
    writeFileSync(paths.lock, String(old.pid));
    const ended = new Promise<string | null>((resolve) => old.once("exit", (_, signalName) => resolve(signalName)));
    const result = await ghostly(["--home", dir, "daemon", "stop", "--timeout", "5"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json).toEqual({ stopped: true, pid: old.pid });
    expect(result.stderr).toContain("did not prove it is this profile's daemon");
    expect(await ended).toBe("SIGTERM");
    expect(seen.bytes()).toBe(0);
  });

  it("daemon stop with nobody holding the profile refuses what answers on its socket, having written nothing", async () => {
    const dir = join(root, "squatted");
    createProfile(dir, "default");
    const paths = profilePaths(dir, "default");
    writeFileSync(daemonSecretPath(paths.dir), "ab".repeat(32) + "\n", { mode: 0o600 });
    const seen = await impostor(paths.socket, (line) => ({ id: line.id ?? null, result: { pid: 1 } }), () => ({ greeting: { pid: 1, at: Date.now(), proof: "00".repeat(32) } }));
    error(await ghostly(["--home", dir, "daemon", "stop", "--timeout", "2"]), "refused", 1);
    expect(seen.bytes()).toBe(0);
  });
});
