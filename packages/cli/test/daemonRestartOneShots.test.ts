import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, localRelay, ok, type Result } from "./support/cli";
// covers: headless.daemon

/**
 * `daemon restart` stops the daemon and starts a fresh one. In between, nothing held the profile, and a bot's one-shot
 * commands (a gateway's `typing`, `send`, `usage send`), each waiting its turn for the profile, took it one after the
 * other: the new daemon, seconds to boot, never found it free, and the restart failed busy with the profile left with
 * no daemon (for 15 minutes on one machine, until `daemon --detach` was retried every second).
 */
describe.skipIf(process.platform === "win32")("daemon restart while one-shot commands keep coming", { timeout: 180_000 }, () => {
  let relay: Awaited<ReturnType<typeof localRelay>>;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    relay = await localRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
  });
  afterAll(() => { relay?.server.close(); });

  it("keeps the profile for the new daemon: the restart ends with it running, and the commands keep answering", async () => {
    const dir = home("restart-one-shots");
    ok(await ghostly(["--home", dir, "settings", "set", "relays", JSON.stringify([relay.url])], { env }));
    const chat = ok(await ghostly(["--home", dir, "invite", "create", "--label", "bob"], { env })).chat as string;
    const first = ok(await ghostly(["--home", dir, "daemon", "--detach"], { env }));
    // Four overlapping loops of a bot's typing indicator (`--for 1`: a one-shot holds the profile that long), each
    // started as the one before it ends: with no daemon, one of them always waits for the profile.
    let going = true;
    const results: Result[] = [];
    const loop = async () => { while (going) results.push(await ghostly(["--home", dir, "typing", chat, "--for", "1"], { env })); };
    const loops = [0, 1, 2, 3].map((i) => new Promise((resolve) => setTimeout(resolve, i * 150)).then(loop));
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const restarted = await ghostly(["--home", dir, "daemon", "restart", "--timeout", "20"], { env });
      // The commands go on a moment after the restart, through the new daemon.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      going = false;
      await Promise.all(loops);
      expect(ok(restarted)).toMatchObject({ restarted: true, stopped: first.pid, daemon: "started" });
      expect(ok(await ghostly(["--home", dir, "daemon", "status"], { env }))).toMatchObject({ running: true, pid: restarted.json.pid });
      // Every command answered: through a daemon, or on the profile while no daemon ran; none busy, none "The daemon
      // went away". The one exception is the documented answer for a change the old daemon read as it stopped (it may
      // be done: `daemon-stopped`, exit 4), which a loaded machine sometimes draws.
      const stoppedUnder = (result: Result) => result.code === 4 && (result.json.error as { details?: { reason?: string } } | undefined)?.details?.reason === "daemon-stopped";
      expect(results.filter((result) => result.code !== 0 && !stoppedUnder(result)).map((result) => result.stdout + result.stderr)).toEqual([]);
      expect(results.length).toBeGreaterThan(4);
    } finally {
      going = false;
      await Promise.all(loops);
      await ghostly(["--home", dir, "daemon", "stop"], { env });
    }
  });
});
