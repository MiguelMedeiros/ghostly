import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running, type Result } from "./support/cli";
// covers: headless.one-shot

/**
 * `chat remove` took a chat whose delete for everyone had not reached the contact yet, and its removal with it: the
 * contact kept the message for good, though `message delete --everyone` had said its removal goes on. It is refused
 * now, naming the messages, until `--force`.
 */
describe("chat remove with a delete for everyone on its way", { timeout: 180_000 }, () => {
  let relays: { url: string; server: Server }[] = [];
  let dht: { bootstrap: string; destroy(): Promise<void> };
  let env: NodeJS.ProcessEnv;
  const running: Running[] = [];
  const alice = home("remove-pending-alice"), bob = home("remove-pending-bob");
  const as = (dir: string, ...args: string[]): Promise<Result> => ghostly(["--home", dir, ...args], { env });
  const daemon = async (dir: string): Promise<Running> => {
    const started = new Running(["--home", dir, "daemon"], env);
    running.push(started);
    await started.waitFor((line) => line.daemon === "ready");
    return started;
  };
  let messageId: string;

  beforeAll(async () => {
    relays = await Promise.all([localRelay(), localRelay()]);
    dht = await hyperdhtTestnet();
    env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(",") };
    for (const dir of [alice, bob]) ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    await daemon(alice);
    const bobDaemon = await daemon(bob);
    const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
    ok(await as(bob, "invite", "join", invite.invite as string, "--label", "alice"));
    ok(await as(alice, "chat", "wait", "bob", "--until", "live", "--timeout", "90"));
    messageId = ok(await as(alice, "send", "bob", "one", "--wait", "delivered")).messageId as string;
    await bobDaemon.stop();
    expect(ok(await as(alice, "message", "delete", "bob", messageId, "--everyone", "--wait", "none"))).toMatchObject({ everyone: true, confirmed: false });
  }, 150_000);

  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    for (const relay of relays) relay.server.close();
  }, 30_000);

  it("is refused, naming the message the contact would keep, and the chat stays", async () => {
    const refused = error(await as(alice, "chat", "remove", "bob", "--yes"), "confirm", 5);
    expect(refused.message).toContain("deleted for everyone");
    expect(refused.message).toContain("--force");
    expect(refused).toMatchObject({ details: { messages: [messageId] } });
    ok(await as(alice, "chat", "show", "bob"));
  });

  it("--force removes it anyway", async () => {
    const chat = ok(await as(alice, "chat", "show", "bob")).id as string;
    expect(ok(await as(alice, "chat", "remove", "bob", "--yes", "--force"))).toEqual({ removed: chat });
    error(await as(alice, "chat", "show", chat), "not_found", 3);
  });
});
