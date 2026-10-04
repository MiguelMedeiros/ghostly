import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, localRelay, ok, Running } from "./support/cli";
// covers: groups.protocol.signals, groups.link.join

/**
 * Edge signaling through members (WISP 9xx · Group Mesh § Signaling through members), with real daemons: a member let
 * in through the group's link has an edge with every member within moments of its welcome, however slow the relays
 * are. The entry session carries the edge with the admin, and the admin carries the one with the other member. Over
 * the relays alone, each edge is a presence, an offer and an answer, each a request out and a read at the other end:
 * with relays that take 2.5 s a request, 15 s or more.
 */
const RELAY_MS = 2_500;
let relays: { url: string; server: Server }[] = [];
const running: Running[] = [];
const [admin, member, joiner] = [home("admin"), home("member"), home("joiner")];
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env: {} });

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, ms = 180_000, every = 250): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > end) throw new Error(`${what}: not done in ${ms / 1000} s; last ${JSON.stringify(value).slice(0, 800)}`);
    await new Promise((r) => setTimeout(r, every));
    value = await read();
  }
  return value;
}
const show = async (dir: string, group: string) => {
  const { status, members } = ok(await as(dir, "group", "show", group)) as { status: string | null; members: { online: boolean }[] };
  return { status, members };
};
const everyPair = async (dirs: string[], group: string) => (await Promise.all(dirs.map((dir) => show(dir, group)))).every((g) => g.status === "active" && g.members.length === dirs.length && g.members.every((m) => m.online));

beforeAll(async () => { relays = [await localRelay(RELAY_MS), await localRelay(RELAY_MS)]; }, 30_000);
afterAll(async () => {
  await Promise.all(running.map((daemon) => daemon.stop()));
  for (const relay of relays) relay.server.close();
}, 60_000);

describe("a private group's edges signal through members", { timeout: 300_000 }, () => {
  it("a member let in over slow relays reaches everyone within moments of its welcome", async () => {
    for (const [dir, name] of [[admin, "Admin"], [member, "Member"], [joiner, "Joiner"]]) {
      ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((relay) => relay.url))));
      ok(await as(dir, "profile", "set", "--name", name));
      const daemon = new Running(["--home", dir, "daemon"]);
      running.push(daemon);
      await daemon.waitFor((l) => l.daemon === "ready");
    }
    const group = ok(await as(admin, "group", "create", "Slow relays", "--mesh")).group as string;
    const link = ok(await as(admin, "group", "link", group)).link as string;
    ok(await as(member, "group", "join", link));
    await until("the first member reaches the admin", () => everyPair([admin, member], group), Boolean);

    ok(await as(joiner, "group", "join", link));
    await until("the joiner is let in", () => show(joiner, group), (g) => g.status === "active");
    const welcomed = Date.now();
    await until("every pair is up", () => everyPair([admin, member, joiner], group), Boolean, 120_000);
    const took = Date.now() - welcomed;
    console.log(`MESH_SIGNALS every pair up ${(took / 1000).toFixed(1)} s after the welcome, relays at ${RELAY_MS} ms a request`);
    // Over the relays alone: three packets and three reads an edge, 15 s and more. Through members: none of them waits.
    expect(took).toBeLessThan(7_000);
  });
});
