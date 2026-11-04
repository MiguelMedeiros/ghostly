import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running, type Result } from "./support/cli";
// covers: headless.one-shot

/**
 * A one-shot `message delete --everyone` leaves when its command is done, and a removal nobody has heard of leaves with
 * it. It answered done in 0.7 s and the contact kept the message until a later command of this profile went live, or
 * for good if none came. As `edit`, it now stays until the contact confirmed.
 */
describe("a one-shot message delete --everyone", { timeout: 180_000 }, () => {
  let relays: { url: string; server: Server }[] = [];
  let dht: { bootstrap: string; destroy(): Promise<void> };
  let env: NodeJS.ProcessEnv;
  const running: Running[] = [];
  const alice = home("delete-alice"), bob = home("delete-bob");
  const as = (dir: string, ...args: string[]): Promise<Result> => ghostly(["--home", dir, ...args], { env });
  const daemon = async (dir: string): Promise<Running> => {
    const started = new Running(["--home", dir, "daemon"], env);
    running.push(started);
    await started.waitFor((line) => line.daemon === "ready");
    return started;
  };
  const textsBobHas = async () => (ok(await as(bob, "chat", "history", "alice")).messages as { text: string }[]).map((m) => m.text);
  let aliceDaemon: Running, bobDaemon: Running;
  const sent: string[] = [];

  beforeAll(async () => {
    relays = await Promise.all([localRelay(), localRelay()]);
    dht = await hyperdhtTestnet();
    env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(",") };
    for (const dir of [alice, bob]) ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    aliceDaemon = await daemon(alice);
    bobDaemon = await daemon(bob);
    const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
    ok(await as(bob, "invite", "join", invite.invite as string, "--label", "alice"));
    ok(await as(alice, "chat", "wait", "bob", "--until", "live", "--timeout", "90"));
    for (const text of ["one", "two", "three"]) sent.push(ok(await as(alice, "send", "bob", text, "--wait", "delivered")).messageId as string);
    await aliceDaemon.stop();
  }, 150_000);

  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    for (const relay of relays) relay.server.close();
  }, 30_000);

  it("stays until the contact confirmed, so the message is gone there with nothing more run", async () => {
    const answer = ok(await as(alice, "message", "delete", "bob", sent[0]!, "--everyone"));
    expect(await textsBobHas()).not.toContain("one");
    expect(answer).toMatchObject({ messageId: sent[0], everyone: true, confirmed: true });
  });

  it("--wait none leaves at once and says it is not confirmed", async () => {
    expect(ok(await as(alice, "message", "delete", "bob", sent[1]!, "--everyone", "--wait", "none"))).toMatchObject({ messageId: sent[1], everyone: true, confirmed: false });
  });

  it("a contact who is away is a timeout that says the message is gone here and what carries the removal", async () => {
    await bobDaemon.stop();
    const failure = error(await as(alice, "message", "delete", "bob", sent[2]!, "--everyone", "--timeout", "2"), "timeout", 4);
    expect(failure.message).toContain("gone here");
    expect(failure.message).toContain("ghostly daemon --detach");
    error(await as(alice, "message", "details", "bob", sent[2]!), "not_found", 3);
  });

  it("--wait and --timeout go with --everyone", async () => {
    error(await as(alice, "message", "delete", "bob", sent[2]!, "--wait", "confirmed"), "usage", 2);
    error(await as(alice, "message", "delete", "bob", sent[2]!, "--timeout", "2"), "usage", 2);
  });
});
