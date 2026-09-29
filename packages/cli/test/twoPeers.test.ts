import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RACE_DIRECT_MS } from "@ghostly/core";
import { BIN, error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
import { dominantHz, tone, wavFile } from "./support/tone";
// covers: chat.paired.reconnect, groups.edit, files.large.resend, files.large.request, headless.calls, headless.daemon, headless.chat, headless.events, headless.hooks, headless.groups, headless.one-shot, headless.cli, headless.files, headless.group-admin, headless.identities, headless.services, headless.typing, headless.reactions, headless.edit, headless.forward, chat.forward.files

/**
 * Two bots, each a `ghostly` daemon on its own profile, as a person would run them: a chat from an invite, live over
 * native HyperDHT, messages both ways, an echo bot on `listen --exec`, a community group with a mention, and a
 * one-shot command while the other side's daemon runs. Everything on loopback: a Pkarr relay in this process and a
 * HyperDHT testnet.
 */
let relays: { url: string; server: Server }[] = [];
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
const alice = home("alice"), bob = home("bob");
const sockets: Record<string, string> = {};
let env: NodeJS.ProcessEnv;
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });

/**
 * `listen` on `dir`'s daemon from its last event as of now: an event that comes while the process still starts is
 * replayed, not missed (a fixed pause before acting was too short on a busy CI runner).
 */
async function listenTo(dir: string, ...args: string[]): Promise<Running> {
  const since = (ok(await as(dir, "status")).events as { lastSeq: number }).lastSeq;
  const listener = new Running(["--home", dir, "listen", "--since", String(since), ...args], env);
  running.push(listener);
  return listener;
}

/** Waits until `dir`'s roster of `group` names a member `name` (names come over the edges, a moment after joining). */
async function waitForMember(dir: string, group: string, name: string): Promise<void> {
  const until = Date.now() + 120_000;
  let shown: Record<string, unknown> = {};
  while (Date.now() < until) {
    shown = ok(await as(dir, "group", "show", group));
    if ((shown.members as { name: string | null; me: boolean }[]).some((m) => !m.me && m.name === name)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect.fail(`${group} on ${dir} never named ${name}: ${JSON.stringify(shown)}`);
}

beforeAll(async () => {
  // Two relays, as a profile has by default (DEFAULT_RELAYS): each gives a daemon its own 30 requests a minute. On one,
  // a daemon in a community group had about 10 a minute left for a new mesh edge, whose offer and answer then missed
  // each other's fast polls and the edge never opened in 90 s.
  relays = await Promise.all([localRelay(), localRelay()]);
  dht = await hyperdhtTestnet();
  // Calls bind their media to loopback: on some machines (a VPN on a Mac) UDP to the machine's own LAN address is dropped.
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_CALL_BIND: "127.0.0.1", ...(process.env.GHOSTLY_LINK_TRACE ? { GHOSTLY_LINK_TRACE: process.env.GHOSTLY_LINK_TRACE } : {}) };
}, 30_000);

afterAll(async () => {
  await Promise.all(running.map((r) => r.stop()));
  await dht?.destroy();
  for (const relay of relays) relay.server.close();
}, 30_000);

describe("two headless peers", { timeout: 180_000 }, () => {
  let chatA = "", chatB = "";

  it("set up profiles offline, as one-shots", async () => {
    for (const [dir, name] of [[alice, "Alice bot"], [bob, "Bob"]] as const) {
      ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
      expect(ok(await as(dir, "profile", "set", "--name", name))).toMatchObject({ name });
    }
    error(await as(alice, "chat", "show", "nobody"), "not_found", 3);
    error(await as(alice, "frobnicate"), "usage", 2);
  });

  it("pair from an invite and go live", async () => {
    for (const dir of [alice, bob]) {
      const daemon = new Running(["--home", dir, "daemon"], env);
      running.push(daemon);
      sockets[dir] = (await daemon.waitFor((l) => l.daemon === "ready")).socket as string;
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

  it("a daemon that restarts is live with its contact again in seconds, stopped or killed (WISP 100, Back after a restart)", async () => {
    const live = async (dir: string, chat: string, seconds: number) =>
      ok(await as(dir, "chat", "wait", chat, "--until", "live", "--timeout", String(seconds)));
    // Early on, while the relays' request budget is whole (WebRTC signals through them), and over WebRTC: over HyperDHT
    // on this loopback testnet a restarted daemon's own dial does not reach its contact, while a bare HyperDHT node
    // restarted the same way does (followed up apart).
    ok(await as(alice, "chat", "transport", "bob", "webrtc"));
    for (const [dir, chat] of [[alice, "bob"], [bob, "alice"]]) {
      const until = Date.now() + 60_000;
      while (Date.now() < until && ok(await as(dir, "chat", "show", chat)).transport !== "webrtc/1") await new Promise((r) => setTimeout(r, 300));
      expect(ok(await as(dir, "chat", "show", chat))).toMatchObject({ live: true, transport: "webrtc/1" });
    }
    const restartBob = async () => {
      const daemon = new Running(["--home", bob, "daemon"], env);
      running.push(daemon);
      sockets[bob] = (await daemon.waitFor((l) => l.daemon === "ready")).socket as string;
      return Date.now();
    };
    const bothWays = async (tag: string) => {
      expect(ok(await as(alice, "send", "bob", `↻ alice ${tag}`, "--wait", "delivered", "--timeout", "30"))).toMatchObject({ delivery: "delivered" });
      expect(ok(await as(bob, "send", "alice", `↻ bob ${tag}`, "--wait", "delivered", "--timeout", "30"))).toMatchObject({ delivery: "delivered" });
    };

    // Stopped: it says goodbye, and Alice's side is off live at once.
    ok(await as(bob, "daemon", "stop"));
    const offLive = Date.now() + 3_000;
    while (Date.now() < offLive && ok(await as(alice, "chat", "show", "bob")).live) await new Promise((r) => setTimeout(r, 100));
    expect(ok(await as(alice, "chat", "show", "bob")).live, "the goodbye ends the session at once").toBe(false);
    let started = Date.now();
    await restartBob();
    await live(bob, "alice", 10);
    await live(alice, "bob", 10);
    const afterStop = Date.now() - started;
    await bothWays("after a stop");

    // Killed: nothing said. Alice still holds the dead session; Bob's app, back, offers at once. Here over WebRTC, whose
    // Node build never says a connection went `disconnected`: Alice reads that offer at a live chat's pace, or the
    // relays' request budget holds her answer back until her answering attempt is over. Most runs are live in seconds.
    // With no answer after RACE_DIRECT_MS (8 s), Bob also dials the HyperDHT ranked after WebRTC, which takes over
    // Alice's held session: about a second, up to 14 s on a loaded machine. Before, the offer ran to its own attempt
    // timeout first (90 s, CONNECT_TIMEOUT_MS). Counted from Bob's daemon being up, when that offer starts.
    const killed = running.pop()!;
    await new Promise((r) => { killed.child.once("exit", r); killed.child.kill("SIGKILL"); });
    started = await restartBob();
    const dial = 20_000;
    await live(bob, "alice", (RACE_DIRECT_MS + dial) / 1000 + 10);
    const afterKill = Date.now() - started;
    await bothWays("after a kill");
    console.log(`[restart] live again after a stop in ${afterStop} ms, after a kill in ${afterKill} ms`);
    expect(afterStop).toBeLessThan(10_000);
    expect(afterKill).toBeLessThan(RACE_DIRECT_MS + dial);
  }, 240_000);

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
    const listen = await listenTo(bob, "--type", "message.received");
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
    // Notices, and the restart step's messages (↻), aside.
    expect(history.map((m) => m.text).filter((t) => !t.startsWith("👋") && !t.startsWith("↻"))).toEqual(["hello bob", "from stdin", "-dash first"]);
    await listen.stop();
  });

  it("show the contact this side is typing, and its stream says when it started and stopped", async () => {
    const listen = await listenTo(bob, "--type", "typing.started", "--type", "typing.stopped");
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

  it("keep typing on with --for until the time is up, or a message ends it", async () => {
    const listen = await listenTo(bob, "--type", "typing.");
    const count = (type: string) => listen.lines.filter((l) => l.type === type).length;
    // A single start fades after 6 s; --for 10 keeps it on past that.
    expect(ok(await as(alice, "typing", "bob", "--for", "10"))).toMatchObject({ typing: true, until: expect.any(Number) });
    await expect.poll(() => count("typing.started"), { timeout: 15_000 }).toBe(1);
    await new Promise((r) => setTimeout(r, 8000));
    expect(count("typing.stopped")).toBe(0);
    await expect.poll(() => count("typing.stopped"), { timeout: 15_000 }).toBe(1);
    ok(await as(alice, "typing", "bob", "--for", "60"));
    await expect.poll(() => count("typing.started"), { timeout: 15_000 }).toBe(2);
    ok(await as(alice, "send", "bob", "typed", "--wait", "delivered"));
    await expect.poll(() => count("typing.stopped"), { timeout: 5_000 }).toBe(2);
    await new Promise((r) => setTimeout(r, 7000));
    expect(count("typing.started")).toBe(2);
    await listen.stop();
  });

  it("show the contact a bot is thinking, with its status, and then recording", async () => {
    const listen = await listenTo(bob, "--type", "typing.started", "--type", "typing.stopped");
    expect(ok(await as(alice, "typing", "bob", "--kind", "thinking", "--status", "Transcribing your audio…")))
      .toMatchObject({ chat: chatA, typing: true, kind: "thinking", status: "Transcribing your audio…", live: true });
    expect(await listen.waitFor((l) => l.type === "typing.started" && l.kind === "thinking"))
      .toMatchObject({ chat: chatB, kind: "thinking", status: "Transcribing your audio…" });
    // A new kind goes at once, not at the next refresh, and it is a start again on the contact's stream.
    ok(await as(alice, "typing", "bob", "--kind", "recording"));
    const recording = await listen.waitFor((l) => l.type === "typing.started" && l.kind === "recording");
    expect(recording).toMatchObject({ chat: chatB });
    expect(recording).not.toHaveProperty("status");
    ok(await as(alice, "typing", "bob", "--stop"));
    await listen.waitFor((l) => l.type === "typing.stopped");
    // --for keeps the kind and status it was given: past the contact's 6 s it is still thinking, never plain typing.
    // The window ends before the 15 s are up counted from the command, when the daemon's timer starts: counted from
    // when Bob saw the start (over HyperDHT here, 1.7 s later on an idle machine, more on a busy one) it took in the
    // stop that ends it.
    const before = listen.lines.length;
    const asked = Date.now();
    ok(await as(alice, "typing", "bob", "--kind", "thinking", "--status", "Working", "--for", "15"));
    await listen.waitFor((l) => l.type === "typing.started" && l.status === "Working");
    const seen = Date.now();
    await new Promise((r) => setTimeout(r, asked + 13_000 - Date.now()));
    expect(Date.now() - seen, "the window outlasts the contact's 6 s timeout").toBeGreaterThan(6_000);
    expect(listen.lines.slice(before).map((l) => [l.type, l.kind, l.status])).toEqual([["typing.started", "thinking", "Working"]]);
    await listen.waitFor((l) => l.type === "typing.stopped" && listen.lines.indexOf(l) >= before);
    // What the contact's app would not show is refused here.
    const refused = error(await as(alice, "typing", "bob", "--status", "see https://x.example"), "bad_request", 1);
    expect(refused.message).toContain("no link or markup");
    await listen.stop();
  });

  it("hold a chat off its direct link: the contact does not redial, text still goes over the DHT, chat connect ends it", async () => {
    const held = ok(await as(alice, "chat", "disconnect", "bob", "--hold", "1"));
    expect(held.heldUntil).toBeGreaterThan(Date.now());
    await expect.poll(async () => ok(await as(bob, "chat", "show", "alice")).live, { timeout: 30_000 }).toBe(false);
    // Long enough for Bob's daemon to have dialed again if it would.
    await new Promise((r) => setTimeout(r, 10_000));
    expect(ok(await as(bob, "chat", "show", "alice"))).toMatchObject({ live: false });
    expect(ok(await as(alice, "chat", "show", "bob"))).toMatchObject({ live: false, heldUntil: held.heldUntil, deliveryMode: "dht" });
    expect(ok(await as(alice, "send", "bob", "over the dht", "--wait", "sent", "--timeout", "60"))).toMatchObject({ delivery: expect.stringMatching(/^(sent|delivered)$/) });
    ok(await as(alice, "chat", "connect", "bob"));
    expect(ok(await as(alice, "chat", "show", "bob"))).toMatchObject({ heldUntil: null });
    for (const [dir, chat] of [[alice, chatA], [bob, chatB]]) ok(await as(dir, "chat", "wait", chat, "--until", "live", "--timeout", "90"));
    const history = ok(await as(bob, "chat", "history", "alice", "--limit", "5")).messages as { text: string }[];
    expect(history.map((m) => m.text)).toContain("over the dht");
  });

  it("call by voice: auto-answer, audio both ways over the socket and `call pipe`, hang-up events", async () => {
    const listenA = await listenTo(alice, "--type", "call.");
    const listenB = await listenTo(bob, "--type", "call.");
    expect(ok(await as(alice, "status"))).toMatchObject({ calls: true });
    expect(ok(await as(alice, "call", "auto", "on", "--from", "bob", "--rate", "16000"))).toEqual({ autoAnswer: { on: true, from: [chatA], rate: 16000 } });
    const placed = ok(await as(bob, "call", "start", "alice")) as { call: string; audio: { socket: string } };
    expect(placed).toMatchObject({ chat: chatB, direction: "out", state: "ringing", audio: { rate: 48000, channels: 1, format: "s16le", frameMs: 20 } });
    expect(await listenA.waitFor((e) => e.type === "call.incoming")).toMatchObject({ chat: chatA, name: "bob", video: false, auto: true });
    const connected = await listenA.waitFor((e) => e.type === "call.connected");
    expect(connected).toMatchObject({ chat: chatA, direction: "in", audio: { rate: 16000 } });
    await listenB.waitFor((e) => e.type === "call.connected");

    // Bob's program on the socket; Alice's through `call pipe` (stdin to the call, the call to stdout).
    const bobHeard: Buffer[] = [];
    const program = connect(placed.audio.socket);
    program.on("data", (d: Buffer) => bobHeard.push(d));
    const pipe = spawn(process.execPath, [BIN, "--home", alice, "call", "pipe", "bob"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const aliceHeard: Buffer[] = [];
    pipe.stdout.on("data", (d: Buffer) => aliceHeard.push(d));
    await new Promise((r) => setTimeout(r, 500));
    program.write(tone(440, 48000, 2000));
    pipe.stdin.write(tone(660, 16000, 2000));
    await expect.poll(() => Buffer.concat(aliceHeard).length, { timeout: 20_000 }).toBeGreaterThan(640 * 80);
    await expect.poll(() => Buffer.concat(bobHeard).length, { timeout: 20_000 }).toBeGreaterThan(1920 * 80);
    const heardByAlice = Buffer.concat(aliceHeard), heardByBob = Buffer.concat(bobHeard);
    expect(dominantHz(heardByAlice.subarray(heardByAlice.length - 640 * 50), 16000)).toBeCloseTo(440, -1);
    expect(dominantHz(heardByBob.subarray(heardByBob.length - 1920 * 50), 48000)).toBeCloseTo(660, -1);
    expect(ok(await as(bob, "call", "list")).calls).toMatchObject([{ call: placed.call, state: "connected", stats: { programConnected: true } }]);
    expect(ok(await as(bob, "call", "flush"))).toMatchObject({ call: placed.call, flushedMs: expect.any(Number) });

    const pipeClosed = new Promise((r) => pipe.once("exit", r));
    ok(await as(bob, "call", "hangup"));
    expect(await listenA.waitFor((e) => e.type === "call.ended")).toMatchObject({ chat: chatA, reason: "remote-hangup", duration: expect.any(Number) });
    expect(await listenB.waitFor((e) => e.type === "call.ended")).toMatchObject({ chat: chatB, reason: "hangup" });
    await pipeClosed;
    program.destroy();
    error(await as(bob, "call", "hangup"), "not_found", 3);
    ok(await as(alice, "call", "auto", "off"));
    await listenA.stop();
    await listenB.stop();
  });

  it("the call-echo example answers, greets with its WAV, and echoes the caller a second later", async () => {
    const wav = join(alice, "greeting.wav");
    writeFileSync(wav, wavFile(tone(300, 24000, 800), 24000));
    const example = spawn(process.execPath, [join(import.meta.dirname, "../examples/call-echo.mjs"), wav], { env: { ...process.env, GHOSTLY_SOCKET: sockets[alice] }, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    example.stdout.on("data", (d) => (said += d));
    example.stderr.on("data", (d) => (said += d));
    try {
      await new Promise((r) => setTimeout(r, 1000));
      const placed = ok(await as(bob, "call", "start", "alice")) as { call: string; audio: { socket: string } };
      const heard: Buffer[] = [];
      const program = connect(placed.audio.socket);
      program.on("data", (d: Buffer) => heard.push(d));
      await expect.poll(() => said, { timeout: 30_000 }).toContain("connected");
      // The greeting first (the WAV's 300 Hz, resampled to the call's 48 kHz).
      await expect.poll(() => Buffer.concat(heard).length, { timeout: 20_000 }).toBeGreaterThan(1920 * 30);
      const start = Buffer.concat(heard).length;
      program.write(tone(520, 48000, 1500));
      await expect.poll(() => Buffer.concat(heard).length, { timeout: 20_000 }).toBeGreaterThan(start + 1920 * 150);
      const all = Buffer.concat(heard);
      const greetingPart = all.subarray(1920 * 5, 1920 * 30);
      expect(dominantHz(greetingPart, 48000)).toBeCloseTo(300, -1);
      // The echo comes back about a second after the tone went: look where it must be by then.
      expect(dominantHz(all.subarray(start + 1920 * 100, start + 1920 * 140), 48000)).toBeCloseTo(520, -1);
      ok(await as(bob, "call", "hangup"));
      await expect.poll(() => said, { timeout: 20_000 }).toContain("ended: remote-hangup");
      program.destroy();
    } finally {
      example.kill();
    }
  });

  it("react to a message: the contact's stream says it, its history shows it, a new one replaces it, --remove takes it back", async () => {
    const listen = await listenTo(bob, "--type", "message.reaction");
    const theirs = (ok(await as(alice, "chat", "history", "bob")).messages as { id: string; text: string }[]).find((m) => m.text === "done typing")!;
    expect(ok(await as(alice, "react", "bob", theirs.id, "👍"))).toMatchObject({ chat: chatA, messageId: theirs.id, emoji: "👍", removed: false });
    const event = await listen.waitFor((l) => l.type === "message.reaction");
    // Alice's own message: on Bob's side it is the contact's, reacted to by the contact.
    expect(event).toMatchObject({ chat: chatB, by: "peer", emoji: "👍", removed: false, mine: false });
    const shown = async () => (ok(await as(bob, "chat", "history", "alice")).messages as { id: string; text: string; reactions?: { by: string; emoji: string }[] }[]).find((m) => m.text === "done typing")!;
    expect((await shown()).reactions).toMatchObject([{ by: "peer", emoji: "👍" }]);
    ok(await as(alice, "react", "bob", theirs.id, "❤"));
    await listen.waitFor((l) => l.type === "message.reaction" && l.emoji === "❤️");
    ok(await as(alice, "react", "bob", theirs.id, "--remove"));
    await listen.waitFor((l) => l.type === "message.reaction" && l.removed === true);
    expect((await shown()).reactions).toBeUndefined();
    error(await as(alice, "react", "bob", theirs.id, "not an emoji"), "bad_request", 1);
    error(await as(alice, "react", "bob", "no-such-message", "👍"), "not_found", 3);
    await listen.stop();
  });

  it("update a status in place: send it, edit it three times, the contact sees the last text and each edit once", async () => {
    const listen = await listenTo(bob, "--type", "message.edited");
    const id = ok(await as(alice, "send", "bob", "Working: 0 of 3", "--wait", "delivered")).messageId as string;
    expect(ok(await as(alice, "edit", "bob", id, "Working: 1 of 3", "--wait", "confirmed"))).toMatchObject({ chat: chatA, messageId: id, confirmed: true });
    expect(ok(await as(alice, "edit", "bob", id, "--text", "Working: 2 of 3", "--wait", "confirmed"))).toMatchObject({ edits: 2, confirmed: true });
    // From stdin, as a bot pipes it.
    expect(ok(await ghostly(["--home", alice, "edit", "bob", id, "--stdin", "--wait", "confirmed"], { env, input: "Done: 3 of 3\n" }))).toMatchObject({ edits: 3, confirmed: true });
    await expect.poll(() => listen.lines.length, { timeout: 30_000 }).toBe(3);
    expect(listen.lines.map((l) => [l.chat, l.edits, (l.message as { text: string }).text]))
      .toEqual([[chatB, 1, "Working: 1 of 3"], [chatB, 2, "Working: 2 of 3"], [chatB, 3, "Done: 3 of 3"]]);
    const last = (ok(await as(bob, "chat", "history", "alice")).messages as { text: string; edits?: number; editedAt?: number }[]).at(-1)!;
    expect(last).toMatchObject({ text: "Done: 3 of 3", edits: 3 });
    expect(last.editedAt).toBeGreaterThan(0);
    error(await as(alice, "edit", "bob", "nope", "anything"), "refused", 1);
    error(await as(alice, "edit", "bob", id), "usage", 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(listen.lines).toHaveLength(3);
    await listen.stop();
  });

  it("send files: a small one taken at once, a large one only once accepted, saved byte for byte", async () => {
    const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const listen = await listenTo(bob, "--type", "file.", "--type", "message.received");
    const small = join(alice, "note.txt");
    writeFileSync(small, randomBytes(200_000));
    const sent = ok(await as(alice, "file", "send", "bob", small));
    const fileMessage = await listen.waitFor((e) => e.type === "message.received" && !!(e.message as { file?: unknown }).file);
    const incoming = (fileMessage.message as { file: { id: string; name: string; size: number } }).file;
    expect(incoming).toMatchObject({ name: "note.txt", size: 200_000 });
    // The file's events name its message and chat; file wait answers once it is all here.
    expect(await listen.waitFor((e) => e.type === "file.done" && e.file === incoming.id)).toMatchObject({ chat: chatB, messageId: (fileMessage.message as { id: string }).id });
    expect(ok(await as(bob, "file", "wait", incoming.id, "--timeout", "30"))).toMatchObject({ chat: chatB, file: incoming.id, state: "done", size: 200_000 });
    const saved = ok(await as(bob, "file", "save", incoming.id, "--dir", bob));
    expect(sha(saved.path as string)).toBe(sha(small));
    error(await as(bob, "file", "save", incoming.id, "--dir", bob), "confirm", 5);
    expect((sent.file as { size: number }).size).toBe(200_000);
    // Sending again or asking again: by the file's id alone, each only on its own side, and not for a file that arrived.
    expect(error(await as(alice, "file", "resend", (sent.file as { id: string }).id), "refused", 1).message).toBe("Nothing to send again: it arrived whole");
    expect(error(await as(bob, "file", "request", incoming.id), "refused", 1).message).toBe("Nothing to ask for: the file is all here");
    error(await as(bob, "file", "resend", incoming.id), "bad_request", 1);
    error(await as(bob, "file", "request", "nochat-in-nothing"), "not_found", 3);

    const large = join(alice, "big.bin");
    writeFileSync(large, randomBytes(26 * 1024 * 1024));
    ok(await as(alice, "file", "send", "bob", large));
    const offer = await listen.waitFor((e) => e.type === "file.offered", 90_000);
    // By the file's id alone (the two-argument form above still works), then saved as soon as it is all here.
    expect(offer).toMatchObject({ chat: chatB, messageId: expect.stringMatching(/^peer_/) });
    ok(await as(bob, "file", "accept", offer.file as string));
    const savedLarge = ok(await as(bob, "file", "save", offer.file as string, "--path", join(bob, "big-copy.bin"), "--wait", "--timeout", "120"));
    expect(savedLarge.size).toBe(26 * 1024 * 1024);
    expect(sha(join(bob, "big-copy.bin"))).toBe(sha(large));
    await listen.stop();
  });

  it("send a voice note from a file: its length and waveform measured here, the contact sees the bars", async () => {
    const listen = await listenTo(bob, "--type", "message.received");
    const recording = join(import.meta.dirname, "../../../e2e/support/voice-fixtures/chromium.webm");
    const sent = await as(alice, "file", "send", "bob", recording, "--voice");
    expect(ok(sent)).toMatchObject({ file: { mime: "audio/webm", voice: true } });
    expect(sent.stderr).not.toMatch(/Sent without a waveform/);
    const message = await listen.waitFor((e) => e.type === "message.received" && !!(e.message as { file?: { voice?: unknown } }).file?.voice);
    const id = (message.message as { file: { id: string } }).file.id;
    // The event says it all: the length and the bars, beside the file's id.
    const onEvent = (message.message as { file: { voice: { duration: number; peaks: number[] } } }).file.voice;
    expect(onEvent.duration).toBeGreaterThan(1400);
    expect(onEvent.peaks).toHaveLength(64);
    const listed = (ok(await as(bob, "file", "list", "alice")).files as { file: { id: string; voice?: { duration: number; peaks: number[] } } }[]).find((f) => f.file.id === id);
    const voice = listed!.file.voice!;
    expect(voice.peaks).toHaveLength(64);
    expect(Math.max(...voice.peaks)).toBe(255);
    expect(Math.min(...voice.peaks)).toBeLessThan(128);
    expect(voice.duration).toBeGreaterThan(1400);
    expect(voice.duration).toBeLessThan(1800);
    await listen.stop();
    // Bob answers it with a voice note that quotes it (WISP 401 § Replies on a file): Alice's copy finds the original.
    const messageId = (message.message as { id: string }).id;
    error(await as(bob, "file", "send", "alice", recording, "--voice", "--reply", "peer_nothing"), "not_found", 3);
    ok(await as(bob, "file", "send", "alice", recording, "--voice", "--reply", messageId));
    type Row = { file?: { voice?: boolean }; replyTo?: { found: boolean; from: string | null }; from?: string; sender?: string };
    let answer: Row | undefined;
    await expect.poll(async () => {
      const rows = ok(await as(alice, "chat", "history", "bob", "--limit", "10")).messages as Row[];
      answer = rows.find((m) => m.file?.voice && m.replyTo);
      return answer?.replyTo?.found;
    }, { timeout: 60_000 }).toBe(true);
    expect(answer!.replyTo!.from).toBe("me");
    // Sound this side cannot read: sent flat with a warning on stderr when the length is given, refused when not.
    const noise = join(alice, "noise.wav");
    writeFileSync(noise, randomBytes(4000));
    const flat = await as(alice, "file", "send", "bob", noise, "--voice", "1200");
    expect(ok(flat)).toMatchObject({ file: { voice: true } });
    expect(flat.json.warning).toBeUndefined();
    expect(flat.stderr).toMatch(/^ghostly: Sent without a waveform: could not read the sound/m);
    expect(error(await as(alice, "file", "send", "bob", noise, "--voice"), "bad_request", 1).message).toMatch(/give its length as --voice <ms>/);
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

    const listen = await listenTo(bob, "--type", "identity.");
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
      // As a browser: the link's host name (`<random>.localhost`, which Node's resolver may not know), its cookie, then the page.
      const link = new URL(opened.url as string);
      expect(link.hostname).toMatch(/^[0-9a-f]{32}\.localhost$/);
      const visit = (path: string, cookie?: string) => new Promise<{ status: number; cookie: string; body: string }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: Number(link.port), path, headers: { host: link.host, ...(cookie ? { cookie } : {}) } }, (res) => {
          const parts: Buffer[] = [];
          res.on("data", (c: Buffer) => parts.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers["set-cookie"] ?? "").split(";")[0], body: Buffer.concat(parts).toString() }));
        });
        req.on("error", reject);
        req.end();
      });
      expect((await visit("/docs?x=1")).status).toBe(404);
      const first = await visit(link.pathname);
      expect(first.status).toBe(303);
      const page = await visit("/docs?x=1", first.cookie);
      expect(page.status).toBe(200);
      expect(page.body).toBe("hello from /docs?x=1");
      ok(await as(bob, "service", "close", "alice", service));
      ok(await as(alice, "service", "share", service, "bob", "--off"));
    } finally { app.close(); }
  });

  it("answer from a hook: an echo bot on listen --exec", async () => {
    const script = join(bob, "echo.mjs");
    writeFileSync(script, `
      import { execFileSync, spawn } from "node:child_process";
      let input = ""; for await (const c of process.stdin) input += c;
      const event = JSON.parse(input);
      execFileSync(process.execPath, [${JSON.stringify(join(import.meta.dirname, "../dist/ghostly.mjs"))}, "--home", ${JSON.stringify(bob)}, "send", event.chat, "--", "echo: " + event.message.text]);
    `);
    const bot = await listenTo(bob, "--type", "message.received", "--exec", `"${process.execPath}" "${script}"`, "--cursor", join(bob, "cursor"));
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
    // The entry link lets anyone join: printed only when asked for.
    expect(ok(await as(alice, "group", "show", "Bot crew"))).toMatchObject({ link: "<hidden>" });
    expect(ok(await as(alice, "group", "show", "Bot crew", "--show-secret"))).toMatchObject({ link: created.link });
    expect(JSON.stringify(ok(await as(alice, "group", "list")))).not.toContain(created.link as string);
    // Bob's roster names Alice before the message comes, so the stream can name her (the message has her key only).
    await waitForMember(bob, "Bot crew", "Alice bot");
    const listen = await listenTo(bob, "--type", "group.");
    const sent = ok(await as(alice, "group", "send", "Bot crew", "hey @Bob", "--mention", "Bob"));
    expect(sent).toMatchObject({ group: created.group, messageId: expect.any(String), sent: true });
    const event = await listen.waitFor((l) => l.type === "group.message", 60_000);
    expect(event).toMatchObject({ group: joined.group, message: { id: sent.messageId, text: "hey @Bob", mentioned: true, nick: "Alice bot", member: expect.any(String) } });

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

  it("forward a text and a file on: each a new message that says it was forwarded, the file from the bytes here, byte for byte", async () => {
    const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const listen = await listenTo(alice, "--type", "message.received", "--type", "file.done");
    const text = ok(await as(bob, "send", "alice", "pass **this** on", "--wait", "delivered")).messageId as string;
    const picture = join(bob, "ghost.png");
    writeFileSync(picture, randomBytes(120_000));
    ok(await as(bob, "file", "send", "alice", picture));
    const got = await listen.waitFor((e) => e.type === "message.received" && !!(e.message as { file?: unknown }).file);
    const fileMessage = got.message as { id: string; file: { id: string } };
    await listen.waitFor((e) => e.type === "file.done" && e.file === fileMessage.file.id);
    await listen.stop();
    const theirs = (ok(await as(alice, "chat", "history", "bob", "--limit", "20")).messages as { id: string; text: string; from: string }[]).find((m) => m.text === "pass **this** on" && m.from === "peer")!;
    expect(theirs).toBeTruthy();
    expect(text).toMatch(/^me_/);

    // Back into the chat: Bob's side reads two messages of Alice's, forwarded once, the Markdown source kept.
    const watch = await listenTo(bob, "--type", "message.received", "--type", "file.done");
    const forwarded = ok(await as(alice, "forward", "bob", theirs.id, fileMessage.id, "--to", "bob", "--wait", "sent"));
    expect(forwarded).toMatchObject({ from: chatA, results: [{ to: chatA, kind: "chat", messageIds: [expect.any(String), expect.any(String)], error: null }] });
    const again = await watch.waitFor((e) => e.type === "message.received" && !!(e.message as { file?: unknown }).file, 60_000);
    const copy = again.message as { id: string; forwarded?: number; file: { id: string; name: string } };
    expect(copy).toMatchObject({ forwarded: 1, file: { name: "ghost.png" } });
    await watch.waitFor((e) => e.type === "file.done" && e.file === copy.file.id, 60_000);
    await watch.stop();
    const rows = ok(await as(bob, "chat", "history", "alice", "--limit", "5")).messages as { text: string; from: string; forwarded?: number }[];
    expect(rows.find((m) => m.from === "peer" && m.text === "pass **this** on")).toMatchObject({ forwarded: 1 });
    const saved = ok(await as(bob, "file", "save", copy.file.id, "--path", join(bob, "ghost-forwarded.png")));
    expect(sha(saved.path as string)).toBe(sha(picture));

    // Into the group: the text goes, a file is refused (groups take texts only), a message not in the chat is not found.
    const inGroup = await listenTo(bob, "--type", "group.message");
    const toGroup = ok(await as(alice, "forward", "bob", theirs.id, "--to", "Bot crew", "--wait", "sent"));
    expect(toGroup).toMatchObject({ results: [{ kind: "group", error: null }] });
    // By its text: a message said in the group just before may still be arriving.
    expect(await inGroup.waitFor((e) => e.type === "group.message" && (e.message as { text?: string }).text === "pass **this** on", 60_000)).toMatchObject({ message: { forwarded: 1 } });
    await inGroup.stop();
    expect(error(await as(alice, "forward", "bob", fileMessage.id, "--to", "Bot crew"), "refused", 1).message).toMatch(/Groups take no files yet/);
    error(await as(alice, "forward", "bob", "no-such-message", "--to", "bob"), "not_found", 3);
    error(await as(alice, "forward", "bob", theirs.id), "bad_request", 1);
  });

  it("talk in a private mesh group: the stream names the sender, and a reply names the id group send gave", async () => {
    ok(await as(alice, "group", "create", "Mesh crew", "--mesh"));
    ok(await as(alice, "group", "invite", "Mesh crew", "bob"));
    const invited = Date.now() + 60_000;
    let groups: { name: string; status: string | null }[] = [];
    while (Date.now() < invited) {
      groups = ok(await as(bob, "group", "list")).groups as typeof groups;
      if (groups.some((g) => g.name === "Mesh crew")) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(groups.find((g) => g.name === "Mesh crew"), JSON.stringify(groups)).toMatchObject({ status: "invited" });
    ok(await as(bob, "group", "accept", "Mesh crew"));
    await waitForMember(alice, "Mesh crew", "Bob");
    await waitForMember(bob, "Mesh crew", "Alice bot");
    const listen = await listenTo(bob, "--type", "group.message");
    const sent = ok(await as(alice, "group", "send", "Mesh crew", "status: building"));
    expect(sent.messageId).toEqual(expect.any(String));
    const event = await listen.waitFor((l) => (l.message as { text?: string } | undefined)?.text === "status: building", 90_000).catch(async (error: Error) => {
      // Which half failed: the message never reached Bob, or it did and the stream did not say so.
      throw new Error(`${error.message}\nBob's history: ${JSON.stringify(ok(await as(bob, "group", "history", "Mesh crew"))).slice(0, 2000)}`);
    });
    const aliceKey = (ok(await as(alice, "group", "show", "Mesh crew")).me as string);
    expect(event.message).toMatchObject({ id: sent.messageId, member: aliceKey, nick: "Alice bot" });
    const history = ok(await as(bob, "group", "history", "Mesh crew")).messages as { id: string; nick: string | null; member?: string }[];
    expect(history.find((m) => m.id === sent.messageId)).toMatchObject({ nick: "Alice bot", member: aliceKey });
    // The id is what a reply names.
    ok(await as(bob, "group", "send", "Mesh crew", "nice", "--reply", sent.messageId as string));
    const replied = Date.now() + 90_000;
    type Line = { text: string; replyTo?: { id: string; found: boolean } };
    let reply: Line | undefined;
    while (Date.now() < replied && !reply) {
      reply = (ok(await as(alice, "group", "history", "Mesh crew")).messages as Line[]).find((m) => m.text === "nice");
      if (!reply) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(reply).toMatchObject({ replyTo: { id: sent.messageId, found: true } });
    await listen.stop();
  });

  it("update a group status in place: group send, group edit three times, the other member sees the last text and each edit once", async () => {
    const listen = await listenTo(bob, "--type", "group.message.edited");
    // --wait sent: back once Bob's edge took it (a group has no receipts).
    const sent = ok(await as(alice, "group", "send", "Mesh crew", "Deploy: 0 of 3", "--wait", "sent"));
    expect(sent.edges).toBeGreaterThanOrEqual(1);
    const id = sent.messageId as string;
    const shown = Date.now() + 90_000;
    while (Date.now() < shown && !(ok(await as(bob, "group", "history", "Mesh crew")).messages as { id: string }[]).some((m) => m.id === id)) await new Promise((r) => setTimeout(r, 1000));
    const first = ok(await as(alice, "group", "edit", "Mesh crew", id, "Deploy: 1 of 3", "--wait", "sent"));
    expect(first).toMatchObject({ messageId: id, edits: 1, sent: true });
    expect(first.edges).toBeGreaterThanOrEqual(1);
    expect(ok(await as(alice, "group", "edit", "Mesh crew", id, "--text", "Deploy: 2 of 3"))).toMatchObject({ edits: 2 });
    // From stdin, as a bot pipes it.
    expect(ok(await ghostly(["--home", alice, "group", "edit", "Mesh crew", id, "--stdin"], { env, input: "Deploy: done\n" }))).toMatchObject({ edits: 3 });
    const last = async () => (ok(await as(bob, "group", "history", "Mesh crew")).messages as { id: string; text: string; edits?: number }[]).find((m) => m.id === id);
    await expect.poll(async () => (await last())?.text, { timeout: 60_000 }).toBe("Deploy: done");
    expect(await last()).toMatchObject({ edits: 3 });
    // One event per edit Bob's side took, the last one with the final text; never a second message.
    await expect.poll(() => listen.lines.at(-1)?.edits, { timeout: 30_000 }).toBe(3);
    expect(listen.lines.every((l) => l.messageId === id)).toBe(true);
    expect((listen.lines.at(-1)!.message as { text: string }).text).toBe("Deploy: done");
    expect(new Set(listen.lines.map((l) => l.edits)).size).toBe(listen.lines.length);
    expect((ok(await as(bob, "group", "history", "Mesh crew")).messages as { text: string }[]).filter((m) => m.text.startsWith("Deploy"))).toHaveLength(1);
    // Only mine: Bob cannot edit Alice's message.
    error(await as(bob, "group", "edit", "Mesh crew", id, "mine now"), "refused", 1);
    await listen.stop();
  });

  it("send as a one-shot while the other side's daemon runs, and stop cleanly", async () => {
    const daemonA = running[0];
    ok(await as(alice, "daemon", "stop"));
    expect(await daemonA.exited()).toBe(0);
    expect(ok(await as(alice, "daemon", "status"))).toMatchObject({ running: false });
    expect((ok(await as(alice, "group", "list")).groups as unknown[]).length).toBeGreaterThanOrEqual(2);
    // A fresh process, in the two groups above: a one-shot for a chat leaves their sessions unstarted.
    // With them, their edges spent the relays' requests of the minute in seconds and the message waited for the next
    // minute (about 65 s on CI); without, it goes out in about 3 s. On this loopback testnet the fresh process's first
    // HyperDHT dial to Bob can hang until UDX gives up (13 s, twice at worst) before a later dial carries it: about 15 s
    // in 4 CI runs of 10. 40 s stays well under the minute's wait, and the timeout ends that wait sooner still.
    const started = Date.now();
    expect(ok(await as(alice, "send", "bob", "from a one-shot", "--wait", "delivered", "--timeout", "50"))).toMatchObject({ delivery: "delivered" });
    expect(Date.now() - started).toBeLessThan(40_000);
    const history = ok(await as(bob, "chat", "history", "alice", "--limit", "1")).messages as { text: string }[];
    expect(history.map((m) => m.text)).toEqual(["from a one-shot"]);
  });
});
