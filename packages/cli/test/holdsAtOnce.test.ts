import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { profilePaths } from "../src/profiles";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: headless.chat, headless.daemon

/**
 * Several `chat disconnect --hold` at once through one daemon, as a script's `&` or a bot's calls on the socket send
 * them. Each hold read the profile's holds.json before its switch to DHT only and wrote that copy back after it: every
 * call answered its `heldUntil`, but the file kept one hold, and the other chats stayed on DHT only for good (nothing
 * took them back when their time was up, nor at the next start).
 */
let relays: { url: string; server: Server }[] = [];
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
const alice = home("alice"), bob = home("bob");
let env: NodeJS.ProcessEnv;
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });
const CHATS = ["bob1", "bob2", "bob3"];
/** Alice's holds, as her profile folder keeps them. */
const holdsOf = () => JSON.parse(readFileSync(join(profilePaths(alice, "default").dir, "holds.json"), "utf8")) as Record<string, { until: number }>;

beforeAll(async () => {
  relays = await Promise.all([localRelay(), localRelay()]);
  dht = await hyperdhtTestnet();
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(",") };
}, 30_000);

afterAll(async () => {
  await Promise.all(running.map((r) => r.stop()));
  await dht?.destroy();
  for (const relay of relays) relay.server.close();
}, 30_000);

it("three chats held at once by three one-shots keep their three holds, and each comes back to its live link on time", { timeout: 300_000 }, async () => {
  for (const dir of [alice, bob]) {
    ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    const daemon = new Running(["--home", dir, "daemon"], env);
    running.push(daemon);
    await daemon.waitFor((l) => l.daemon === "ready");
  }
  for (const [i, chat] of CHATS.entries()) {
    const invite = ok(await as(alice, "invite", "create", "--label", chat));
    ok(await as(bob, "invite", "join", invite.link as string, "--label", `alice${i + 1}`));
  }
  for (const [i, chat] of CHATS.entries()) {
    ok(await as(alice, "chat", "wait", chat, "--until", "live", "--timeout", "90"));
    ok(await as(bob, "chat", "wait", `alice${i + 1}`, "--until", "live", "--timeout", "90"));
  }

  // 0.4 min: 24 s off the live link.
  const held = (await Promise.all(CHATS.map((chat) => as(alice, "chat", "disconnect", chat, "--hold", "0.4")))).map((r) => ok(r).heldUntil as number);
  expect(Object.values(holdsOf()).map((h) => h.until).sort((a, b) => a - b)).toEqual([...held].sort((a, b) => a - b));
  const shown = await Promise.all(CHATS.map(async (chat) => ok(await as(alice, "chat", "show", chat))));
  expect(shown.map((c) => [c.deliveryMode, c.heldUntil])).toEqual(held.map((until) => ["dht", until]));

  // Each comes back by itself when its time is up, a few seconds at most after it.
  const last = Math.max(...held);
  await new Promise((r) => setTimeout(r, Math.max(0, last - Date.now())));
  for (const chat of CHATS) {
    await expect.poll(async () => {
      const { deliveryMode, heldUntil } = ok(await as(alice, "chat", "show", chat));
      return { deliveryMode, heldUntil };
    }, { timeout: 10_000, interval: 500 }).toEqual({ deliveryMode: "stream", heldUntil: null });
  }
  expect(holdsOf()).toEqual({});
});
