import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running, type Result } from "./support/cli";
// covers: chat.dht.delivery, headless.chat

/**
 * A text past the 256 bytes the DHT carries, in a chat both sides keep on the DHT only: it waits for a live session,
 * which comes only once the chat leaves DHT only. `send` said nothing of it, and a one-shot sat 30 s, then answered
 * `timeout` (exit 4) saying it goes with the profile's next command. It answers at once, saying what ends the wait.
 */
let relays: { url: string; server: Server }[] = [];
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
const alice = home("alice"), bob = home("bob");
let env: NodeJS.ProcessEnv;
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });
const long = "é".repeat(150); // 300 bytes
const waited = "x".repeat(300);

/**
 * `send --wait sent|delivered` of such a text waits as asked, and its timeout (exit 4) says what ends the wait, as the
 * answer without `--wait` does (`details.note` too): it said the text still goes by itself while this profile is
 * online, or with its next command, and neither sends it while the chat stays on the DHT only.
 */
function saysWhy(result: Result) {
  const failure = error(result, "timeout", 4);
  expect(failure.message).not.toMatch(/goes by itself|next command|daemon --detach/);
  expect(failure.message).toContain("the message is waiting. Longer than the 256 bytes the DHT carries, and you and the contact keep this chat on the DHT only");
  expect(failure.message).not.toContain(waited);
  const details = (result.json.error as { details?: Record<string, unknown> }).details;
  expect(details).toMatchObject({ delivery: "waiting", note: expect.stringContaining("(ghostly chat transport bob auto), or shorten it") });
  expect(failure.message).toContain(details!.note as string);
}

/** `forward` of such a text into the chat: its result there has the note `send` answers. */
function forwardSaysWhy(answer: Record<string, unknown>) {
  const [result] = answer.results as Record<string, unknown>[];
  expect(result).toMatchObject({ kind: "chat", error: null, note: expect.stringContaining("you and the contact keep this chat on the DHT only: it goes once both choose a live transport (ghostly chat transport bob auto), or shorten it") });
}

beforeAll(async () => {
  relays = await Promise.all([localRelay(), localRelay()]);
  dht = await hyperdhtTestnet();
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(","), GHOSTLY_TEST_RELAY_REQUESTS_PER_MINUTE: "Infinity" };
}, 30_000);

afterAll(async () => {
  await Promise.all(running.map((r) => r.stop()));
  await dht?.destroy();
  for (const relay of relays) relay.server.close();
}, 30_000);

it("a text past 256 bytes in a DHT-only chat answers at once (or at an explicit --wait's timeout) saying what ends its wait, and goes once the chat is live", { timeout: 300_000 }, async () => {
  const daemons = new Map<string, Running>();
  for (const dir of [alice, bob]) {
    ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    const daemon = new Running(["--home", dir, "daemon"], env);
    running.push(daemon);
    daemons.set(dir, daemon);
    await daemon.waitFor((l) => l.daemon === "ready");
  }
  const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
  ok(await as(bob, "invite", "join", invite.link as string, "--label", "alice"));
  for (const [dir, chat] of [[alice, "bob"], [bob, "alice"]]) ok(await as(dir, "chat", "wait", chat, "--until", "live", "--timeout", "90"));
  ok(await as(alice, "chat", "transport", "bob", "dht"));
  ok(await as(bob, "chat", "transport", "alice", "dht"));
  ok(await as(alice, "send", "bob", "first on the DHT", "--wait", "delivered", "--timeout", "90"));

  // Through the daemon: kept, and the answer says why it waits and what ends it.
  const kept = ok(await as(alice, "send", "bob", long));
  expect(kept.delivery).toBe("waiting");
  expect(kept.note).toContain("256 bytes the DHT carries");
  expect(kept.note).toContain("ghostly chat transport bob auto");
  for (const wait of ["sent", "delivered"]) saysWhy(await as(alice, "send", "bob", waited, "--wait", wait, "--timeout", "2"));
  // Forwarded into the same chat it waits as well: the chat's result says why, and so does a `--wait sent` timeout.
  forwardSaysWhy(ok(await as(alice, "forward", "bob", kept.messageId as string, "--to", "bob")));
  const forwardWait = await as(alice, "forward", "bob", kept.messageId as string, "--to", "bob", "--wait", "sent", "--timeout", "2");
  saysWhy(forwardWait);
  forwardSaysWhy((forwardWait.json.error as { details: Record<string, unknown> }).details);

  // A one-shot: no 30 s wait for a send that cannot come, no timeout.
  await daemons.get(alice)!.stop();
  const started = Date.now();
  const oneShot = ok(await as(alice, "send", "bob", long));
  expect(Date.now() - started).toBeLessThan(20_000);
  expect(oneShot.delivery).toBe("waiting");
  expect(oneShot.note).toContain("you and the contact keep this chat on the DHT only");
  for (const wait of ["sent", "delivered"]) saysWhy(await as(alice, "send", "bob", waited, "--wait", wait, "--timeout", "2"));

  // What the note says ends the wait does: both choose a live transport, and every text, the forwarded ones too, reaches the contact.
  const back = new Running(["--home", alice, "daemon"], env);
  running.push(back);
  await back.waitFor((l) => l.daemon === "ready");
  ok(await as(alice, "chat", "transport", "bob", "auto"));
  ok(await as(bob, "chat", "transport", "alice", "auto"));
  ok(await as(alice, "chat", "wait", "bob", "--until", "live", "--timeout", "90"));
  await expect.poll(async () => (ok(await as(bob, "chat", "history", "alice", "--limit", "10")).messages as { text: string; from: string }[])
    .filter((m) => m.from === "peer" && (m.text === long || m.text === waited)).length, { timeout: 60_000, interval: 1_000 }).toBe(8);
});
