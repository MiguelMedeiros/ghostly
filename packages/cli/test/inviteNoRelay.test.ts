import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { ghostly, home, localRelay, ok, Running } from "./support/cli";
// covers: headless.cli

/** `published:false` alone left a bot asking whether the invite was any good, and whether to make another. */
describe("invite create with no relay reachable", { timeout: 180_000 }, () => {
  let daemon: Running | undefined;
  let relay: Awaited<ReturnType<typeof localRelay>> | undefined;
  afterAll(async () => { await daemon?.stop(); relay?.server.closeAllConnections(); relay?.server.close(); });

  it("says why, names the relay that did not answer, and the invite goes out once the relay is back", async () => {
    const dir = home("invite-no-relay");
    relay = await localRelay();
    const { port } = relay.server.address() as AddressInfo;
    await new Promise((r) => relay!.server.close(r));
    const env = { GHOSTLY_PKARR_RELAYS: relay.url };
    daemon = new Running(["--home", dir, "daemon"], env);
    await daemon.waitFor((line) => line.daemon === "ready");

    const first = ok(await ghostly(["--home", dir, "invite", "create", "--label", "first"], { env }));
    expect(first).toMatchObject({ published: false, note: expect.stringContaining("once a relay answers") });
    expect(first.reason).toEqual(expect.stringContaining("Publish failed on every relay"));

    // The relay refused already: the next answer is the one that said it was cooling down.
    const second = ok(await ghostly(["--home", dir, "invite", "create", "--label", "second"], { env }));
    expect(second).toMatchObject({ published: false, note: expect.stringContaining("once a relay answers") });
    expect(second.reason).toContain(`${relay.url} did not answer a moment ago`);
    expect(second.reason).not.toContain("cooling down");

    // What the note says: the same invite, nothing made again.
    await new Promise<void>((r) => relay!.server.listen(port, "127.0.0.1", r));
    await expect.poll(async () => {
      const progress = ok(await ghostly(["--home", dir, "chat", "show", "first"], { env })).progress as { stage: string };
      return progress.stage;
    }, { timeout: 120_000, interval: 2_000 }).not.toBe("failed");
    expect(relay.largest.size).toBeGreaterThan(0);
  });
});
