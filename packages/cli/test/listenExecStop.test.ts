import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: headless.cli

/**
 * A listen stopped while its --exec hook runs: the hook does not run on as an orphan, the cursor stays before the
 * event it did not finish, and the restarted listen runs that event's hook again, never alongside the old one.
 */
let relay: { url: string; server: HttpServer };
let dht: { bootstrap: string; destroy(): Promise<void> };
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  relay = await localRelay();
  dht = await hyperdhtTestnet();
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relay.url };
}, 30_000);

afterAll(async () => {
  await dht?.destroy();
  relay?.server.close();
}, 30_000);

/** A zombie is not alive: it ended, and only waits for its new parent to reap it. */
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.[0] !== "Z"; } catch { return true; }
};
/**
 * Gone within a moment. The hook's pid is its shell's, a grandchild of the listen (`sh -c` runs it in a shell of its
 * own): the listen leaves once that `sh -c` exits, and the shell, killed with it, can still be dying, or a zombie the
 * process it was handed to has not reaped yet. A hook left running on its own (`sleep 30`) is still there.
 */
const gone = async (pid: number, ms = 5_000) => {
  for (const until = Date.now() + ms; Date.now() < until;) { if (!alive(pid)) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return !alive(pid);
};

async function until<T>(read: () => T | undefined, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`${what}: not seen in ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("listen --exec stopped while its hook runs", { timeout: 120_000 }, () => {
  // SIGHUP: the terminal or SSH session the listen ran in closed. Unhandled, it ended Node with no 'exit' event, so
  // the hook (in a process group of its own) ran on, and the next listen ran its event again beside it.
  const cases = [
    { withDaemon: true, stopSignal: "SIGTERM" },
    { withDaemon: true, stopSignal: "SIGHUP" },
    { withDaemon: false, stopSignal: "SIGTERM" },
  ] as const;
  for (const { withDaemon, stopSignal } of cases) {
    it(`ends the hook and keeps the cursor before its event on ${stopSignal}, ${withDaemon ? "following a daemon" : "running the profile itself"}`, async () => {
      const dir = home(`exec-stop-${withDaemon ? "daemon" : "own"}-${stopSignal.toLowerCase()}`);
      ok(await ghostly(["--home", dir, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
      const log = join(dir, "hook.log"), cursor = join(dir, "cursor"), hook = join(dir, "hook.sh");
      // Only chat.created is slow; daemon.started passes at once (it tells the test the listen is up).
      writeFileSync(hook, `[ "$GHOSTLY_EVENT_TYPE" = chat.created ] || exit 0\necho "start $$ $GHOSTLY_EVENT_SEQ" >> '${log}'\nsleep 30\necho "done $$ $GHOSTLY_EVENT_SEQ" >> '${log}'\n`);
      writeFileSync(cursor, "0\n");
      const args = ["--home", dir, "listen", "--type", "chat.created", "--type", "daemon.started", "--print", "--cursor", cursor, "--exec", `sh '${hook}'`];
      const starts = () => (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter((line) => line.startsWith("start ")).map((line) => line.split(" ").slice(1).map(Number));
      if (withDaemon) ok(await ghostly(["--home", dir, "daemon", "--detach"], { env }));
      let listen = new Running(args, env);
      try {
        await listen.waitFor((line) => line.type === "daemon.started");
        ok(await ghostly(["--home", dir, "invite", "create", "--label", "slow"], { env }));
        const [pid, seq] = await until(() => starts()[0], 30_000, "the hook's start");
        expect(alive(pid)).toBe(true);
        listen.child.kill(stopSignal);
        await listen.exited(30_000);
        // No orphan: the hook is gone with the listen, and it never finished.
        expect(await gone(pid), `the hook ${pid} still runs after the listen stopped\n${listen.stderr}`).toBe(true);
        expect(Number(readFileSync(cursor, "utf8").trim())).toBeLessThan(seq);
        expect(listen.stderr).toContain(`ghostly: stopped while --exec ran on event ${seq} (chat.created): ended it, and the event is handed again at the next start`);
        // The restarted listen hands the event again, once, with no other hook of it running.
        listen = new Running(args, env);
        const [again, seqAgain] = await until(() => starts()[1], 30_000, "the restarted hook's start");
        expect(seqAgain).toBe(seq);
        expect(again).not.toBe(pid);
        expect(alive(pid)).toBe(false);
        expect(readFileSync(log, "utf8")).not.toContain("done ");
        listen.child.kill("SIGTERM");
        await listen.exited(30_000);
        expect(await gone(again), `the hook ${again} still runs after the listen stopped\n${listen.stderr}`).toBe(true);
      } finally {
        await listen.stop();
        if (withDaemon) await ghostly(["--home", dir, "daemon", "stop"], { env });
      }
    });
  }
});
