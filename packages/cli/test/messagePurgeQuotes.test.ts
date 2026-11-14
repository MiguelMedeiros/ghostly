import type { Server } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running, type Result } from "./support/cli";
// covers: headless.chat

/**
 * `message delete --purge` answered `purged: true` while a reply to the message (mine or the contact's) still held a
 * line of it in rows.db: history showed the quote as deleted, the reply's row kept its snippet. And two deletes for
 * everyone in a chat within 10 s left the second's quotes to a sweep after the answer.
 */
describe("message delete --purge and the replies that quote it", { timeout: 240_000 }, () => {
  let relays: { url: string; server: Server }[] = [];
  let dht: { bootstrap: string; destroy(): Promise<void> };
  let env: NodeJS.ProcessEnv;
  const running: Running[] = [];
  const alice = home("purge-quotes-alice"), bob = home("purge-quotes-bob");
  const as = (dir: string, ...args: string[]): Promise<Result> => ghostly(["--home", dir, ...args], { env });
  const daemon = async (dir: string): Promise<void> => {
    const started = new Running(["--home", dir, "daemon"], env);
    running.push(started);
    await started.waitFor((line) => line.daemon === "ready");
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
  const quotes = async (dir: string, chat: string) => (ok(await as(dir, "chat", "history", chat)).messages as { replyTo?: { snippet: string } }[]).filter((m) => m.replyTo).map((m) => m.replyTo!.snippet);

  beforeAll(async () => {
    relays = await Promise.all([localRelay(), localRelay()]);
    dht = await hyperdhtTestnet();
    env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(",") };
    for (const dir of [alice, bob]) ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    await daemon(alice);
    await daemon(bob);
    const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
    ok(await as(bob, "invite", "join", invite.invite as string, "--label", "alice"));
    ok(await as(alice, "chat", "wait", "bob", "--until", "live", "--timeout", "90"));
  }, 150_000);

  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    for (const relay of relays) relay.server.close();
  }, 30_000);

  it("a contact's message: my reply's and the contact's reply's quotes go with it", async () => {
    const secret = "sk-made-up-quoted-0123456789";
    const sent = ok(await as(alice, "send", "bob", `the token: ${secret}`, "--wait", "delivered")).messageId as string;
    ok(await as(alice, "send", "bob", "use that one", "--reply", sent, "--wait", "delivered"));
    const history = ok(await as(bob, "chat", "history", "alice")).messages as { id: string; text?: string }[];
    const received = history.find((m) => m.text?.includes(secret))!.id;
    ok(await as(bob, "send", "alice", "got it", "--reply", received, "--wait", "delivered"));
    expect(await quotes(bob, "alice")).toEqual([`the token: ${secret}`, `the token: ${secret}`]);

    expect(ok(await as(bob, "message", "delete", "alice", received, "--purge"))).toMatchObject({ deleted: received, purged: true });
    expect(holding(bob, secret)).toEqual([]);
    expect(await quotes(bob, "alice")).toEqual(["", ""]);
  });

  it("two of mine deleted for everyone back to back: neither's line stays in a reply", async () => {
    const secrets = ["sk-made-up-first-0123456789", "sk-made-up-second-0123456789"];
    const ids: string[] = [];
    for (const secret of secrets) {
      const id = ok(await as(alice, "send", "bob", `oops: ${secret}`, "--wait", "delivered")).messageId as string;
      ok(await as(alice, "send", "bob", "ignore that", "--reply", id, "--wait", "delivered"));
      ids.push(id);
    }
    for (const id of ids) expect(ok(await as(alice, "message", "delete", "bob", id, "--everyone", "--wait", "confirmed", "--purge"))).toMatchObject({ deleted: id, purged: true });
    for (const secret of secrets) expect(holding(alice, secret)).toEqual([]);
  });
});
