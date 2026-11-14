import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: headless.group-auto

/**
 * A bot that joins its owner's groups (`group auto on --from <chat>`), as two daemons on loopback: the owner invites
 * the bot into a private group and the bot is a member without `group accept`, both for an invitation that waited
 * while its daemon was down and for one that comes while it runs. A Pkarr relay in this process and a HyperDHT testnet.
 */
let relays: { url: string; server: Server }[] = [];
let dht: Awaited<ReturnType<typeof hyperdhtTestnet>> | undefined;
const daemons = new Map<string, Running>();
const owner = home("owner"), bot = home("bot");
const env = (): NodeJS.ProcessEnv => ({ GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(","), ...(dht ? { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap } : {}) });
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env: env() });

async function up(dir: string): Promise<Running> {
  const daemon = new Running(["--home", dir, "daemon"], env());
  daemons.set(dir, daemon);
  await daemon.waitFor((l) => l.daemon === "ready");
  return daemon;
}
async function down(dir: string): Promise<void> { await daemons.get(dir)?.stop(); daemons.delete(dir); }

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > end) throw new Error(`${what}: not done in ${ms / 1000} s; last ${JSON.stringify(value).slice(0, 1500)}`);
    await new Promise((r) => setTimeout(r, 1000));
    value = await read();
  }
  return value;
}
const statusOn = async (dir: string, group: string) => (ok(await as(dir, "group", "list")).groups as { id: string; status: string | null }[]).find((g) => g.id === group)?.status ?? null;

beforeAll(async () => { relays = [await localRelay(), await localRelay()]; dht = await hyperdhtTestnet(); }, 30_000);
afterAll(async () => {
  await Promise.all([...daemons.keys()].map(down));
  for (const relay of relays) relay.server.close();
  await dht?.destroy();
}, 60_000);

describe("group auto on --from <chat>", { timeout: 300_000 }, () => {
  let chat = "";

  it("joins the owner's groups without group accept: one that waited while the daemon was down, and one while it runs", async () => {
    for (const [dir, name] of [[owner, "Owner"], [bot, "Bot"]] as const) {
      ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
      ok(await as(dir, "profile", "set", "--name", name));
    }
    await Promise.all([up(owner), up(bot)]);
    const invite = ok(await as(owner, "invite", "create", "--label", "bot"));
    chat = ok(await as(bot, "invite", "join", invite.link as string, "--label", "owner")).chat as string;
    for (const [dir, c] of [[owner, invite.chat as string], [bot, chat]]) ok(await as(dir, "chat", "wait", c, "--until", "live", "--timeout", "90"));

    // Off, as before: the invitation waits for group accept.
    expect(ok(await as(bot, "group", "auto"))).toEqual({ autoJoin: { on: false, from: [] } });
    const first = ok(await as(owner, "group", "create", "First", "--mesh")).group as string;
    ok(await as(owner, "group", "invite", first, "bot"));
    await until("the bot sees the invitation", () => statusOn(bot, first), (s) => s === "invited");
    await new Promise((r) => setTimeout(r, 3000));
    expect(await statusOn(bot, first)).toBe("invited");

    // Turned on while the daemon is down (a one-shot keeps the setting and accepts nothing): its next start accepts.
    await down(bot);
    error(await as(bot, "group", "auto", "on"), "usage", 2);
    expect(ok(await as(bot, "group", "auto", "on", "--from", "owner"))).toEqual({ autoJoin: { on: true, from: [chat] } });
    expect(ok(await as(bot, "group", "list"))).toMatchObject({ autoJoin: { on: true, from: [chat] }, groups: [{ id: first, status: "invited" }] });
    const daemon = await up(bot);
    await until("the bot joins the first group by itself", () => statusOn(bot, first), (s) => s === "active");
    expect(daemon.stderr).toContain(`group auto: accepted the invitation to group ${first} from chat ${chat}`);

    // While it runs: at once.
    const second = ok(await as(owner, "group", "create", "Second", "--mesh")).group as string;
    ok(await as(owner, "group", "invite", second, "bot"));
    await until("the bot joins the second group by itself", () => statusOn(bot, second), (s) => s === "active");
    expect(daemon.stderr).toContain(`group auto: accepted the invitation to group ${second} from chat ${chat}`);
    expect(daemon.stderr).not.toMatch(/group1\//);
  });
});
