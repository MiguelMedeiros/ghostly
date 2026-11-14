import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { greeting, newDaemonSecret, proof } from "../src/daemonProof";
import { privateFolder } from "../src/privateFolder";
import { createProfile, profilePaths } from "../src/profiles";
import { BIN, home, testEnv } from "./support/cli";
// covers: headless.cli

const CALL = "0123456789ab";
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/**
 * A daemon of this release, in this process, with one call on: `call.get` answers it while `on()`, events go to the
 * subscribed connection, and the call's audio socket is `audio`.
 */
async function daemonWithCall(on: () => boolean): Promise<{ dir: string; audio: Promise<Socket>; emit(event: Record<string, unknown>): void }> {
  const dir = home("call-pipe-end");
  createProfile(dir, "default");
  const { socket, dir: profileDir, lock } = profilePaths(dir, "default");
  if (dirname(socket) !== profileDir) privateFolder(dirname(socket), "the test's daemon will not put its socket there");
  const secret = newDaemonSecret(profileDir);
  writeFileSync(lock, String(process.pid));
  const audioPath = join(profileDir, "call.sock");
  let program: (socket: Socket) => void = () => {};
  const audio = new Promise<Socket>((resolve) => (program = resolve));
  const audioServer = createServer((connection) => program(connection));
  const subscribed: Socket[] = [];
  const server = createServer((connection) => {
    connection.write(JSON.stringify(greeting(secret)) + "\n");
    createInterface({ input: connection }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line) as { id: number; method: string; params: { nonce?: string } };
      const answer = (body: Record<string, unknown>) => connection.write(JSON.stringify({ id, ...body }) + "\n");
      if (method === "daemon.hello") answer({ result: { proof: proof(secret, "daemon", params.nonce!) } });
      else if (method === "status") answer({ result: { version: packageJson.version, profile: "default" } });
      else if (method === "events.subscribe") { subscribed.push(connection); answer({ result: { subscribed: true, lastSeq: 0 } }); }
      else if (method === "call.get" && on()) answer({ result: { call: CALL, state: "connected", audio: { socket: audioPath, token: "ab".repeat(32), rate: 48000 } } });
      else answer({ error: { code: "not_found", message: "No call is on" } });
    });
  });
  servers.push(server, audioServer);
  for (const [s, path] of [[server, socket], [audioServer, audioPath]] as const) {
    await new Promise<void>((listening, failed) => { s.once("error", failed); s.listen(path, listening); });
  }
  let seq = 0;
  return { dir, audio, emit: (event) => { for (const c of subscribed) c.write(JSON.stringify({ event: { seq: ++seq, id: `e${seq}`, at: Date.now(), ...event } }) + "\n"); } };
}

function pipe(dir: string): { said: () => string; exit: Promise<number | null> } {
  const child = spawn(process.execPath, [BIN, "--home", dir, "call", "pipe"], { env: testEnv(), stdio: ["pipe", "pipe", "pipe"] });
  let said = "";
  child.stderr.on("data", (d) => (said += d));
  child.stdout.resume();
  return { said: () => said, exit: new Promise((resolve) => child.once("exit", resolve)) };
}

/**
 * `call pipe` says why it leaves. Another `call pipe` taking the call's audio, the contact hanging up and a contact
 * declining a call still ringing all ended it with exit 0 and no word after its first line.
 */
describe("call pipe's end", { timeout: 30_000 }, () => {
  it("another program took the call's audio: the call goes on", async () => {
    const daemon = await daemonWithCall(() => true);
    const run = pipe(daemon.dir);
    const program = await daemon.audio;
    await expect.poll(run.said).toContain("on stdin/stdout");
    program.end();
    expect(await run.exit).toBe(0);
    expect(run.said()).toContain(`ghostly: call ${CALL}: another program took its audio; the call goes on\n`);
  });

  it("the call ended: its reason, from the daemon's call.ended", async () => {
    let on = true;
    const daemon = await daemonWithCall(() => on);
    const run = pipe(daemon.dir);
    const program = await daemon.audio;
    await expect.poll(run.said).toContain("on stdin/stdout");
    // As the daemon ends a call: gone from its calls, the socket closed, then call.ended once the contact is told.
    on = false;
    program.end();
    await new Promise((resolve) => setTimeout(resolve, 200));
    daemon.emit({ type: "call.ended", call: CALL, chat: "c", direction: "in", reason: "remote-hangup" });
    expect(await run.exit).toBe(0);
    expect(run.said()).toContain(`ghostly: call ${CALL}: the call ended (remote-hangup)\n`);
  });

  it("a call.ended of another call is not this one's", async () => {
    let on = true;
    const daemon = await daemonWithCall(() => on);
    const run = pipe(daemon.dir);
    const program = await daemon.audio;
    await expect.poll(run.said).toContain("on stdin/stdout");
    daemon.emit({ type: "call.ended", call: "ffffffffffff", chat: "d", direction: "out", reason: "rejected" });
    on = false;
    program.end();
    expect(await run.exit).toBe(0);
    expect(run.said()).toContain(`ghostly: call ${CALL}: the call ended\n`);
  });
});
