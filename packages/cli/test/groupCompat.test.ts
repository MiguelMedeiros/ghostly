import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: headless.groups, groups.community.join, groups.community.send

/**
 * A community made by this CLI, joined by an older one, and the other way round: both keep the wire of before group
 * links could go native (WISP 9xx § Transports). Two apps that have WebRTC (the CLI has it, through libdatachannel)
 * never publish `_tr`, so an app from before that knows nothing of it reaches this one over WebRTC as it always did.
 *
 * `GHOSTLY_OLD_CLI=<path to ghostly.mjs>` runs the older side as that build (the 1.0.0 package); without it, the older
 * side is this build told to act as one from before native group links (`GHOSTLY_TEST_WEBRTC_GROUP_LINKS=1`: no
 * `_tr`, no native endpoint on a group link).
 */
const OLD_BIN = process.env.GHOSTLY_OLD_CLI;
let relays: { url: string; server: Server; largest: Map<string, number> }[] = [];
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
let env: NodeJS.ProcessEnv, oldEnv: NodeJS.ProcessEnv;
const now = home("now"), old = home("old");
const bin = (dir: string) => (dir === old ? OLD_BIN : process.env.GHOSTLY_NEW_CLI);
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env: dir === old ? oldEnv : env, bin: bin(dir) });

async function member(dir: string, group: string, name: string): Promise<void> {
  const until = Date.now() + 150_000;
  let shown: Record<string, unknown> = {};
  while (Date.now() < until) {
    shown = ok(await as(dir, "group", "show", group));
    if ((shown.members as { name: string | null; me: boolean }[]).some((m) => !m.me && m.name === name)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect.fail(`${group} on ${dir} never named ${name}: ${JSON.stringify(shown)}`);
}

async function hears(dir: string, from: string, group: string, text: string): Promise<void> {
  const since = (ok(await as(dir, "status")).events as { lastSeq: number }).lastSeq;
  const listen = new Running(["--home", dir, "listen", "--since", String(since), "--type", "group."], dir === old ? oldEnv : env, bin(dir));
  running.push(listen);
  const sent = ok(await as(from, "group", "send", group, text));
  const event = await listen.waitFor((l) => l.type === "group.message" && (l.message as { text?: string })?.text === text, 150_000);
  expect(event).toMatchObject({ message: { id: sent.messageId, text } });
  await listen.stop();
}

beforeAll(async () => {
  relays = await Promise.all([localRelay(), localRelay()]);
  dht = await hyperdhtTestnet();
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, ...(process.env.GHOSTLY_LINK_TRACE ? {} : { GHOSTLY_LINK_TRACE: join(home("trace"), "link.jsonl") }) };
  oldEnv = { ...env, ...(OLD_BIN ? {} : { GHOSTLY_TEST_WEBRTC_GROUP_LINKS: "1" }) };
  for (const [dir, name] of [[now, "Now"], [old, "Old"]] as const) {
    ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    ok(await as(dir, "profile", "set", "--name", name));
    const daemon = new Running(["--home", dir, "daemon"], dir === old ? oldEnv : env, bin(dir));
    running.push(daemon);
    await daemon.waitFor((l) => l.daemon === "ready");
  }
}, 60_000);

afterAll(async () => {
  await Promise.all(running.map((r) => r.stop()));
  await dht?.destroy();
  for (const relay of relays) relay.server.close();
}, 30_000);

describe(`a community between this CLI and ${OLD_BIN ? "an older release" : "one from before native group links"}`, { timeout: 480_000 }, () => {
  it("this CLI has WebRTC (libdatachannel): its group links stay on it with an app that has it too", async () => {
    expect(ok(await as(now, "status"))).toMatchObject({ webrtc: true });
  });

  it("this CLI makes it, the older one joins by its link, and each reads the other", async () => {
    const created = ok(await as(now, "group", "create", "Mixed", "crew"));
    const joined = ok(await as(old, "group", "join", created.link as string));
    await member(now, created.group as string, "Old");
    await member(old, joined.group as string, "Now");
    // Every packet either side published fits what the public relays take: 1,000 bytes of DNS packet, behind a
    // 64-byte signature and an 8-byte time. (A relay answers one past it with an error, and an answer that never
    // goes out is an entry session that never opens.)
    const largest = Math.max(...relays.flatMap((r) => [...r.largest.values()]));
    console.log(`GROUP_COMPAT largest packet: ${largest} bytes`);
    expect(largest).toBeLessThanOrEqual(1_072);
    await hears(old, now, created.group as string, "from the new one");
    await hears(now, old, joined.group as string, "from the old one");
  });

  it("the older one makes it, this CLI joins, and each reads the other", async () => {
    const created = ok(await as(old, "group", "create", "Other", "crew"));
    const joined = ok(await as(now, "group", "join", created.link as string));
    await member(old, created.group as string, "Now");
    await member(now, joined.group as string, "Old");
    await hears(now, old, created.group as string, "made by the old one");
    await hears(old, now, joined.group as string, "joined by the new one");
  });
});
