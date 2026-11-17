import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: chat.dht.delivery, chat.edit.wire, headless.chat

/**
 * A text (about 249-256 bytes) or an edit (about 215 and up) the DHT packet cannot carry once sealed, in a chat on the
 * DHT only, was refused with the engine's own words ("Text and authentication exceed the DHT packet budget. Shorten
 * the message."): no limit to shorten to, and no way out, while one past 256 bytes says both. It says it as the apps
 * and that note do: too long for the DHT, about how much fits, and what ends it, by whose choice the chat is there.
 * The sizes it names do go.
 */
let relays: { url: string; server: Server }[] = [];
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
const alice = home("alice"), bob = home("bob"), carol = home("carol"), dave = home("dave");
let env: NodeJS.ProcessEnv;
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });

/** When a hold ends, as the CLI says it: this machine's hour and minute, with the day when it is not today. */
function clock(until: number): string {
  const at = new Date(until), two = (n: number) => String(n).padStart(2, "0");
  const day = at.toDateString() === new Date().toDateString() ? "" : `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} `;
  return `${day}${two(at.getHours())}:${two(at.getMinutes())}`;
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

it("a text or an edit too long for the DHT packet says how much fits and what ends it, by whose choice the chat is DHT only", { timeout: 300_000 }, async () => {
  for (const dir of [alice, bob]) {
    ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    const daemon = new Running(["--home", dir, "daemon"], env);
    running.push(daemon);
    await daemon.waitFor((l) => l.daemon === "ready");
  }
  const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
  ok(await as(bob, "invite", "join", invite.link as string, "--label", "alice"));
  for (const [dir, chat] of [[alice, "bob"], [bob, "alice"]]) ok(await as(dir, "chat", "wait", chat, "--until", "live", "--timeout", "90"));

  // This side's choice: the way out is its own command.
  ok(await as(alice, "chat", "transport", "bob", "dht"));
  const id = ok(await as(alice, "send", "bob", "first on the DHT", "--wait", "delivered", "--timeout", "90")).messageId as string;
  const text = error(await as(alice, "send", "bob", "x".repeat(252), "--wait", "none"), "refused", 1).message;
  expect(text).toBe("Too long for the DHT (a text fits about 248 bytes there once sealed): this chat is on the DHT only: send it once you choose a live transport (ghostly chat transport bob auto), or shorten it");
  const edit = error(await as(alice, "edit", "bob", id, "e".repeat(230), "--wait", "none"), "refused", 1).message;
  expect(edit).toBe("Too long for the DHT (an edit fits about 214 bytes there once sealed): this chat is on the DHT only: make the edit once you choose a live transport (ghostly chat transport bob auto), or shorten it");
  // What the words name fits: an edit and a text of those sizes are taken.
  expect(ok(await as(alice, "edit", "bob", id, "e".repeat(214), "--wait", "none"))).toMatchObject({ edits: 1 });
  expect(ok(await as(alice, "send", "bob", "x".repeat(248), "--wait", "none")).messageId).toBeTruthy();

  // The contact's choice: nothing this side runs ends it.
  ok(await as(alice, "chat", "transport", "bob", "auto"));
  ok(await as(bob, "chat", "transport", "alice", "dht"));
  await expect.poll(async () => ok(await as(alice, "chat", "show", "bob")).peerDeliveryMode, { timeout: 120_000, interval: 2_000 }).toBe("dht");
  const theirs = error(await as(alice, "send", "bob", "x".repeat(252), "--wait", "none"), "refused", 1).message;
  expect(theirs).toBe("Too long for the DHT (a text fits about 248 bytes there once sealed): the contact keeps this chat on the DHT only: send it once they choose a live transport, or shorten it");
  const theirEdit = error(await as(alice, "edit", "bob", id, "e".repeat(230), "--wait", "none"), "refused", 1).message;
  expect(theirEdit).toBe("Too long for the DHT (an edit fits about 214 bytes there once sealed): the contact keeps this chat on the DHT only: make the edit once they choose a live transport, or shorten it");
});

/**
 * A hold (`chat disconnect --hold`) is this side's DHT only for a while, which ends by itself. A text or an edit the
 * DHT packet cannot carry (about 249-256 bytes, an edit about 215 and up) is refused there, and the words said to
 * choose a live transport (`chat transport <chat> auto`, which ends the hold the person asked for). They say when the
 * hold ends, and the command that ends it now; once it ended, the same edit is taken and reaches the contact.
 */
it("under a hold, a text or an edit too long for the DHT packet says to make it when the hold ends, which then goes", { timeout: 300_000 }, async () => {
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
  const held = (act: string) => `this chat is held on the DHT only until ${clock(until)}: ${act} then, or now with ghostly chat connect dave, or shorten it`;

  const longEdit = "e".repeat(223);
  const edit = error(await as(carol, "edit", "dave", id, longEdit, "--wait", "none"), "refused", 1).message;
  expect(edit).toBe(`Too long for the DHT (an edit fits about 214 bytes there once sealed): ${held("make the edit")}`);
  const text = error(await as(carol, "send", "dave", "x".repeat(252), "--wait", "none"), "refused", 1).message;
  expect(text).toBe(`Too long for the DHT (a text fits about 248 bytes there once sealed): ${held("send it")}`);

  // What the words say: the hold ends by itself, with no transport chosen, and the edit made then reaches the contact.
  await expect.poll(async () => ok(await as(carol, "chat", "show", "dave")), { timeout: 150_000, interval: 2_000 }).toMatchObject({ heldUntil: null, deliveryMode: "stream", live: true });
  ok(await as(carol, "edit", "dave", id, longEdit, "--wait", "confirmed", "--timeout", "60"));
  expect((ok(await as(dave, "chat", "history", "carol", "--limit", "10")).messages as { text: string; from: string }[]).some((m) => m.from === "peer" && m.text === longEdit)).toBe(true);
});
