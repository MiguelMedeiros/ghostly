import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectDaemon } from "../src/client";
import { CliError } from "../src/errors";
import { answerWithin } from "../src/main";
import { createProfile, profilePaths } from "../src/profiles";
import { error, home, Running, type Result } from "./support/cli";
// covers: headless.daemon, headless.cli

describe("a daemon that accepts the socket but never answers", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  /** A profile whose socket accepts the connection, reads nothing and writes nothing: the daemon's event loop wedged. */
  async function wedged(name: string): Promise<{ dir: string; paths: ReturnType<typeof profilePaths>; received: () => string }> {
    const dir = home(name);
    createProfile(dir, "default");
    const paths = profilePaths(dir, "default");
    let received = "";
    const server: Server = createServer((socket) => { socket.on("data", (chunk) => (received += chunk.toString())); socket.on("error", () => {}); });
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    cleanups.push(() => { server.close(); rmSync(paths.socket, { force: true }); });
    return { dir, paths, received: () => received };
  }

  /** The command's result, or a failure in `ms` that leaves no `ghostly` behind (the old code hung for ever). */
  async function within(ms: number, args: string[]): Promise<Result> {
    const run = new Running(args);
    try {
      const code = await run.exited(ms);
      return { code: code ?? -1, stdout: JSON.stringify(run.lines), stderr: run.stderr, json: run.lines.at(-1) ?? {} };
    } finally { await run.stop(); }
  }

  it("daemon status gives up after --timeout with code timeout (exit 4) and names the way out", async () => {
    const { dir } = await wedged("hung-daemon");
    const started = Date.now();
    const failure = error(await within(8_000, ["--home", dir, "daemon", "status", "--timeout", "0.5"]), "timeout", 4);
    expect(Date.now() - started, "gave up near the deadline, not at the connect timeout or never").toBeLessThan(3_000);
    expect(failure.message).toMatch(/did not answer status in 0\.5 s/);
    expect(failure.message).toContain("ghostly daemon restart");
  });

  it("a write gives up when the version check sent first has no answer in 15 s, with code timeout (exit 4), and was never sent", async () => {
    const { dir, received } = await wedged("hung-write");
    const started = Date.now();
    const failure = error(await within(25_000, ["--home", dir, "send", "bob", "hi", "--wait", "none"]), "timeout", 4);
    expect(Date.now() - started, "gave up at the check's 15 s, not never").toBeLessThan(20_000);
    expect(failure.message).toMatch(/did not answer in 15 s; nothing was done/);
    expect(failure.message).toContain("ghostly daemon restart");
    // Only the check went out: a daemon that wakes later (SIGCONT) finds no message to send in its socket.
    expect(received()).toContain('"method":"status"');
    expect(received()).not.toContain("chat.send");
  }, 30_000);

  it("daemon stop ends the process that holds the profile when the daemon does not answer: restart can then start a fresh one", async () => {
    const { dir, paths } = await wedged("hung-stop");
    // The wedged daemon's process: one that ignores SIGTERM, as a daemon whose event loop runs no handler does.
    const stuck = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
    cleanups.push(() => stuck.kill("SIGKILL"));
    writeFileSync(paths.lock, String(stuck.pid));
    const ended = new Promise<string | null>((resolve) => stuck.once("exit", (_, signalName) => resolve(signalName)));
    const result = await within(15_000, ["--home", dir, "daemon", "stop", "--timeout", "1"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json).toEqual({ stopped: true, pid: stuck.pid });
    expect(result.stderr).toContain(`process ${stuck.pid}) did not answer daemon.stop in 1 s`);
    expect(result.stderr).toContain("did not stop on SIGTERM in 1 s: killing it");
    expect(await ended).toBe("SIGKILL");
  });

  it("the version check sent ahead of a command has no deadline of its own: the command's ends both, as the command's timeout", async () => {
    const { paths } = await wedged("hung-check");
    const client = (await connectDaemon(paths.socket))!;
    expect(client).toBeTruthy();
    // As session() does: the check first, the command behind it on the same connection, only the command with a deadline.
    const check = client.call("status").catch((error: unknown) => error);
    const started = Date.now();
    const command = client.call("chat.wait", { chat: "bob" }, { timeoutMs: 300 }).catch((error: unknown) => error);
    const failure = await command as CliError;
    expect(failure).toBeInstanceOf(CliError);
    expect(failure.code).toBe("timeout");
    expect(failure.details).toEqual({ method: "chat.wait" });
    expect(Date.now() - started).toBeLessThan(3_000);
    // Ended by the command's deadline closing the connection; nothing waits for it. A deadline of its own, shorter
    // than the command's, closed the connection under the command instead, which then failed as unavailable.
    expect((await check as CliError).code).toBe("unavailable");
  });

  it("a command's deadline: a read 15 s, a wait its --timeout or the daemon's default plus 10 s, anything else none", () => {
    expect(answerWithin("status", {})).toBe(15_000);
    expect(answerWithin("chat.list", {})).toBe(15_000);
    expect(answerWithin("chat.wait", { chat: "bob", timeout: 5 })).toBe(15_000);
    // A --timeout the daemon refuses still makes a timer Node takes: -10 s fired at once, 1e12 after 1 ms.
    expect(answerWithin("chat.wait", { chat: "bob", timeout: -10 })).toBe(11_000);
    expect(answerWithin("chat.wait", { chat: "bob", timeout: 1e12 })).toBe(86_410_000);
    expect(answerWithin("chat.wait", { chat: "bob" })).toBe(70_000);
    expect(answerWithin("file.wait", { file: "f1" })).toBe(310_000);
    expect(answerWithin("file.save", { file: "f1", wait: true })).toBe(310_000);
    expect(answerWithin("file.save", { file: "f1" })).toBeUndefined();
    expect(answerWithin("chat.send", { chat: "bob", text: "hi", wait: "sent" })).toBe(40_000);
    expect(answerWithin("chat.send", { chat: "bob", text: "hi", wait: "sent", timeout: 120 })).toBe(130_000);
    expect(answerWithin("chat.send", { chat: "bob", text: "hi", wait: "none" })).toBeUndefined();
    expect(answerWithin("group.send", { group: "g", text: "hi" })).toBeUndefined();
    expect(answerWithin("events.subscribe", {})).toBeUndefined();
    expect(answerWithin("identity.add", { provider: "x" })).toBeUndefined();
  });
});
