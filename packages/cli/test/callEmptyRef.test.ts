import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heardCallSignal } from "@ghostly/core";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import packageJson from "../package.json" with { type: "json" };
import type { ApiContext } from "../src/apiKit";
import { CALL_METHODS } from "../src/calls/api";
import { CallManager } from "../src/calls/manager";
import { greeting, newDaemonSecret, proof } from "../src/daemonProof";
import { privateFolder } from "../src/privateFolder";
import { createProfile, profilePaths } from "../src/profiles";
import { ghostly, home } from "./support/cli";
// covers: headless.calls

/**
 * A call named as "" or blank (an unset variable in a script: `ghostly call hangup "$CALL"`) names no call. It was read
 * as left out, so it hung up, declined, answered or flushed the only call on, with no error. Now the command line
 * refuses it as a usage error (exit 2) before it opens the profile or asks the daemon, and the socket as bad_request;
 * left out, the only call is still the one meant. No media: the stack is missing, and the call only rings.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let quiet: ReturnType<typeof vi.spyOn>;
beforeEach(() => { quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true); });
afterEach(() => quiet.mockRestore());

const chat = (id: string): Partial<LinkView> => ({ id, profile: "paired-chat/1", callsUnavailable: null, label: `to ${id}` });

/** A daemon's manager on one fake chat, with the contact's call ringing in it. */
function ringing(): { ctx: ApiContext; calls: CallManager; id: string } {
  const dir = mkdtempSync(join(tmpdir(), "gcer-"));
  dirs.push(dir);
  const links = [chat("chat-ba")];
  const state = () => ({ links, groups: [], settings: { iceServers: [] } }) as unknown as EngineState;
  const calls = new CallManager({
    engine: { getState: state, chatView: (id) => state().links.find((l) => l.id === id), getSettings: () => state().settings, setCallSignal: () => {} },
    emit: () => {}, profileDir: dir, stack: async () => "no media in this test",
  });
  const offer = { t: "o", ts: Date.now(), u: "ufra", p: "p".repeat(22), f: "ab".repeat(32), s: "actpass", c: [], v: 0 };
  calls.onSignal("chat-ba", heardCallSignal(JSON.stringify(offer), Date.now()));
  const [call] = calls.list();
  return { ctx: { calls } as unknown as ApiContext, calls, id: call.call as string };
}

describe("an empty call ref over the socket", () => {
  it.each(["call.hangup", "call.answer", "call.get", "call.flush"])("%s with call \"\" or blank is bad_request, and the call stays", async (method) => {
    const { ctx, calls, id } = ringing();
    for (const call of ["", " ", "\t\n"]) {
      await expect(CALL_METHODS[method](ctx, { call })).rejects.toMatchObject({ code: "bad_request", message: `call ${JSON.stringify(call)} names no chat or call: name one, or leave it out for the only call` });
      expect(calls.list().map((c) => c.call)).toEqual([id]);
    }
    await calls.stopAll();
  });

  it("left out, the only call is still the one meant", async () => {
    const { ctx, calls, id } = ringing();
    await expect(CALL_METHODS["call.get"](ctx, {})).resolves.toMatchObject({ call: id, state: "ringing" });
    await expect(CALL_METHODS["call.get"](ctx, { call: null })).resolves.toMatchObject({ call: id });
    await expect(CALL_METHODS["call.hangup"](ctx, {})).resolves.toMatchObject({ call: id, state: "ended", reason: "hangup" });
    expect(calls.list()).toEqual([]);
    await calls.stopAll();
  });
});

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
