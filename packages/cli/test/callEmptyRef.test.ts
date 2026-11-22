import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { greeting, newDaemonSecret, proof } from "../src/daemonProof";
import { privateFolder } from "../src/privateFolder";
import { createProfile, profilePaths } from "../src/profiles";
import { ghostly, home } from "./support/cli";
// covers: headless.calls

/**
 * A call named on the command line as "" or blank (an unset variable in a script: `ghostly call hangup "$CALL"`) names
 * no call. It was read as left out, so it hung up, declined, answered or flushed the only call on, with no error. Now
 * the command line refuses it as a usage error (exit 2) before it asks the daemon; left out, the only call is still
 * the one meant.
 */
let quiet: ReturnType<typeof vi.spyOn>;
beforeEach(() => { quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true); });
afterEach(() => quiet.mockRestore());

describe("an empty <chat|call> on the command line", { timeout: 60_000 }, () => {
  /** A daemon of this release, in this process, that answers every call.* method as done and records it. */
  async function daemon(): Promise<{ dir: string; server: Server; asked: { method: string; params: unknown }[] }> {
    const dir = home("call-empty-ref");
    createProfile(dir, "default");
    const { socket, dir: profileDir, lock } = profilePaths(dir, "default");
    if (dirname(socket) !== profileDir) privateFolder(dirname(socket), "the test's daemon will not put its socket there");
    const secret = newDaemonSecret(profileDir);
    writeFileSync(lock, String(process.pid));
    const asked: { method: string; params: unknown }[] = [];
    const server = createServer((connection) => {
      connection.write(JSON.stringify(greeting(secret)) + "\n");
      createInterface({ input: connection }).on("line", (line) => {
        const { id, method, params } = JSON.parse(line) as { id: number; method: string; params: { nonce?: string } };
        if (method === "daemon.hello") { connection.write(JSON.stringify({ id, result: { proof: proof(secret, "daemon", params.nonce!) } }) + "\n"); return; }
        if (method === "status") { connection.write(JSON.stringify({ id, result: { version: packageJson.version, profile: "default" } }) + "\n"); return; }
        if (method.startsWith("call.")) asked.push({ method, params });
        connection.write(JSON.stringify({ id, result: { call: "0123456789ab", state: "ended", reason: "hangup", audio: null } }) + "\n");
      });
    });
    await new Promise<void>((listening, failed) => { server.once("error", failed); server.listen(socket, listening); });
    return { dir, server, asked };
  }

  it("call answer, flush, hangup and pipe refuse \"\" or blank as a usage error (exit 2), before asking the daemon", async () => {
    const { dir, server, asked } = await daemon();
    try {
      for (const command of ["answer", "flush", "hangup", "pipe"]) {
        for (const ref of ["", " "]) {
          const result = await ghostly(["--home", dir, "call", command, ref]);
          // `call pipe` says its failures on stderr: its stdout is the call's audio.
          const out = command === "pipe" ? result.stderr : result.stdout;
          const failure = (JSON.parse(out.trim().split("\n").pop()!) as { error: { code: string; message: string } }).error;
          expect({ command, ref, code: result.code, failure }).toEqual({
            command, ref, code: 2,
            failure: { code: "usage", message: `<chat|call> ${JSON.stringify(ref)} names no chat or call: name one, or leave it out for the only call: ghostly call ${command} [<chat|call>]${command === "answer" ? " [--rate 48000]" : ""}` },
          });
        }
      }
      expect(asked).toEqual([]);
      // Left out, the daemon is asked for the only call, as before.
      expect((await ghostly(["--home", dir, "call", "hangup"])).code).toBe(0);
      expect(asked).toEqual([{ method: "call.hangup", params: {} }]);
    } finally {
      server.close();
    }
  });
});
