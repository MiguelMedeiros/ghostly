import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: chat.dht.delivery, chat.edit.wire, headless.chat

/**
 * A text within the DHT's 256 bytes that does not fit its packet once sealed (about 249-256 bytes of ASCII in a paired
 * chat), or an edit the packet cannot carry (it goes as a text with its element, the message's id and the edit's
 * number, so its bound is shorter: about 215 bytes and up). One paired chat, alice and bob, for every test here, which
 * run in order: this side's DHT only, both sides', then the contact's.
 */
let relays: { url: string; server: Server }[] = [];
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
const alice = home("alice"), bob = home("bob");
let env: NodeJS.ProcessEnv;
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });
/** Alice's first text on the DHT, which the edits below change. */
let id = "";

beforeAll(async () => {
  relays = await Promise.all([localRelay(), localRelay()]);
  dht = await hyperdhtTestnet();
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(","), GHOSTLY_TEST_RELAY_REQUESTS_PER_MINUTE: "Infinity" };
  for (const dir of [alice, bob]) {
    ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
    const daemon = new Running(["--home", dir, "daemon"], env);
    running.push(daemon);
    await daemon.waitFor((l) => l.daemon === "ready");
  }
  const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
  ok(await as(bob, "invite", "join", invite.link as string, "--label", "alice"));
  for (const [dir, chat] of [[alice, "bob"], [bob, "alice"]]) ok(await as(dir, "chat", "wait", chat, "--until", "live", "--timeout", "90"));
}, 180_000);

afterAll(async () => {
  await Promise.all(running.map((r) => r.stop()));
  await dht?.destroy();
  for (const relay of relays) relay.server.close();
}, 30_000);

/**
 * Such a text or edit, in a chat on the DHT only, was refused with the engine's own words ("Text and authentication
 * exceed the DHT packet budget. Shorten the message."): no limit to shorten to, and no way out, while one past 256 bytes
 * says both. It says it as the apps and that note do: too long for the DHT, about how much fits, and what ends it, by
 * whose choice the chat is there. The sizes it names do go.
 */
it("a text or an edit too long for the DHT packet says how much fits and what ends it: this side's choice", { timeout: 300_000 }, async () => {
  // This side's choice: the way out is its own command.
  ok(await as(alice, "chat", "transport", "bob", "dht"));
  id = ok(await as(alice, "send", "bob", "first on the DHT", "--wait", "delivered", "--timeout", "90")).messageId as string;
  const text = error(await as(alice, "send", "bob", "x".repeat(252), "--wait", "none"), "refused", 1).message;
  expect(text).toBe("Too long for the DHT (a text fits about 248 bytes there once sealed): this chat is on the DHT only: send it once you choose a live transport (ghostly chat transport bob auto), or shorten it");
  const edit = error(await as(alice, "edit", "bob", id, "e".repeat(230), "--wait", "none"), "refused", 1).message;
  expect(edit).toBe("Too long for the DHT (an edit fits about 214 bytes there once sealed): this chat is on the DHT only: make the edit once you choose a live transport (ghostly chat transport bob auto), or shorten it");
  // What the words name fits: an edit and a text of those sizes are taken.
  expect(ok(await as(alice, "edit", "bob", id, "e".repeat(214), "--wait", "none"))).toMatchObject({ edits: 1 });
  expect(ok(await as(alice, "send", "bob", "x".repeat(248), "--wait", "none")).messageId).toBeTruthy();
});

/**
 * Such a text waited for good as "Waits for the text before it to be confirmed", with nothing before it, and a text
 * written after it went first. It is refused, with the packet's reason, as one past the 256 bytes says to shorten it.
 */
it("on the DHT floor, a text within 256 bytes that its packet cannot carry is refused, and the next one goes", { timeout: 300_000 }, async () => {
  ok(await as(bob, "chat", "transport", "alice", "dht"));
  // On the floor, and carried there: the chat's earlier texts are all delivered.
  ok(await as(alice, "send", "bob", "both on the DHT", "--wait", "delivered", "--timeout", "90"));

  for (const bytes of [256, 252]) {
    const refused = error(await as(alice, "send", "bob", "x".repeat(bytes), "--wait", "none"), "refused", 1);
    // As the apps and a text past 256 bytes say it: too long for the DHT, about how much fits, and what ends it.
    expect(refused.message, `${bytes} bytes`).toBe("Too long for the DHT (a text fits about 248 bytes there once sealed): you and the contact keep this chat on the DHT only: send it once both choose a live transport (ghostly chat transport bob auto), or shorten it");
  }
  ok(await as(alice, "send", "bob", "after the long one", "--wait", "delivered", "--timeout", "90"));
  // Nothing of it waits here, and nothing of it went.
  const texts = async (dir: string, chat: string, from: string) => {
    const shown = (ok(await as(dir, "chat", "history", chat, "--limit", "10")).messages as { text: string; from: string }[]).filter((m) => m.from === from).map((m) => m.text);
    return shown.slice(shown.indexOf("both on the DHT"));
  };
  expect(await texts(alice, "bob", "me")).toEqual(["both on the DHT", "after the long one"]);
  expect(await texts(bob, "alice", "peer")).toEqual(["both on the DHT", "after the long one"]);
});

/**
 * An edit the packet cannot carry, a 252-byte one or a ~230-byte one that fits as a text but not with the element,
 * answered `confirmed: false` and stayed pending for good with no reason, while the contact kept the old text. In a
 * DHT-only chat it is refused at once with the reason a text gets, and nothing of it waits.
 */
it("on the DHT floor, an edit its packet cannot carry is refused at once, and a shorter one goes", { timeout: 300_000 }, async () => {
  const mine = ok(await as(alice, "send", "bob", "to edit on the DHT", "--wait", "delivered", "--timeout", "90")).messageId as string;

  // 252 bytes, 230 (a text that long fits the packet; with the edit's element it does not), and 230 of two-byte letters.
  for (const text of ["e".repeat(252), "e".repeat(230), "é".repeat(115)]) {
    const refused = error(await as(alice, "edit", "bob", mine, text, "--wait", "none"), "refused", 1);
    expect(refused.message, `${Buffer.byteLength(text)} bytes`).toBe("Too long for the DHT (an edit fits about 214 bytes there once sealed): you and the contact keep this chat on the DHT only: make the edit once both choose a live transport (ghostly chat transport bob auto), or shorten it");
  }
  const shown = async () => (ok(await as(alice, "chat", "history", "bob", "--limit", "10")).messages as { id: string; text: string; editPending?: boolean }[]).find((m) => m.id === mine);
  expect(await shown()).toMatchObject({ text: "to edit on the DHT" });
  expect((await shown())?.editPending).toBeUndefined();

  const edited = ok(await as(alice, "edit", "bob", mine, "a shorter edit", "--wait", "confirmed", "--timeout", "90"));
  expect(edited).toMatchObject({ edits: 1, confirmed: true });
  const theirs = (ok(await as(bob, "chat", "history", "alice", "--limit", "10")).messages as { from: string; text: string }[]).filter((m) => m.from === "peer").map((m) => m.text);
  expect(theirs).toContain("a shorter edit");
  expect(theirs).not.toContain("to edit on the DHT");
});

it("a text or an edit too long for the DHT packet says how much fits and what ends it: the contact's choice", { timeout: 300_000 }, async () => {
  // The contact's choice: nothing this side runs ends it.
  ok(await as(alice, "chat", "transport", "bob", "auto"));
  await expect.poll(async () => ok(await as(alice, "chat", "show", "bob")).peerDeliveryMode, { timeout: 120_000, interval: 2_000 }).toBe("dht");
  const theirs = error(await as(alice, "send", "bob", "x".repeat(252), "--wait", "none"), "refused", 1).message;
  expect(theirs).toBe("Too long for the DHT (a text fits about 248 bytes there once sealed): the contact keeps this chat on the DHT only: send it once they choose a live transport, or shorten it");
  const theirEdit = error(await as(alice, "edit", "bob", id, "e".repeat(230), "--wait", "none"), "refused", 1).message;
  expect(theirEdit).toBe("Too long for the DHT (an edit fits about 214 bytes there once sealed): the contact keeps this chat on the DHT only: make the edit once they choose a live transport, or shorten it");
});
