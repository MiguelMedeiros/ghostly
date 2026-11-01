import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it, vi } from "vitest";
import { connectDaemon } from "../src/client";
import { greeting, HELLO, newDaemonSecret, proof } from "../src/daemonProof";
import type { CliError } from "../src/errors";
import { serve, type Host } from "../src/host";
import { lockPath } from "../src/profiles";
// covers: headless.daemon

/** The daemon's `chat.send --wait delivered` to a contact who is away: the message is stored and waits for them. */
const calls = vi.hoisted(() => ({ received: 0 }));
vi.mock("../src/api", async () => {
  const { waitForMessage } = await import("../src/waits");
  return {
    callApi: (ctx: Parameters<typeof waitForMessage>[0], method: string) => {
      calls.received++;
      if (method !== "chat.send") return Promise.resolve(null);
      return waitForMessage(ctx, "bob", "me_1", "delivered", 60_000);
    },
  };
});

const root = mkdtempSync(join(tmpdir(), "gh-stop-answers-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A folder held by this process, as a daemon holds its profile: the client checks its greeting's pid against the lock. */
function profileDir(name: string): { dir: string; socket: string } {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(lockPath(dir), String(process.pid));
  return { dir, socket: join(dir, "daemon.sock") };
}

describe.skipIf(process.platform === "win32")("a daemon that stops while a call waits", () => {
  it("answers a send --wait still waiting before it ends the connection: timeout, with messageId, delivery and reason daemon-stopped", async () => {
    const address = profileDir("send-wait");
    const node = { getMessage: async (_chat: string, id: string) => ({ id, delivery: "waiting" }) };
    const ctx = { runtime: { paths: address, server: { node } }, hub: { onEvent: () => () => {} }, mode: "daemon" };
    const served = await serve({ ctx } as unknown as Host);
    const client = (await connectDaemon(address))!;
    const sent = client.call("chat.send", { chat: "bob", text: "midwait", wait: "delivered", timeout: 60 }).catch((error: unknown) => error);
    await expect.poll(() => calls.received).toBe(1);
    await served.close();
    const failure = await sent as CliError;
    // Before: unavailable (exit 1) "The daemon went away", no messageId, though the message was stored and went on.
    expect(failure.code).toBe("timeout");
    expect(failure.details).toEqual({ messageId: "me_1", delivery: "waiting", reason: "daemon-stopped" });
    expect(failure.message).toBe("The daemon stopped before the wait ended: the message is waiting and goes by itself once this profile is online again");
  });

  /** A daemon that proves itself, then goes away (a crash, SIGKILL) as soon as it reads `method`, never answering it. */
  async function goneOn(name: string, method: string): Promise<{ address: { dir: string; socket: string }; server: Server }> {
    const address = profileDir(name);
    const secret = newDaemonSecret(address.dir);
    const server = createServer((connection: Socket) => {
      connection.on("error", () => {});
      connection.write(JSON.stringify(greeting(secret)) + "\n");
      createInterface({ input: connection }).on("line", (line) => {
        const request = JSON.parse(line) as { id: string; method: string; params: { nonce?: string } };
        if (request.method === method) { connection.destroy(); return; }
        if (request.method === HELLO) connection.write(JSON.stringify({ id: request.id, result: { proof: proof(secret, "daemon", request.params.nonce!) } }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(address.socket, resolve));
    return { address, server };
  }

  it("a call it read and never answered fails as timeout with reason daemon-stopped: it may be done, so it is no plain failure", async () => {
    const { address, server } = await goneOn("crashed", "chat.send");
    try {
      const client = (await connectDaemon(address))!;
      const failure = await client.call("chat.send", { chat: "bob", text: "hi" }).catch((error: unknown) => error) as CliError;
      expect(failure.code).toBe("timeout");
      expect(failure.details).toEqual({ method: "chat.send", reason: "daemon-stopped" });
      expect(failure.message).toContain("The daemon stopped before it answered chat.send, which may be done");
      expect(failure.message).toContain("ghostly chat history");
    } finally { server.close(); }
  });

  it("a call never written (the daemon went away before its hello was answered) is still unavailable: nothing was sent", async () => {
    const { address, server } = await goneOn("gone-early", HELLO);
    try {
      const client = (await connectDaemon(address))!;
      const failure = await client.call("chat.send", { chat: "bob", text: "hi" }).catch((error: unknown) => error) as CliError;
      expect(failure.code).toBe("unavailable");
      expect(failure.message).toBe("The daemon went away");
      expect(failure.details).toBeUndefined();
    } finally { server.close(); }
  });
});
