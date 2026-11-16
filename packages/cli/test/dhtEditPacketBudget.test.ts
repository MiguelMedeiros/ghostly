import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: chat.dht.delivery, chat.edit.wire, headless.chat

/**
 * An edit on the DHT floor goes as a text with its element (the message's id and the edit's number), so one the packet
 * cannot carry is shorter than a text's bound: a 252-byte edit, or a ~230-byte one that fits as a text but not with the
 * element. It answered `confirmed: false` and stayed pending for good with no reason, while the contact kept the old
 * text. In a DHT-only chat it is refused at once with the reason a text gets, and nothing of it waits.
 */
let relays: { url: string; server: Server }[] = [];
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
const alice = home("alice"), bob = home("bob");
let env: NodeJS.ProcessEnv;
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });

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

it("on the DHT floor, an edit its packet cannot carry is refused at once, and a shorter one goes", { timeout: 300_000 }, async () => {
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
  ok(await as(bob, "chat", "transport", "alice", "dht"));
  const id = ok(await as(alice, "send", "bob", "first on the DHT", "--wait", "delivered", "--timeout", "90")).messageId as string;

  // 252 bytes, 230 (a text that long fits the packet; with the edit's element it does not), and 230 of two-byte letters.
  for (const text of ["e".repeat(252), "e".repeat(230), "é".repeat(115)]) {
    const refused = error(await as(alice, "edit", "bob", id, text, "--wait", "none"), "refused", 1);
    expect(refused.message, `${Buffer.byteLength(text)} bytes`).toContain("DHT packet budget");
  }
  const mine = async () => (ok(await as(alice, "chat", "history", "bob", "--limit", "10")).messages as { id: string; text: string; editPending?: boolean }[]).find((m) => m.id === id);
  expect(await mine()).toMatchObject({ text: "first on the DHT" });
  expect((await mine())?.editPending).toBeUndefined();

  const edited = ok(await as(alice, "edit", "bob", id, "a shorter edit", "--wait", "confirmed", "--timeout", "90"));
  expect(edited).toMatchObject({ edits: 1, confirmed: true });
  const theirs = (ok(await as(bob, "chat", "history", "alice", "--limit", "10")).messages as { from: string; text: string }[]).filter((m) => m.from === "peer").map((m) => m.text);
  expect(theirs).toContain("a shorter edit");
  expect(theirs).not.toContain("first on the DHT");
});
