import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ACTIVE_DHT_POLL_MS } from "@ghostly/core";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: chat.dht.delivery, headless.chat

/**
 * A contact that chose DHT only, as a daemon reads it: the contact reads this side's mailbox every 4 s, and this side
 * read the contact's only at its 30 s background read, so each of its texts took about 30 s to arrive (and a queue
 * drained one per 30 s). A daemon is the chat open: it reads such a contact every `ACTIVE_DHT_POLL_MS`.
 */
let relays: { url: string; server: Server }[] = [];
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
const alice = home("alice"), bob = home("bob");
let env: NodeJS.ProcessEnv;
/** Both daemons' link traces: what a slow run prints (which reads went when, and which the relays' budget held). */
const trace = join(home("trace"), "link.jsonl");
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });

beforeAll(async () => {
  relays = await Promise.all([localRelay(), localRelay()]);
  dht = await hyperdhtTestnet();
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(","), GHOSTLY_LINK_TRACE: trace };
}, 30_000);

afterAll(async () => {
  await Promise.all(running.map((r) => r.stop()));
  await dht?.destroy();
  for (const relay of relays) relay.server.close();
}, 30_000);

it("a daemon takes the texts of a contact that chose DHT only at the open chat's pace, not at the 30 s background read", { timeout: 300_000 }, async ({ onTestFailed }) => {
  const since = Date.now();
  onTestFailed(() => {
    let steps: string[] = [];
    try { steps = readFileSync(trace, "utf8").split("\n").filter((l) => l && (JSON.parse(l) as { t: number }).t >= since); } catch { /* no trace yet */ }
    console.log(`link steps (${steps.length}, the last 300):\n${steps.slice(-300).join("\n")}`);
  });
  for (const dir of [alice, bob]) {
    ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    const daemon = new Running(["--home", dir, "daemon"], env);
    running.push(daemon);
    await daemon.waitFor((l) => l.daemon === "ready");
  }
  const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
  ok(await as(bob, "invite", "join", invite.link as string, "--label", "alice"));
  for (const [dir, chat] of [[alice, "bob"], [bob, "alice"]]) ok(await as(dir, "chat", "wait", chat, "--until", "live", "--timeout", "90"));

  ok(await as(alice, "chat", "transport", "bob", "dht"));
  const chose = Date.now();
  // Bob has seen the choice: from here on, what decides is how often he reads Alice's mailbox.
  while (ok(await as(bob, "chat", "show", "alice")).peerDeliveryMode !== "dht") {
    expect(Date.now(), "Bob never saw Alice choose DHT only").toBeLessThan(chose + 90_000);
    await new Promise((r) => setTimeout(r, 500));
  }
  // The pairing and the switch spent Alice's relays' minute: a text she sends in it can wait ten seconds to go out.
  await new Promise((r) => setTimeout(r, Math.max(0, chose + 65_000 - Date.now())));
  const lastSeq = (ok(await as(bob, "status")).events as { lastSeq: number }).lastSeq;
  const listen = new Running(["--home", bob, "listen", "--since", String(lastSeq), "--type", "message.received"], env);
  running.push(listen);
  const arrived: number[] = [], delivered: number[] = [], sentAt = Date.now();
  for (let i = 0; i < 3; i++) {
    const text = `on the DHT ${i}`, start = Date.now();
    const seen = listen.waitFor((l) => (l.message as { text?: string } | undefined)?.text === text, 90_000).then(() => arrived.push(Date.now() - start));
    ok(await as(alice, "send", "bob", text, "--wait", "delivered", "--timeout", "90"));
    delivered.push(Date.now() - start);
    await seen;
  }
  const said = `arrived in ${arrived.join(", ")} ms, delivered in ${delivered.join(", ")} ms, the first sent at ${sentAt}`;
  // Bob's next read, at most `ACTIVE_DHT_POLL_MS` away, and a one-shot's start. Before: his 30 s background read.
  for (const ms of arrived) expect(ms, said).toBeLessThan(ACTIVE_DHT_POLL_MS + 3_000);
  // Then Alice's own read of the receipt, every 4 s while her text awaits it (her relays' budget can hold one a few seconds).
  for (const ms of delivered) expect(ms, said).toBeLessThan(20_000);
});
