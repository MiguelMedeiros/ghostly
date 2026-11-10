import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: headless.cli, headless.chat

/**
 * A chat's id names that chat only. Its contact (and whoever saw its invite) can work it out, so another contact can
 * call itself that id. Before, once the chat was removed, its id fell through to that name: `send`, `file send` and a
 * second `chat remove` with the id a bot kept acted on the other contact's chat.
 */
describe("a removed chat's id", { timeout: 240_000 }, () => {
  const alice = home("removed-id-alice"), carol = home("removed-id-carol");
  const running: Running[] = [];
  let relays: Awaited<ReturnType<typeof localRelay>>[] = [];
  let dht: Awaited<ReturnType<typeof hyperdhtTestnet>>;
  let env: NodeJS.ProcessEnv;
  let removed = "", chatC = "";
  const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });

  beforeAll(async () => {
    relays = await Promise.all([localRelay(), localRelay()]);
    dht = await hyperdhtTestnet();
    env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(",") };
    for (const dir of [alice, carol]) {
      ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
      const daemon = new Running(["--home", dir, "daemon"], env);
      running.push(daemon);
      await daemon.waitFor((line) => line.daemon === "ready");
    }
  }, 60_000);
  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    for (const relay of relays) relay.server.close();
  }, 30_000);

  it("is no chat once removed, not the contact who calls itself that", async () => {
    removed = ok(await as(alice, "invite", "create", "--label", "bob")).chat as string;
    expect(removed).toMatch(/^[ybndrfg8ejkmcpqxot1uwisza345h769]{16}$/);
    ok(await as(carol, "profile", "set", "--name", removed));
    const invite = ok(await as(alice, "invite", "create", "--label", "carol"));
    chatC = invite.chat as string;
    ok(await as(carol, "invite", "join", invite.link as string, "--label", "alice"));
    ok(await as(alice, "chat", "wait", chatC, "--until", "live", "--timeout", "90"));
    await expect.poll(async () => ok(await as(alice, "chat", "show", "carol")).peerName, { timeout: 30_000 }).toBe(removed);
    // While the chat is there, its id is that chat.
    expect(ok(await as(alice, "chat", "show", removed))).toMatchObject({ id: removed });
    expect(ok(await as(alice, "chat", "remove", removed, "--yes"))).toEqual({ removed });

    const file = join(home("removed-id-file"), "note.txt");
    writeFileSync(file, "for bob");
    for (const args of [["chat", "show", removed], ["send", removed, "for bob"], ["send", ` ${removed.toUpperCase()}`, "for bob"], ["file", "send", removed, file], ["chat", "remove", removed, "--yes"]]) {
      expect(error(await as(alice, ...args), "not_found", 3).message, args.join(" ")).toContain(`No chat "`);
    }
    // Carol's chat is whole, and none of it reached her.
    expect(ok(await as(alice, "chat", "show", chatC))).toMatchObject({ id: chatC, peerName: removed });
    const texts = (ok(await as(alice, "chat", "history", chatC)).messages as { text?: string }[]).map((m) => m.text);
    expect(texts).not.toContain("for bob");
    // Her name still finds her where it is no chat's id: a label given here.
    ok(await as(alice, "chat", "rename", chatC, removed));
    expect(ok(await as(alice, "chat", "show", removed))).toMatchObject({ id: chatC });
  });
});
