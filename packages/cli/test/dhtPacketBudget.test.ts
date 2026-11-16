import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: chat.dht.delivery, headless.chat

/**
 * A text within the DHT's 256 bytes that does not fit its packet once sealed (about 249-256 bytes of ASCII in a paired
 * chat): it waited for good as "Waits for the text before it to be confirmed", with nothing before it, and a text
 * written after it went first. It is refused, with the packet's reason, as one past the 256 bytes says to shorten it.
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

it("on the DHT floor, a text within 256 bytes that its packet cannot carry is refused, and the next one goes", { timeout: 300_000 }, async () => {
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
  // On the floor, and carried there: the chat's earlier texts are all delivered.
  ok(await as(alice, "send", "bob", "first on the DHT", "--wait", "delivered", "--timeout", "90"));

  for (const bytes of [256, 252]) {
    const refused = error(await as(alice, "send", "bob", "x".repeat(bytes), "--wait", "none"), "refused", 1);
    expect(refused.message, `${bytes} bytes`).toContain("DHT packet budget");
  }
  ok(await as(alice, "send", "bob", "after the long one", "--wait", "delivered", "--timeout", "90"));
  // Nothing of it waits here, and nothing of it went (the pairing's "joined" aside).
  const texts = async (dir: string, chat: string, from: string) => {
    const shown = (ok(await as(dir, "chat", "history", chat, "--limit", "10")).messages as { text: string; from: string }[]).filter((m) => m.from === from).map((m) => m.text);
    return shown.slice(shown.indexOf("first on the DHT"));
  };
  expect(await texts(alice, "bob", "me")).toEqual(["first on the DHT", "after the long one"]);
  expect(await texts(bob, "alice", "peer")).toEqual(["first on the DHT", "after the long one"]);
});
