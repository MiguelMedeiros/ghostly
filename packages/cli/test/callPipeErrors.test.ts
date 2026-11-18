import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { greeting, newDaemonSecret, proof } from "../src/daemonProof";
import { privateFolder } from "../src/privateFolder";
import { createProfile, profilePaths } from "../src/profiles";
import { ghostly, home } from "./support/cli";
// covers: headless.cli

/**
 * `call pipe`'s stdout is the contact's audio and nothing else: its failures go to stderr. They went to stdout as every
 * command's do, so `ghostly call pipe | aplay -f S16_LE` played the error as a click and the terminal said nothing.
 */
describe("call pipe's failures", { timeout: 60_000 }, () => {
  /** A daemon of this release, in this process, that answers `call.get` with `answer`. */
  async function daemonAnswering(answer: Record<string, unknown>): Promise<{ dir: string; server: Server }> {
    const dir = home("call-pipe-errors");
    createProfile(dir, "default");
    const { socket, dir: profileDir, lock } = profilePaths(dir, "default");
    if (dirname(socket) !== profileDir) privateFolder(dirname(socket), "the test's daemon will not put its socket there");
    const secret = newDaemonSecret(profileDir);
    writeFileSync(lock, String(process.pid));
    const server = createServer((connection) => {
      connection.write(JSON.stringify(greeting(secret)) + "\n");
      createInterface({ input: connection }).on("line", (line) => {
        const { id, method, params } = JSON.parse(line) as { id: number; method: string; params: { nonce?: string } };
        if (method === "daemon.hello") { connection.write(JSON.stringify({ id, result: { proof: proof(secret, "daemon", params.nonce!) } }) + "\n"); return; }
        if (method === "status") { connection.write(JSON.stringify({ id, result: { version: packageJson.version, profile: "default" } }) + "\n"); return; }
        connection.write(JSON.stringify({ id, ...answer }) + "\n");
      });
    });
    await new Promise<void>((listening, failed) => { server.once("error", failed); server.listen(socket, listening); });
    return { dir, server };
  }

  async function pipeFails(dir: string, code: string, exit: number, args: string[] = []): Promise<string> {
    const result = await ghostly(["--home", dir, "call", "pipe", ...args]);
    expect(result.code).toBe(exit);
    expect(result.stdout).toBe("");
    const failure = (JSON.parse(result.stderr.trim().split("\n").pop()!) as { error: { code: string; message: string } }).error;
    expect(failure.code).toBe(code);
    return failure.message;
  }

  it("no daemon runs the profile", async () => {
    const dir = home("call-pipe-no-daemon");
    createProfile(dir, "default");
    expect(await pipeFails(dir, "unavailable", 1)).toBe("No daemon runs profile default: calls need one (ghostly daemon --detach)");
  });

  it("no call is on, or the one named is not", async () => {
    const { dir, server } = await daemonAnswering({ error: { code: "not_found", message: "No call is on" } });
    try {
      expect(await pipeFails(dir, "not_found", 3)).toBe("No call is on");
      expect(await pipeFails(dir, "not_found", 3, ["bob"])).toBe("No call is on");
    } finally {
      server.close();
    }
  });

  it("the call rings and has no audio yet", async () => {
    const { dir, server } = await daemonAnswering({ result: { call: "0123456789ab", audio: null } });
    try {
      expect(await pipeFails(dir, "unavailable", 1)).toBe("That call has no audio yet: answer it first");
    } finally {
      server.close();
    }
  });

  it("other commands still answer their failures on stdout", async () => {
    const result = await ghostly(["--home", home("call-pipe-other"), "call", "frob"]);
    expect(result).toMatchObject({ code: 2, stderr: "", json: { error: { code: "usage" } } });
  });
});
