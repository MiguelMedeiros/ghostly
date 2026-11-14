import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oneChatOnly, oneGroupOnly, readsNoHistory } from "../src/main";
import { ghostly, home, hyperdhtTestnet, ok, Running } from "./support/cli";
// covers: headless.one-shot, headless.groups

/** Pkarr relays on loopback that keep one store between them: each counts the requests that came to it. */
async function relays(count: number) {
  const packets = new Map<string, Buffer>();
  return Promise.all(Array.from({ length: count }, async () => {
    const relay = { url: "", requests: [] as string[], close: () => {} };
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (c: Buffer) => chunks.push(c));
      request.on("end", () => {
        relay.requests.push(request.method ?? "?");
        const key = new URL(request.url ?? "/", "http://relay").pathname.slice(1);
        if (request.method === "PUT") {
          const body = Buffer.concat(chunks), known = packets.get(key);
          if (body.length >= 72 && (!known || body.readBigUInt64BE(64) >= known.readBigUInt64BE(64))) packets.set(key, body);
          response.writeHead(body.length >= 72 ? 204 : 400).end();
          return;
        }
        const packet = packets.get(key);
        response.writeHead(packet ? 200 : 404).end(packet);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    relay.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    relay.close = () => { server.closeAllConnections(); server.close(); };
    return relay;
  }));
}

/**
 * A one-shot about one 1:1 chat (`send`, `chat wait`, a bot's `task send`) or one that joins a chat (`invite join`) starts that chat only.
 * It started every saved chat: each put its records and its leave packet on the relays, and with 12 unused invites
 * saved one `send` took the relays' 30 requests a minute (60 on two). Bob's requests come to a relay of his own,
 * which shares its store with Carol's: only his are counted.
 */
describe("a one-shot about one chat", { timeout: 180_000 }, () => {
  let bobRelay: Awaited<ReturnType<typeof relays>>[number], carolRelay: typeof bobRelay;
  let dht: Awaited<ReturnType<typeof hyperdhtTestnet>>;
  const bob = home("one-shot-one-chat-bob"), carol = home("one-shot-one-chat-carol");
  const running: Running[] = [];
  let bobEnv: NodeJS.ProcessEnv, carolEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    [bobRelay, carolRelay] = await relays(2);
    dht = await hyperdhtTestnet();
    bobEnv = { GHOSTLY_PKARR_RELAYS: bobRelay.url, GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap };
    carolEnv = { GHOSTLY_PKARR_RELAYS: carolRelay.url, GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap };
    // Twelve invites nobody took, made through Bob's daemon (it answers at once when the relays hold them back).
    const daemon = new Running(["--home", bob, "daemon"], bobEnv);
    running.push(daemon);
    await daemon.waitFor((l) => l.daemon === "ready");
    for (let i = 0; i < 12; i++) ok(await ghostly(["--home", bob, "invite", "create", "--label", `unused${i}`], { env: bobEnv }));
    ok(await ghostly(["--home", bob, "daemon", "stop"], { env: bobEnv }));
    await daemon.exited(20_000);
    const carolDaemon = new Running(["--home", carol, "daemon"], carolEnv);
    running.push(carolDaemon);
    await carolDaemon.waitFor((l) => l.daemon === "ready");
  }, 120_000);
  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    bobRelay?.close(); carolRelay?.close();
  }, 30_000);

  /** Bob's relay requests while `args` runs as a one-shot on his profile. */
  const counted = async (args: string[]) => {
    bobRelay.requests.length = 0;
    const result = await ghostly(["--home", bob, ...args], { env: bobEnv });
    return { result, requests: bobRelay.requests.length };
  };

  it("invite join starts the joined chat only, and send and chat wait the chat they name", async () => {
    const invite = ok(await ghostly(["--home", carol, "invite", "create", "--label", "bob"], { env: carolEnv }));
    const join = await counted(["invite", "join", invite.link as string, "--label", "carol"]);
    const wait = await counted(["chat", "wait", "carol", "--until", "live", "--timeout", "60"]);
    const send = await counted(["send", "carol", "hello from a one-shot"]);
    // A status card's chat may name a group, so the groups start for it; the saved 1:1 chats it does not name do not.
    const task = await counted(["task", "send", "carol", "--title", "A card from a one-shot", "--wait", "delivered", "--timeout", "60"]);
    // The chat named started: it paired, went live with Carol's daemon, and took the text.
    expect(ok(join.result)).toMatchObject({ paired: true });
    expect(ok(wait.result)).toMatchObject({ live: true });
    expect(ok(send.result)).toMatchObject({ chat: join.result.json.chat, delivery: expect.stringMatching(/^(sent|delivered)$/) });
    expect(ok(task.result)).toMatchObject({ chat: join.result.json.chat, delivery: "delivered" });
    // 13 chats started asked the relay its whole 30 a minute; the one chat named asks it 6 to 20 times.
    for (const [name, requests] of [["invite join", join.requests], ["chat wait", wait.requests], ["send", send.requests], ["task send", task.requests]] as const) {
      expect(requests, name).toBeLessThan(24);
    }
  });

  it("starts every chat for a call that names none and makes none", () => {
    expect(oneChatOnly("invite.join", { invite: "ghostly1…" })).toBe(true);
    expect(oneChatOnly("invite.create", {})).toBe(true);
    expect(oneChatOnly("file.send", { chat: "carol", path: "a.txt" })).toBe(true);
    expect(oneChatOnly("usage.send", { all: true })).toBe(false);
    // A call whose chat may name a group leaves the other 1:1 chats unstarted too; its groups start (`chatOnly` is false).
    expect(oneChatOnly("task.send", { chat: "Sala" })).toBe(true);
    expect(oneChatOnly("chat.delete", { chat: "Crew", message: "mine:0:2", everyone: true })).toBe(true);
    expect(oneChatOnly("usage.send", { chat: "Sala" })).toBe(true);
    expect(oneChatOnly("group.send", { group: "Sala", chat: "carol" })).toBe(false);
    expect(oneChatOnly("chat.list", {})).toBe(false);
  });

  it("leaves every chat unstarted, its history unread, for a read that needs none", () => {
    for (const method of ["status", "profile.get", "settings.get", "status.get", "chat.list", "group.list", "group.get", "group.history",
      "call.list", "service.list", "identity.list", "x401.credential.list", "app.served", "wallet.list", "wallet.history", "payment.list",
      "identity.providers"]) expect(readsNoHistory(method), method).toBe(true);
    // `call auto` and `group auto` with no on|off say what is kept in the profile.
    for (const method of ["call.auto", "group.auto"]) {
      expect(readsNoHistory(method, {}), method).toBe(true);
      expect(readsNoHistory(method, { on: true, from: ["carol"] }), method).toBe(false);
    }
    // A chat's own read restores the chat it names (`startNamedChats`); a read across chats may need what their histories say.
    for (const method of ["chat.history", "file.list", "saved.list", "events.replay", "chat.send"]) expect(readsNoHistory(method), method).toBe(false);
  });
});

/**
 * A one-shot about one group that goes over its edges only (`group send`, `group edit`, `group react`, `group typing`)
 * leaves the saved 1:1 chats unstarted. It started them all: with 12 invites saved their publishes took the relay's
 * whole minute, the group's edge never came up behind them, and `group send --wait sent` and `group react` each timed
 * out after 60 s, exit 4, with nothing said. Nor does it start the edges of the other groups saved: with six more
 * groups shared with Erin, each put its records and read hers, and one `group send` asked the relay about three times
 * what the group alone does. Dave's requests come to a relay of his own, as Bob's above.
 *
 * Erin's daemon has no relay budget (`GHOSTLY_TEST_RELAY_REQUESTS_PER_MINUTE`): only Dave's requests are measured. With
 * it, her seven edges to Dave all watched him once his daemon stopped, their reads shared the watch share (2 in 10 s,
 * the key read longest ago first), and the edge the send's goodbye had just read read Dave's next offer last: the
 * `group react` waited 28 to 52 s for an edge on one busy core, and past its 60 s on CI (exit 4).
 */
describe("a one-shot about one group", { timeout: 300_000 }, () => {
  let daveRelay: Awaited<ReturnType<typeof relays>>[number], erinRelay: typeof daveRelay;
  let dht: Awaited<ReturnType<typeof hyperdhtTestnet>>;
  const dave = home("one-shot-one-group-dave"), erin = home("one-shot-one-group-erin");
  const running: Running[] = [];
  let daveEnv: NodeJS.ProcessEnv, erinEnv: NodeJS.ProcessEnv;
  let group = "";

  beforeAll(async () => {
    [daveRelay, erinRelay] = await relays(2);
    dht = await hyperdhtTestnet();
    daveEnv = { GHOSTLY_PKARR_RELAYS: daveRelay.url, GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap };
    erinEnv = { GHOSTLY_PKARR_RELAYS: erinRelay.url, GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_TEST_RELAY_REQUESTS_PER_MINUTE: "Infinity" };
    const erinDaemon = new Running(["--home", erin, "daemon"], erinEnv);
    const daveDaemon = new Running(["--home", dave, "daemon"], daveEnv);
    running.push(erinDaemon, daveDaemon);
    await Promise.all([erinDaemon, daveDaemon].map((d) => d.waitFor((l) => l.daemon === "ready")));
    // Dave joins Erin's private group and six more of hers through their links, then makes twelve invites nobody
    // takes, and stops.
    for (const name of ["Crew", "One", "Two", "Three", "Four", "Five", "Six"]) {
      const made = ok(await ghostly(["--home", erin, "group", "create", name, "--mesh"], { env: erinEnv })).group as string;
      const link = ok(await ghostly(["--home", erin, "group", "link", made], { env: erinEnv })).link as string;
      ok(await ghostly(["--home", dave, "group", "join", link], { env: daveEnv }));
      for (let i = 0; ; i++) {
        const shown = ok(await ghostly(["--home", dave, "group", "show", made], { env: daveEnv }));
        const members = shown.members as { online: boolean }[];
        if (shown.status === "active" && members.length === 2 && members.every((m) => m.online)) break;
        if (i > 90) throw new Error(`Dave not in ${name}: ${JSON.stringify(shown)}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      group ||= made;
    }
    for (let i = 0; i < 12; i++) ok(await ghostly(["--home", dave, "invite", "create", "--label", `unused${i}`], { env: daveEnv }));
    ok(await ghostly(["--home", dave, "daemon", "stop"], { env: daveEnv }));
    await daveDaemon.exited(20_000);
  }, 300_000);
  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    daveRelay?.close(); erinRelay?.close();
  }, 30_000);

  const counted = async (args: string[]) => {
    daveRelay.requests.length = 0;
    const result = await ghostly(["--home", dave, ...args], { env: daveEnv });
    return { result, requests: daveRelay.requests.length };
  };

  it("group send and group react start the groups only, and an edge takes each", async () => {
    const send = await counted(["group", "send", group, "hello from a one-shot", "--wait", "sent", "--timeout", "60"]);
    const sent = ok(send.result);
    expect(sent).toMatchObject({ group, sent: true });
    const react = await counted(["group", "react", group, sent.messageId as string, "👍", "--timeout", "60"]);
    expect(ok(react.result)).toMatchObject({ group, sent: true });
    // 13 chats started asked the relay its whole 30 a minute and more, the six other groups' edges 31 to 47 times; the
    // group alone asks it 3 to 17 times.
    for (const [name, requests] of [["group send", send.requests], ["group react", react.requests]] as const) expect(requests, name).toBeLessThan(24);
  });

  it("leaves the 1:1 chats unstarted only for what goes over the group's edges", () => {
    for (const method of ["group.send", "group.edit", "group.react", "group.typing"]) expect(oneGroupOnly(method), method).toBe(true);
    // An invitation goes over the contact's 1:1 chat, and an answer to one over the chat it came by.
    for (const method of ["group.invite", "group.accept", "group.decline", "group.join", "chat.send"]) expect(oneGroupOnly(method), method).toBe(false);
  });
});
