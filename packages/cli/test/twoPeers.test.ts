import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: headless.daemon, headless.chat, headless.events, headless.hooks, headless.groups, headless.one-shot, headless.cli, headless.files, headless.group-admin, headless.identities, headless.services, headless.typing

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

  it("show the contact this side is typing, and its stream says when it started and stopped", async () => {
    const listen = new Running(["--home", bob, "listen", "--type", "typing.started", "--type", "typing.stopped"], env);
    running.push(listen);
    await new Promise((r) => setTimeout(r, 1000));
    expect(ok(await as(alice, "typing", "bob"))).toMatchObject({ chat: chatA, typing: true, live: true, sendTyping: true });
    expect(await listen.waitFor((l) => l.type === "typing.started")).toMatchObject({ chat: chatB });
    ok(await as(alice, "typing", "bob", "--stop"));
    expect(await listen.waitFor((l) => l.type === "typing.stopped")).toMatchObject({ chat: chatB });
    // A message ends it too, with no stop.
    const count = (type: string) => listen.lines.filter((l) => l.type === type).length;
    ok(await as(alice, "typing", "bob"));
    await expect.poll(() => count("typing.started"), { timeout: 30_000 }).toBe(2);
    ok(await as(alice, "send", "bob", "done typing", "--wait", "delivered"));
    await expect.poll(() => count("typing.stopped"), { timeout: 30_000 }).toBe(2);
    await listen.stop();
  });

  it("send files: a small one taken at once, a large one only once accepted, saved byte for byte", async () => {
    const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const listen = new Running(["--home", bob, "listen", "--type", "file.", "--type", "message.received"], env);
    running.push(listen);
    await new Promise((r) => setTimeout(r, 1000));
    const small = join(alice, "note.txt");
    writeFileSync(small, randomBytes(200_000));
    const sent = ok(await as(alice, "file", "send", "bob", small));
    const fileMessage = await listen.waitFor((e) => e.type === "message.received" && !!(e.message as { file?: unknown }).file);
    const incoming = (fileMessage.message as { file: { id: string; name: string; size: number } }).file;
    expect(incoming).toMatchObject({ name: "note.txt", size: 200_000 });
    await listen.waitFor((e) => e.type === "file.done" && e.file === incoming.id);
    const saved = ok(await as(bob, "file", "save", incoming.id, "--dir", bob));
    expect(sha(saved.path as string)).toBe(sha(small));
    error(await as(bob, "file", "save", incoming.id, "--dir", bob), "confirm", 5);
    expect((sent.file as { size: number }).size).toBe(200_000);

    const large = join(alice, "big.bin");
    writeFileSync(large, randomBytes(26 * 1024 * 1024));
    ok(await as(alice, "file", "send", "bob", large));
    const offer = await listen.waitFor((e) => e.type === "file.offered", 90_000);
    ok(await as(bob, "file", "accept", "alice", offer.file as string));
    await listen.waitFor((e) => e.type === "file.done" && e.file === offer.file, 120_000);
    const savedLarge = ok(await as(bob, "file", "save", offer.file as string, "--path", join(bob, "big-copy.bin")));
    expect(savedLarge.size).toBe(26 * 1024 * 1024);
    expect(sha(join(bob, "big-copy.bin"))).toBe(sha(large));
    await listen.stop();
  });

  it("prove an SSH key with ssh-keygen and show it to the contact, who checks it", async () => {
    const key = join(alice, "id_ed25519");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "bot", "-f", key]);
    const pub = readFileSync(`${key}.pub`, "utf8").trim();
    const started = ok(await as(alice, "identity", "add", "ssh", pub, "--signer", "ssh-keygen", "--days", "30"));
    expect(started).toMatchObject({ done: false, provider: "ssh", signer: "ssh-keygen" });
    expect(started.statement).toMatch(/^Ghostly identity proof v1: I control ssh:/);
    const signature = execFileSync("ssh-keygen", ["-Y", "sign", "-n", "ghostly", "-f", key], { input: started.statement as string }).toString();
    error(await ghostly(["--home", alice, "identity", "complete", started.draft as string, "--stdin"], { env, input: "not a signature" }), "bad_request", 1);
    const done = ok(await ghostly(["--home", alice, "identity", "complete", started.draft as string, "--stdin"], { env, input: signature }));
    const proof = done.proof as { id: string; provider: string };
    expect(proof.provider).toBe("ssh");
    expect((ok(await as(alice, "identity", "list")).proofs as { id: string }[]).map((p) => p.id)).toContain(proof.id);

    const listen = new Running(["--home", bob, "listen", "--type", "identity."], env);
    running.push(listen);
    await new Promise((r) => setTimeout(r, 500));
    ok(await as(alice, "identity", "share", "bob", proof.id));
    await listen.waitFor((e) => e.type === "identity.received" || e.type === "identity.status", 60_000);
    const until = Date.now() + 60_000;
    let seen: { received: { id: string; status: string }[] } = { received: [] };
    while (Date.now() < until) {
      seen = ok(await as(bob, "identity", "contact", "alice")) as typeof seen;
      if (seen.received.some((r) => r.id === proof.id && r.status === "verified")) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(seen.received.find((r) => r.id === proof.id)).toMatchObject({ status: "verified" });
    await listen.stop();
  });

  it("share a web app on this machine with the contact, who opens it on a port of its own", async () => {
    const app = createServer((request, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end(`hello from ${request.url}`); });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    try {
      error(await as(alice, "service", "add", "outside", "http://example.com"), "refused", 1);
      const added = ok(await as(alice, "service", "add", "notes", `http://127.0.0.1:${(app.address() as AddressInfo).port}`));
      const service = added.serviceId as string;
      ok(await as(alice, "service", "share", service, "bob"));
      const until = Date.now() + 60_000;
      let peer: { services: { id: string }[] } = { services: [] };
      while (Date.now() < until) {
        peer = ok(await as(bob, "service", "peer", "alice")) as typeof peer;
        if (peer.services.some((s) => s.id === service)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(peer.services.map((s) => s.id)).toContain(service);
      const opened = ok(await as(bob, "service", "open", "alice", service));
      const page = await fetch(new URL("/docs?x=1", opened.url as string));
      expect(page.status).toBe(200);
      expect(await page.text()).toBe("hello from /docs?x=1");
      ok(await as(bob, "service", "close", "alice", service));
      ok(await as(alice, "service", "share", service, "bob", "--off"));
    } finally { app.close(); }
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
    const until = Date.now() + 150_000;
    let group: Record<string, unknown> = {};
    while (Date.now() < until) {
      group = ok(await as(alice, "group", "show", created.group as string));
      if ((group.members as { name: string | null; me: boolean }[]).some((m) => !m.me && m.name)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const bobSide = ok(await as(bob, "group", "list"));
    expect((group.members as { name: string | null; me: boolean }[]).filter((m) => !m.me).map((m) => m.name), `Bob's side: ${JSON.stringify(bobSide)}`).toEqual(["Bob"]);
    const listen = new Running(["--home", bob, "listen", "--type", "group."], env);
    running.push(listen);
    await new Promise((r) => setTimeout(r, 1000));
    ok(await as(alice, "group", "send", "Bot crew", "hey @Bob", "--mention", "Bob"));
    const event = await listen.waitFor((l) => l.type === "group.message", 60_000);
    expect(event).toMatchObject({ group: joined.group, message: { text: "hey @Bob", mentioned: true } });

    // The admin's tools: a picture everyone sees (only the admin sets it), a new link (the old one stops working),
    // a fresh secret. A picture that is not a JPEG is refused before the engine is asked.
    const fixtures = join(import.meta.dirname, "../../../e2e/support/avatar-fixtures");
    ok(await as(alice, "group", "picture", "Bot crew", join(fixtures, "avatar.jpg")));
    error(await as(bob, "group", "picture", "Bot crew", join(fixtures, "avatar.jpg")), "engine", 1);
    error(await as(alice, "group", "picture", "Bot crew", join(fixtures, "avatar.png")), "bad_request", 1);
    const reset = ok(await as(alice, "group", "link", "Bot crew", "--reset"));
    expect(reset.link).toBeTruthy();
    expect(reset.link).not.toBe(created.link);
    ok(await as(alice, "group", "rotate", "Bot crew"));
    const shown = Date.now() + 60_000;
    let seen: Record<string, unknown> = {};
    while (Date.now() < shown) {
      seen = ok(await as(bob, "group", "show", joined.group as string));
      if (seen.picture) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(seen.picture).toBe(true);
    ok(await as(alice, "profile", "picture", join(fixtures, "avatar.jpg")));
    const face = Date.now() + 60_000;
    let chat: Record<string, unknown> = {};
    while (Date.now() < face) {
      chat = ok(await as(bob, "chat", "show", "alice"));
      if (chat.peerPicture) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(chat.peerPicture).toBe(true);
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
