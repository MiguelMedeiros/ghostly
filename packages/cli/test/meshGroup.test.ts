import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, localRelay, ok, Running } from "./support/cli";
// covers: headless.groups, groups.catch-up, groups.link.join, groups.rename

/**
 * A private (mesh) group of headless bots, as the "Ghostly dev" group runs them: a coordinator that stays up, bots that
 * post a status and stop, and a person whose app is closed meanwhile. The person, back, gets the status from the
 * coordinator though its author's daemon is gone (WISP 902 group mesh § Catch-up), and the name the coordinator gave the
 * group meanwhile (§ Metadata). `MESH_CLI_N` members (3 by default:
 * the coordinator, one bot, the person; more bots with a larger N), everything on loopback.
 */
const N = Math.max(3, Number(process.env.MESH_CLI_N ?? 3));
let relays: { url: string; server: Server }[] = [];
const running = new Map<string, Running>();
const homes = Array.from({ length: N }, (_, i) => home(i === 0 ? "coordinator" : i === N - 1 ? "person" : `bot${i}`));
const [coordinator, author] = homes, person = homes[N - 1];
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env: {} });

async function up(dir: string): Promise<void> {
  const daemon = new Running(["--home", dir, "daemon"]);
  running.set(dir, daemon);
  await daemon.waitFor((l) => l.daemon === "ready");
}
async function down(dir: string): Promise<void> { await running.get(dir)?.stop(); running.delete(dir); }

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, ms = 180_000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > end) throw new Error(`${what}: not done in ${ms / 1000} s; last ${JSON.stringify(value).slice(0, 1500)}`);
    await new Promise((r) => setTimeout(r, 1000));
    value = await read();
  }
  return value;
}
const texts = async (dir: string, group: string) => (ok(await as(dir, "group", "history", group, "--limit", "200")).messages as { text: string; event?: string }[]).filter((m) => !m.event).map((m) => m.text);
const members = async (dir: string, group: string) => ok(await as(dir, "group", "show", group)).members as { online: boolean; me: boolean }[];

// Two relays, as the defaults are: each allows a daemon 30 requests a minute, and on one alone the edges' offers and
// answers waited out the minute behind their polls, for minutes when a member came back.
beforeAll(async () => { relays = [await localRelay(), await localRelay()]; }, 30_000);
afterAll(async () => {
  await Promise.all([...running.keys()].map(down));
  for (const relay of relays) relay.server.close();
}, 60_000);

describe(`a private group of ${N} headless members`, { timeout: 480_000 }, () => {
  let group = "";

  it("joins everyone through the coordinator's link and connects every pair", async () => {
    for (const [i, dir] of homes.entries()) {
      ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((relay) => relay.url))));
      ok(await as(dir, "profile", "set", "--name", i === 0 ? "Coordinator" : dir === person ? "Person" : `Bot ${i}`));
    }
    await Promise.all(homes.map(up));
    group = ok(await as(coordinator, "group", "create", "Dev", "--mesh")).group as string;
    const link = ok(await as(coordinator, "group", "link", group)).link as string;
    expect(link).toMatch(/^group1\//);
    for (const dir of homes.slice(1)) {
      expect(ok(await as(dir, "group", "join", link)).group).toBe(group);
      await until("admitted", async () => ok(await as(dir, "group", "show", group)).status, (s) => s === "active");
    }
    const started = Date.now();
    for (const dir of homes) await until(`${dir} reaches everyone`, () => members(dir, group), (m) => m.length === N && m.every((x) => x.online));
    // What a member costs here: each daemon's resident memory with N - 1 edges up (WebRTC through libdatachannel).
    const rss = [...running.values()].map((daemon) => Number(execFileSync("ps", ["-o", "rss=", "-p", String(daemon.child.pid)]).toString().trim()) / 1024);
    console.log(`MESH_CLI ${N} members: every pair up ${Math.round((Date.now() - started) / 1000)} s after the last join; daemon RSS ${rss.map((r) => r.toFixed(0)).join(", ")} MiB`);
  });

  it("a status posted while the person's daemon is down, whose author then stops, still reaches the person", async () => {
    await down(person);
    await until("the person is away", () => members(coordinator, group), (m) => m.filter((x) => x.online).length === N - 1);
    ok(await as(author, "group", "send", group, "--", "status: all green"));
    // The coordinator renames the group meanwhile: the person gets the name from the statement, not from the rename's frame.
    expect(ok(await as(coordinator, "group", "rename", group, "Engine", "room")).name).toBe("Engine room");
    await until("the coordinator has it", () => texts(coordinator, group), (t) => t.includes("status: all green"));
    // The author's daemon stops right after posting, as `devbot stop` does.
    await down(author);
    await up(person);
    const started = Date.now();
    const seen = await until("the person has it", async () => ({ texts: await texts(person, group), person: await members(person, group), coordinator: await members(coordinator, group) }),
      (v) => v.texts.includes("status: all green"), 300_000).then((v) => v.texts);
    console.log(`MESH_CLI caught up ${Math.round((Date.now() - started) / 1000)} s after the person's daemon was up again`);
    expect(seen.filter((t) => t === "status: all green")).toHaveLength(1);
    await until("the person has the new name", async () => ok(await as(person, "group", "show", group)).name, (name) => name === "Engine room", 120_000);
    // Named as the author's, from the roster: it came signed by the author.
    const history = ok(await as(person, "group", "history", group)).messages as { text: string; member?: string }[];
    const authorKey = ok(await as(coordinator, "group", "show", group)).members as { key: string; name: string | null }[];
    const status = history.find((m) => m.text === "status: all green")!;
    expect(authorKey.find((m) => m.key === status.member)?.name).toBe("Bot 1");
  });
});
