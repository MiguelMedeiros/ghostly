import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

/** The CLI stays off the public Mainline DHT in tests (it would bootstrap to the public routers): relays only, as the web app. */
const headlessEnv = (): NodeJS.ProcessEnv => ({ GHOSTLY_DHT: "0", ...process.env });

/**
 * The headless Ghostly (`packages/cli`, WISP 11xx) in a test: built once per worker, one profile per bot in a folder of
 * its own, pointed at the test's Pkarr relay. Its commands answer JSON; `listen` streams events.
 */
const ROOT = resolve(import.meta.dirname, "../..");
const BIN = join(ROOT, "packages/cli/dist/ghostly.mjs");
let built = false;

export function buildHeadless(): void {
  if (built) return;
  execFileSync("npm", ["run", "build", "-w", "@ghostlytools/cli"], { cwd: ROOT, stdio: "ignore" });
  built = true;
}

export class HeadlessBot {
  readonly home = mkdtempSync(join(tmpdir(), "ghostly-e2e-bot-"));
  private readonly running: ChildProcess[] = [];
  readonly events: Record<string, unknown>[] = [];

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
    buildHeadless();
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
    const child = spawn(process.execPath, [BIN, "--home", this.home, ...args], { env: { ...headlessEnv(), ...this.env }, stdio: ["ignore", "pipe", "inherit"] });
    this.running.push(child);
    return child;
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
