import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: headless.daemon, headless.chat, headless.events, headless.hooks, headless.groups, headless.one-shot, headless.cli

/**
 * Two bots, each a `ghostly` daemon on its own profile, as a person would run them: a chat from an invite, live over
 * native HyperDHT, messages both ways, an echo bot on `listen --exec`, a community group with a mention, and a
 * one-shot command while the other side's daemon runs. Everything on loopback: a Pkarr relay in this process and a
 * HyperDHT testnet.
 */
let relay: { url: string; server: Server };
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
const alice = home("alice"), bob = home("bob");
let env: NodeJS.ProcessEnv;
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });

beforeAll(async () => {
  relay = await localRelay();
  dht = await hyperdhtTestnet();
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap };
}, 30_000);

afterAll(async () => {
  await Promise.all(running.map((r) => r.stop()));
  await dht?.destroy();
  relay?.server.close();
}, 30_000);

describe("two headless peers", { timeout: 180_000 }, () => {
  let chatA = "", chatB = "";

  it("set up profiles offline, as one-shots", async () => {
    for (const [dir, name] of [[alice, "Alice bot"], [bob, "Bob"]] as const) {
      ok(await as(dir, "settings", "set", "relays", JSON.stringify([relay.url])));
      expect(ok(await as(dir, "profile", "set", "--name", name))).toMatchObject({ name });
    }
    error(await as(alice, "chat", "show", "nobody"), "not_found", 3);
    error(await as(alice, "frobnicate"), "usage", 2);
  });

  it("pair from an invite and go live", async () => {
    for (const dir of [alice, bob]) {
      const daemon = new Running(["--home", dir, "daemon"], env);
      running.push(daemon);
      await daemon.waitFor((l) => l.daemon === "ready");
    }
    error(await as(alice, "daemon"), "busy", 1);
    const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
    expect(invite.invite).toMatch(/^ghostly1/);
    expect(invite.link).toBe(`https://ghostly.tools/#${invite.invite}`);
    chatA = invite.chat as string;
    // The self-invite guard (WISP 801 Q9).
    error(await as(alice, "invite", "join", invite.invite as string), "refused", 1);
    chatB = ok(await as(bob, "invite", "join", invite.link as string, "--label", "alice")).chat as string;
    for (const [dir, chat] of [[alice, chatA], [bob, chatB]]) {
      expect(ok(await as(dir, "chat", "wait", chat, "--until", "live", "--timeout", "90"))).toMatchObject({ live: true, transport: expect.stringMatching(/^(webrtc|hyperdht)\/1$/) });
    }
    expect(ok(await as(bob, "chat", "show", "alice"))).toMatchObject({ id: chatB, peerName: "Alice bot", pairing: "ready" });
    // As the app's chat screen does: the joiner says it joined, the inviter answers, each once.
    const until = Date.now() + 30_000;
    let notices: string[] = [];
    while (Date.now() < until && notices.length < 2) {
      notices = (ok(await as(alice, "chat", "history", "bob")).messages as { text: string }[]).map((m) => m.text);
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(notices.sort()).toEqual(["👋 Alice bot joined", "👋 Bob joined"]);
    const events = ok(await as(alice, "events")).events as { type: string; name?: string }[];
    expect(events.filter((e) => e.type === "chat.joined").map((e) => e.name)).toEqual(["Bob"]);
    expect(events.filter((e) => e.type === "message.received")).toEqual([]);
  });

  it("move a chat to native HyperDHT when asked", async () => {
    ok(await as(alice, "chat", "transport", "bob", "hyperdht"));
    const until = Date.now() + 90_000;
    let shown: Record<string, unknown> = {};
    while (Date.now() < until) {
      shown = ok(await as(bob, "chat", "show", "alice"));
      if (shown.transport === "hyperdht/1") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(shown).toMatchObject({ live: true, transport: "hyperdht/1" });
  });

  it("carry messages both ways, with events a bot can act on", async () => {
    const listen = new Running(["--home", bob, "listen", "--type", "message.received"], env);
    running.push(listen);
    await new Promise((r) => setTimeout(r, 1000));
    const sent = ok(await as(alice, "send", "bob", "hello", "bob", "--wait", "delivered"));
    expect(sent).toMatchObject({ chat: chatA, delivery: "delivered" });
    const event = await listen.waitFor((l) => l.type === "message.received");
    expect(event).toMatchObject({ chat: chatB, message: { text: "hello bob", from: "peer" } });
    expect(event.id).toBe(`message.received:${chatB}:${(event.message as { id: string }).id}`);
    // Text from stdin, and a message that starts with a dash after --.
    ok(await ghostly(["--home", alice, "send", "bob", "--wait", "delivered"], { env, input: "from stdin\n" }));
    ok(await as(alice, "send", "bob", "--wait", "delivered", "--", "-dash first"));
    error(await as(alice, "send", "bob", "-oops"), "usage", 2);
    error(await as(alice, "send", "bob", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"), "confirm", 5);
    await listen.waitFor((l) => (l.message as { text?: string } | undefined)?.text === "-dash first");
    const history = ok(await as(bob, "chat", "history", "alice")).messages as { text: string }[];
    expect(history.map((m) => m.text).filter((t) => !t.startsWith("👋"))).toEqual(["hello bob", "from stdin", "-dash first"]);
    await listen.stop();
  });

  it("answer from a hook: an echo bot on listen --exec", async () => {
    const script = join(bob, "echo.mjs");
    writeFileSync(script, `
      import { execFileSync } from "node:child_process";
      let input = ""; for await (const c of process.stdin) input += c;
      const event = JSON.parse(input);
      execFileSync(process.execPath, [${JSON.stringify(join(import.meta.dirname, "../dist/ghostly.mjs"))}, "--home", ${JSON.stringify(bob)}, "send", event.chat, "--", "echo: " + event.message.text]);
    `);
    const bot = new Running(["--home", bob, "listen", "--type", "message.received", "--exec", `"${process.execPath}" "${script}"`, "--cursor", join(bob, "cursor")], env);
    running.push(bot);
    await new Promise((r) => setTimeout(r, 1000));
    ok(await as(alice, "send", "bob", "ping", "--wait", "delivered"));
    const until = Date.now() + 60_000;
    let texts: string[] = [];
    while (Date.now() < until) {
      texts = (ok(await as(alice, "chat", "history", "bob", "--limit", "10")).messages as { text: string }[]).map((m) => m.text);
      if (texts.includes("echo: ping")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(texts, bot.stderr).toContain("echo: ping");
    await bot.stop();
  });

  it("talk in a community group, with a mention", async () => {
    const created = ok(await as(alice, "group", "create", "Bot", "crew"));
    expect(created.link).toBeTruthy();
    const joined = ok(await as(bob, "group", "join", created.link as string));
    const until = Date.now() + 90_000;
    let group: Record<string, unknown> = {};
    while (Date.now() < until) {
      group = ok(await as(alice, "group", "show", created.group as string));
      if ((group.members as { name: string | null; me: boolean }[]).some((m) => !m.me && m.name)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect((group.members as { name: string | null; me: boolean }[]).filter((m) => !m.me).map((m) => m.name)).toEqual(["Bob"]);
    const listen = new Running(["--home", bob, "listen", "--type", "group."], env);
    running.push(listen);
    await new Promise((r) => setTimeout(r, 1000));
    ok(await as(alice, "group", "send", "Bot crew", "hey @Bob", "--mention", "Bob"));
    const event = await listen.waitFor((l) => l.type === "group.message", 60_000);
    expect(event).toMatchObject({ group: joined.group, message: { text: "hey @Bob", mentioned: true } });
    await listen.stop();
  });

  it("send as a one-shot while the other side's daemon runs, and stop cleanly", async () => {
    const daemonA = running[0];
    ok(await as(alice, "daemon", "stop"));
    expect(daemonA.child.exitCode).toBe(0);
    expect(ok(await as(alice, "daemon", "status"))).toMatchObject({ running: false });
    expect(ok(await as(alice, "send", "bob", "from a one-shot", "--wait", "delivered", "--timeout", "90"))).toMatchObject({ delivery: "delivered" });
    const history = ok(await as(bob, "chat", "history", "alice", "--limit", "1")).messages as { text: string }[];
    expect(history.map((m) => m.text)).toEqual(["from a one-shot"]);
  });
});
