import { afterAll, describe, expect, it } from "vitest";
import { error, ghostly, home, ok, Running } from "./support/cli";

// covers: headless.daemon

/**
 * A `--timeout` past what a Node timer holds (about 24.8 days) fired after 1 ms: `daemon stop --timeout 3000000` sent a
 * healthy daemon SIGTERM at once, saying it had not answered in 3000000 s. Past a day it is a usage error, as the socket
 * calls' waits stop at a day (`answerWithin`).
 */
describe("daemon --timeout past a day", { timeout: 120_000 }, () => {
  const dir = home("daemon-timeout-bound");
  const env = { GHOSTLY_PKARR_RELAYS: "http://127.0.0.1:9", GHOSTLY_IROH_RELAYS: "http://127.0.0.1:9", GHOSTLY_HYPERDHT_BOOTSTRAP: "127.0.0.1:9", GHOSTLY_STUN: "0" };
  let daemon: Running | undefined;
  afterAll(async () => { await daemon?.stop(); });

  it("is a usage error, and the daemon is left running", async () => {
    daemon = new Running(["--home", dir, "daemon"], env);
    await daemon.waitFor((line) => line.daemon === "ready");
    for (const command of [["daemon", "stop"], ["daemon", "restart"], ["daemon", "status"]]) {
      expect(error(await ghostly(["--home", dir, ...command, "--timeout", "3000000"], { env }), "usage", 2).message, command.join(" "))
        .toBe("--timeout takes at most 86400 seconds (a day), not 3000000");
    }
    expect(ok(await ghostly(["--home", dir, "daemon", "status", "--timeout", "86400"], { env }))).toMatchObject({ running: true });
  });
});
