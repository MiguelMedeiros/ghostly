import type { Server } from "node:http";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running, type Result } from "./support/cli";
// covers: headless.files

/**
 * A file of mine sent while the contact was away has its offer said on the DHT floor (its name, size and type). Deleted
 * then, the floor's state dropped it but published nothing: the relays kept the envelope with the offer for its five
 * minutes, and a contact who read the floor meanwhile got the bubble of the deleted file, name and all. In a DHT-only
 * chat no session ever came to tell that bubble it was cancelled.
 */
describe("message delete of a file whose offer waits on the DHT floor", { timeout: 240_000 }, () => {
  let relays: { url: string; server: Server }[] = [];
  let dht: { bootstrap: string; destroy(): Promise<void> };
  let env: NodeJS.ProcessEnv;
  const running: Running[] = [];
  const alice = home("file-floor-alice"), bob = home("file-floor-bob");
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
  const history = async (dir: string, chat: string) => ok(await as(dir, "chat", "history", chat)).messages as { text?: string; file?: { name: string } }[];

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

  it("leaves the floor: the contact back never gets its bubble", async () => {
    const secret = "zqsecretfloorname";
    const path = join(alice, `${secret}.txt`);
    writeFileSync(path, "the bytes never go on the floor");
    ok(await as(alice, "chat", "wait", "bob", "--until", "text", "--timeout", "60"));
    const sent = ok(await as(alice, "file", "send", "bob", path, "--wait", "none"));
    // A text after it: the outbox looks at what waits, and the file's offer goes on the floor first (in a moment).
    const kick = ok(await as(alice, "send", "bob", "kick the outbox", "--wait", "none"));
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    // The text goes too: nothing else takes the floor's slot after the file (a new envelope would hide what is tested).
    ok(await as(alice, "message", "delete", "bob", kick.messageId as string));
    expect(ok(await as(alice, "message", "delete", "bob", sent.messageId as string, "--everyone", "--purge"))).toMatchObject({ purged: true });
    expect(holding(alice, secret)).toEqual([]);

    bobDaemon = await daemon(bob);
    // Bob reads the floor as he starts: the offer, before the fix, was there for its five minutes.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    expect((await history(bob, "alice")).filter((m) => m.file?.name.includes(secret) || m.text?.includes(secret))).toEqual([]);
    // A text sent now reaches bob over the floor: bob has read it since, and the file never came.
    ok(await as(alice, "send", "bob", "after it", "--wait", "sent"));
    for (let tries = 0; !(await history(bob, "alice")).some((m) => m.text === "after it"); tries++) {
      expect(tries, "bob never read the text after the deleted file").toBeLessThan(90);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect((await history(bob, "alice")).filter((m) => m.file?.name.includes(secret) || m.text?.includes(secret))).toEqual([]);
    expect(holding(bob, secret)).toEqual([]);
  });
});
