import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { TestInfo } from "@playwright/test";

/** The CLI stays off the public Mainline DHT in tests (it would bootstrap to the public routers): relays only, as the web app. */
const headlessEnv = (): NodeJS.ProcessEnv => ({ GHOSTLY_DHT: "0", ...process.env });

/**
 * The headless Ghostly (`packages/cli`, WISP 1100) in a test: built once per run before the workers start
 * (support/headlessBuild.ts, the configs' globalSetup), one profile per bot in a folder of its own, pointed at the
 * test's Pkarr relay. Its commands answer JSON; `listen` streams events.
 */
const ROOT = resolve(import.meta.dirname, "../..");
const BIN = join(ROOT, "packages/cli/dist/ghostly.mjs");

/** A worker never builds: the build empties dist/ under the bots of the other workers. */
function assertBuilt(): void {
  if (!existsSync(BIN)) throw new Error(`${BIN} is missing: the Playwright config's globalSetup (support/headlessBuild.ts) builds it`);
}

export class HeadlessBot {
  readonly home = mkdtempSync(join(tmpdir(), "ghostly-e2e-bot-"));
  private readonly running: ChildProcess[] = [];
  readonly events: Record<string, unknown>[] = [];
  /** What the daemon and the listener wrote to stderr (still shown as they write it), for `attachLogs`. */
  private stderr = "";
  /** The daemon's steps on each chat's way to live (`GHOSTLY_LINK_TRACE`), for `attachLogs`. */
  private readonly linkTrace = join(this.home, "link-trace.jsonl");

  /** `env`: more environment for every command and the daemon (the CLI's test switches). */
  constructor(private readonly env: NodeJS.ProcessEnv = {}) {}

  /** Runs one command to its end; rejects with the CLI's JSON error. */
  run(...args: string[]): Promise<Record<string, unknown>> {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [BIN, "--home", this.home, ...args], { env: { ...headlessEnv(), ...this.env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(out.trim().split("\n").pop() ?? "{}"); } catch { /* not JSON */ }
        if (code === 0) done(json); else fail(new Error(`ghostly ${args.join(" ")} exited ${code}: ${out}${err}`));
      });
    });
  }

  /** The profile's daemon, and a listener collecting its events. */
  async start(relay: string, name: string): Promise<void> {
    assertBuilt();
    await this.run("settings", "set", "relays", JSON.stringify([relay]));
    await this.run("profile", "set", "--name", name);
    const daemon = this.spawn("daemon");
    await new Promise<void>((ready, fail) => {
      createInterface({ input: daemon.stdout! }).on("line", (line) => { if (line.includes('"ready"')) ready(); });
      daemon.once("exit", (code) => fail(new Error(`the daemon exited ${code}`)));
    });
    const listen = this.spawn("listen");
    createInterface({ input: listen.stdout! }).on("line", (line) => { try { this.events.push(JSON.parse(line)); } catch { /* not JSON */ } });
  }

  private spawn(...args: string[]): ChildProcess {
    const env = { ...headlessEnv(), GHOSTLY_LINK_TRACE: this.linkTrace, ...this.env };
    const child = spawn(process.execPath, [BIN, "--home", this.home, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (d: Buffer) => { this.stderr += d; process.stderr.write(d); });
    this.running.push(child);
    return child;
  }

  /**
   * The bot's side of a failure, in the test's report: its daemon's stderr and its link trace. Called from a spec's
   * `catch` before `stop` (which deletes the profile folder), so a chat or group edge that never went live can be
   * followed on both sides (One's nightly run, 2026-10-05: a group edge with the web app that never came up).
   */
  async attachLogs(info: TestInfo): Promise<void> {
    if (this.stderr) await info.attach("bot-stderr.log", { body: this.stderr, contentType: "text/plain" });
    if (existsSync(this.linkTrace)) await info.attach("bot-link-trace.jsonl", { body: readFileSync(this.linkTrace), contentType: "text/plain" });
  }

  /** The first event that matches, waiting for it. */
  async event(match: (event: Record<string, unknown>) => boolean, ms = 90_000): Promise<Record<string, unknown>> {
    const until = Date.now() + ms;
    for (;;) {
      const found = this.events.find(match);
      if (found) return found;
      if (Date.now() > until) throw new Error(`No such event in ${ms} ms; saw ${JSON.stringify(this.events.map((e) => e.type))}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.running.map((child) => new Promise<void>((done) => {
      if (child.exitCode !== null) return done();
      child.once("exit", () => done());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 20_000).unref();
    })));
    rmSync(this.home, { recursive: true, force: true });
  }
}
