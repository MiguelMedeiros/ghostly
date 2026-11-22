import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running, type Result } from "./support/cli";
// covers: chat.dht.delivery, chat.edit.wire, headless.chat

/**
 * A text past the 256 bytes the DHT carries, in a chat both sides keep on the DHT only: it waits for a live session,
 * which comes only once the chat leaves DHT only. `send` said nothing of it, and a one-shot sat 30 s, then answered
 * `timeout` (exit 4) saying it goes with the profile's next command. It answers at once, saying what ends the wait.
 */
let relays: { url: string; server: Server }[] = [];
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
const alice = home("alice"), bob = home("bob"), carol = home("carol"), dave = home("dave");
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

/**
 * The same wait on a terminal, ended with Ctrl-C: its notice said "it still goes" and Ctrl-C that it is kept and "still
 * goes by itself" (or with the next command), neither true while the chat stays on the DHT only. Both say the note.
 */
async function interruptedSaysWhy(dir: string) {
  const tty = join(dir, "tty-stderr.cjs");
  writeFileSync(tty, "Object.defineProperty(process.stderr, \"isTTY\", { value: true });\n");
  const send = new Running(["--home", dir, "send", "bob", waited, "--wait", "sent", "--timeout", "60"], { ...env, NODE_OPTIONS: `--require "${tty}"` });
  running.push(send);
  const note = "Longer than the 256 bytes the DHT carries, and you and the contact keep this chat on the DHT only: it goes once both choose a live transport (ghostly chat transport bob auto), or shorten it";
  await expect.poll(() => send.stderr, { timeout: 30_000, interval: 100 }).toContain("ghostly: waiting for it to go out to bob (up to 60 s; Ctrl-C stops waiting). " + note + "\n");
  send.child.kill("SIGINT");
  expect(await send.exited(15_000)).toBe(130);
  expect(send.stderr).toContain("ghostly: stopped waiting (Ctrl-C): it is kept here. " + note + "\n");
  expect(send.stderr).not.toMatch(/still goes|next command|daemon --detach/);
  expect(send.lines).toEqual([{ error: { code: "interrupted", message: "Stopped waiting (Ctrl-C): it is kept here. " + note, details: { method: "chat.send" } } }]);
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
  await interruptedSaysWhy(alice);

  // A one-shot: no 30 s wait for a send that cannot come, no timeout.
  await daemons.get(alice)!.stop();
  const started = Date.now();
  const oneShot = ok(await as(alice, "send", "bob", long));
  expect(Date.now() - started).toBeLessThan(20_000);
  expect(oneShot.delivery).toBe("waiting");
  expect(oneShot.note).toContain("you and the contact keep this chat on the DHT only");
  for (const wait of ["sent", "delivered"]) saysWhy(await as(alice, "send", "bob", waited, "--wait", wait, "--timeout", "2"));
  await interruptedSaysWhy(alice);

  // What the note says ends the wait does: both choose a live transport, and every text, the forwarded ones too, reaches the contact.
  const back = new Running(["--home", alice, "daemon"], env);
  running.push(back);
  await back.waitFor((l) => l.daemon === "ready");
  ok(await as(alice, "chat", "transport", "bob", "auto"));
  ok(await as(bob, "chat", "transport", "alice", "auto"));
  ok(await as(alice, "chat", "wait", "bob", "--until", "live", "--timeout", "90"));
  await expect.poll(async () => (ok(await as(bob, "chat", "history", "alice", "--limit", "10")).messages as { text: string; from: string }[])
    .filter((m) => m.from === "peer" && (m.text === long || m.text === waited)).length, { timeout: 60_000, interval: 1_000 }).toBe(10);
});

/** When a hold ends, as the CLI says it: this machine's hour and minute, with the day when it is not today. */
function clock(until: number): string {
  const at = new Date(until), two = (n: number) => String(n).padStart(2, "0");
  const day = at.toDateString() === new Date().toDateString() ? "" : `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} `;
  return `${day}${two(at.getHours())}:${two(at.getMinutes())}`;
}

/**
 * A hold (`chat disconnect --hold`) is this side's DHT only for a while, which ends by itself. A text past 256 bytes
 * waits through it and goes when it ends; a text or an edit the DHT packet cannot carry (about 249-256 bytes, an edit
 * about 215 and up) is refused there. The note, an explicit `--wait`'s timeout and the refusals said to choose a live
 * transport (`chat transport <chat> auto`, which ends the hold the person asked for). They say when the hold ends, and
 * the command that ends it now; once it ended, both texts reach the contact, and the same edit is taken and reaches
 * them too. One hold for all of it: each is a real 30 s.
 */
it("under a hold, a text past 256 bytes and a text or an edit too long for the DHT packet say when the hold ends, and go then with nothing chosen", { timeout: 300_000 }, async () => {
  for (const dir of [carol, dave]) {
    ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    const daemon = new Running(["--home", dir, "daemon"], env);
    running.push(daemon);
    await daemon.waitFor((l) => l.daemon === "ready");
  }
  const invite = ok(await as(carol, "invite", "create", "--label", "dave"));
  ok(await as(dave, "invite", "join", invite.link as string, "--label", "carol"));
  for (const [dir, chat] of [[carol, "dave"], [dave, "carol"]]) ok(await as(dir, "chat", "wait", chat, "--until", "live", "--timeout", "90"));
  const id = ok(await as(carol, "send", "dave", "first, live", "--wait", "delivered", "--timeout", "90")).messageId as string;
  const until = ok(await as(carol, "chat", "disconnect", "dave", "--hold", "0.5")).heldUntil as number;
  await expect.poll(async () => ok(await as(carol, "chat", "show", "dave")).live, { timeout: 30_000 }).toBe(false);
  const held = `this chat is held on the DHT only until ${clock(until)}: it goes then, or now with ghostly chat connect dave`;

  const kept = ok(await as(carol, "send", "dave", long));
  expect(kept.delivery).toBe("waiting");
  expect(kept.note).toBe(`Longer than the 256 bytes the DHT carries, and ${held}`);
  const timedOut = await as(carol, "send", "dave", waited, "--wait", "delivered", "--timeout", "2");
  const failure = error(timedOut, "timeout", 4);
  expect(failure.message).not.toContain("choose a live transport");
  expect(failure.message).toContain(`the message is waiting. Longer than the 256 bytes the DHT carries, and ${held}`);
  expect((timedOut.json.error as { details?: Record<string, unknown> }).details).toMatchObject({ delivery: "waiting", note: expect.stringContaining(held) });

  const refusedHeld = (act: string) => `this chat is held on the DHT only until ${clock(until)}: ${act} then, or now with ghostly chat connect dave, or shorten it`;
  const longEdit = "e".repeat(223);
  const edit = error(await as(carol, "edit", "dave", id, longEdit, "--wait", "none"), "refused", 1).message;
  expect(edit).toBe(`Too long for the DHT (an edit fits about 214 bytes there once sealed): ${refusedHeld("make the edit")}`);
  const text = error(await as(carol, "send", "dave", "x".repeat(252), "--wait", "none"), "refused", 1).message;
  expect(text).toBe(`Too long for the DHT (a text fits about 248 bytes there once sealed): ${refusedHeld("send it")}`);

  // What the words say: the hold ends by itself, both texts reach the contact with no transport chosen, and the edit
  // made then reaches them too.
  await expect.poll(async () => (ok(await as(dave, "chat", "history", "carol", "--limit", "10")).messages as { text: string; from: string }[])
    .filter((m) => m.from === "peer" && (m.text === long || m.text === waited)).length, { timeout: 150_000, interval: 2_000 }).toBe(2);
  await expect.poll(async () => ok(await as(carol, "chat", "show", "dave")), { timeout: 60_000, interval: 2_000 }).toMatchObject({ heldUntil: null, deliveryMode: "stream", live: true });
  ok(await as(carol, "edit", "dave", id, longEdit, "--wait", "confirmed", "--timeout", "60"));
  expect((ok(await as(dave, "chat", "history", "carol", "--limit", "10")).messages as { text: string; from: string }[]).some((m) => m.from === "peer" && m.text === longEdit)).toBe(true);
});
