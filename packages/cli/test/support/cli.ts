import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect } from "vitest";

/** The built CLI (test/support/build.ts builds it before the tests). */
export const BIN = resolve(import.meta.dirname, "../../dist/ghostly.mjs");

export interface Result { code: number; stdout: string; stderr: string; json: Record<string, unknown> }

/** Runs `ghostly` to its end (asynchronously: the relay these tests serve lives in this process). */
export function ghostly(args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<Result> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(options.input ?? "");
    child.on("close", (code) => {
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(stdout.trim().split("\n").pop() ?? "{}"); } catch { /* not JSON */ }
      done({ code: code ?? -1, stdout, stderr, json });
    });
  });
}

/** Exit 0 and a JSON answer; otherwise the failure says why. */
export function ok(result: Result): Record<string, unknown> {
  expect(result.code, `exit ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
  return result.json;
}

/** A JSON error with this code and exit status. */
export function error(result: Result, code: string, exit: number): { code: string; message: string } {
  expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(exit);
  const failure = result.json.error as { code: string; message: string };
  expect(failure?.code).toBe(code);
  return failure;
}

/** A long-running `ghostly` (daemon, listen): its JSON lines as they come. */
export class Running {
  readonly lines: Record<string, unknown>[] = [];
  readonly child: ChildProcess;
  stderr = "";
  constructor(args: string[], env: NodeJS.ProcessEnv = {}) {
    this.child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout! }).on("line", (line) => { try { this.lines.push(JSON.parse(line)); } catch { /* not JSON */ } });
    this.child.stderr!.on("data", (d) => (this.stderr += d));
  }
  async waitFor(match: (line: Record<string, unknown>) => boolean, ms = 60_000): Promise<Record<string, unknown>> {
    const until = Date.now() + ms;
    for (;;) {
      const found = this.lines.find(match);
      if (found) return found;
      if (this.child.exitCode !== null) throw new Error(`exited ${this.child.exitCode}: ${this.stderr}`);
      if (Date.now() > until) throw new Error(`not seen in ${ms} ms; lines: ${JSON.stringify(this.lines).slice(0, 2000)}\n${this.stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  stop(): Promise<number | null> {
    if (this.child.exitCode !== null) return Promise.resolve(this.child.exitCode);
    return new Promise((done) => { this.child.once("exit", (code) => done(code)); this.child.kill("SIGTERM"); setTimeout(() => this.child.kill("SIGKILL"), 20_000).unref(); });
  }
}

/** A Pkarr relay in this process (as e2e/support/relay.ts): the newest signed packet per key. */
export async function localRelay(): Promise<{ url: string; server: Server }> {
  const packets = new Map<string, Buffer>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      const key = new URL(request.url ?? "/", "http://relay").pathname.slice(1);
      if (request.method === "PUT") {
        const body = Buffer.concat(chunks), known = packets.get(key);
        if (body.length >= 72 && (!known || body.readBigUInt64BE(64) >= known.readBigUInt64BE(64))) packets.set(key, body);
        response.writeHead(body.length >= 72 ? 204 : 400).end();
        return;
      }
      const packet = packets.get(key);
      response.writeHead(packet ? 200 : 404).end(packet);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** A HyperDHT network on loopback: the value of GHOSTLY_HYPERDHT_BOOTSTRAP. */
export async function hyperdhtTestnet(): Promise<{ bootstrap: string; destroy(): Promise<void> }> {
  const { default: createTestnet } = await import("hyperdht/testnet.js");
  const testnet = await createTestnet(3, { host: "127.0.0.1" });
  return { bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`).join(","), destroy: () => testnet.destroy() };
}

export const home = (name: string) => mkdtempSync(join(tmpdir(), `ghostly-${name}-`));
