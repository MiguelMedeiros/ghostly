import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/**
 * On a chat whose invite nobody took yet, `chat connect` is refused at once. `chat disconnect` answered done, with a
 * chat at `connecting`; with `--hold` it put the waiting invite on DHT only, wrote the hold, and a one-shot answered
 * `pairing: error`, `stage: failed`, which reads as a broken invite. Refused the way `chat connect` is, before anything
 * changes.
 */
describe("chat disconnect on a chat nobody joined yet", () => {
  it("is refused as chat connect is, with or without --hold, and leaves the invite as it was", { timeout: 60_000 }, async () => {
    const dir = home("disconnect-untaken");
    const { chat } = ok(await ghostly(["--home", dir, "invite", "create", "--label", "bob"])) as { chat: string };
    const connect = error(await ghostly(["--home", dir, "chat", "connect", chat]), "unavailable", 1);
    for (const args of [[], ["--hold", "5"]]) {
      const refused = error(await ghostly(["--home", dir, "chat", "disconnect", chat, ...args]), "unavailable", 1);
      expect(refused.message).toBe(connect.message);
    }
    const shown = ok(await ghostly(["--home", dir, "chat", "show", chat]));
    expect(shown).toMatchObject({ heldUntil: null, pairing: null });
    expect(shown.deliveryMode).not.toBe("dht");
    // `--hold 0` still ends a hold, so one an older version put on a waiting invite can be lifted.
    expect(ok(await ghostly(["--home", dir, "chat", "disconnect", chat, "--hold", "0"]))).toMatchObject({ heldUntil: null });
  });
});
