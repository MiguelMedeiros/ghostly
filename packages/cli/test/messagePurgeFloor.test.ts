import type { Server } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running, type Result } from "./support/cli";
// covers: headless.chat

/**
 * A text of mine sent while the contact was away waits for its receipt on the DHT floor. Deleted then, its row went
 * but the floor kept it: published for its five minutes to a contact whose removal never goes on the floor, and kept
 * in the chat's row, so `message delete --purge` answered `purged: true` with the text still in the profile's folder.
 */
describe("message delete of a text waiting on the DHT floor", { timeout: 240_000 }, () => {
  let relays: { url: string; server: Server }[] = [];
  let dht: { bootstrap: string; destroy(): Promise<void> };
  let env: NodeJS.ProcessEnv;
  const running: Running[] = [];
  const alice = home("purge-floor-alice"), bob = home("purge-floor-bob");
  let bobDaemon: Running;
  const as = (dir: string, ...args: string[]): Promise<Result> => ghostly(["--home", dir, ...args], { env });
  const daemon = async (dir: string): Promise<Running> => {
    const started = new Running(["--home", dir, "daemon"], env);
    running.push(started);
    await started.waitFor((line) => line.daemon === "ready");
    return started;
  };
  /** Every file of the profile's folder that holds `secret`. */
  const holding = (dir: string, secret: string): string[] => {
    const out: string[] = [];
    const walk = (folder: string) => {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name), stat = statSync(path, { throwIfNoEntry: false });
        if (stat?.isDirectory()) walk(path);
        else if (stat?.isFile() && readFileSync(path).includes(secret)) out.push(path.slice(dir.length));
      }
    };
    walk(join(dir, "profiles"));
    return out;
  };
  const texts = async (dir: string, chat: string) => (ok(await as(dir, "chat", "history", chat)).messages as { text?: string }[]).map((m) => m.text ?? "");

  beforeAll(async () => {
    relays = await Promise.all([localRelay(), localRelay()]);
    dht = await hyperdhtTestnet();
    env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(",") };
    for (const dir of [alice, bob]) ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    await daemon(alice);
    bobDaemon = await daemon(bob);
    const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
    ok(await as(bob, "invite", "join", invite.invite as string, "--label", "alice"));
    ok(await as(alice, "chat", "wait", "bob", "--until", "live", "--timeout", "90"));
    ok(await as(alice, "send", "bob", "hello", "--wait", "delivered"));
    // The DHT only on both sides: the chat is never live again, so what the floor says is all the contact gets.
    ok(await as(alice, "chat", "transport", "bob", "dht"));
    ok(await as(bob, "chat", "transport", "alice", "dht"));
    await bobDaemon.stop();
  }, 150_000);

  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    for (const relay of relays) relay.server.close();
  }, 30_000);

  it("leaves the floor: --purge finds nothing left, and the contact back never gets it", async () => {
    const secret = "sk-floor-0123456789abcdef";
    ok(await as(alice, "chat", "wait", "bob", "--until", "text", "--timeout", "60"));
    const sent = ok(await as(alice, "send", "bob", `the token: ${secret}`, "--wait", "sent"));
    expect(sent).toMatchObject({ delivery: "sent" });
    expect(ok(await as(alice, "message", "delete", "bob", sent.messageId as string, "--everyone", "--purge"))).toMatchObject({ deleted: sent.messageId, purged: true });
    expect(holding(alice, secret)).toEqual([]);
    // The floor takes the next text: the deleted one no longer waits there for its receipt.
    ok(await as(alice, "send", "bob", "after it", "--wait", "sent"));

    bobDaemon = await daemon(bob);
    // Bob reads the floor: the text that came after, and never the deleted one.
    for (let tries = 0; !(await texts(bob, "alice")).includes("after it"); tries++) {
      expect(tries, "bob never read the text after the deleted one").toBeLessThan(90);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect((await texts(bob, "alice")).filter((text) => text.includes(secret))).toEqual([]);
    expect(holding(bob, secret)).toEqual([]);
  });
});
