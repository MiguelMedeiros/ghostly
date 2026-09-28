import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { desktopPerson, type DesktopPerson } from "../matrix/people";
import { HYPERDHT_TESTNET } from "../matrix/desktop";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";
import { HeadlessBot } from "../support/headless";
import { LocalRelay } from "../support/relay";

/**
 * A measurement (WISP 9xx · Group Mesh § Hubs, Budget): the Desktop app on a Mac opens only so many `RTCPeerConnection`s
 * at once in its page, about 46 to 49 (#402). What happens to a 1:1 chat and a call while it sits there?
 *
 * The app pairs a 1:1 chat with a headless bot, then its page is filled with loopback edges (two connections each,
 * connected to each other, one data channel: what a group edge is) until one more does not open. At that ceiling the
 * app calls the bot (the bot answers by itself), and pairs a second, fresh 1:1 chat. Each is timed, and whether it
 * connected is recorded. Then the page goes down to 40 connections (the most a Mac gives its groups, `peerBudget`), and
 * the app calls again.
 *
 * What only this proves: WebKit's ceiling, and what it does to the app's own connections. The engine's rule (a Mac
 * over its budget is a hub only while no other member can be) is proven headless (packages/browser/test/meshHubs.test.ts).
 *
 *   npm run desktop:macos:build
 *   E2E_CONNECTION_CEILING=1 npx playwright test -c e2e/playwright.desktop-macos.config.ts connection-ceiling
 */

// 49760-49769: this test's ports.
const PORTS = { relay: 49761, dht: 49762, a: 49765 };
/** How long one loopback edge may take before the page counts as full. */
const EDGE_WAIT_MS = Number(process.env.E2E_CEILING_EDGE_MS ?? 30_000);
/** How long a chat and a call may take at the ceiling. */
const PAIR_MS = Number(process.env.E2E_CEILING_PAIR_MS ?? 180_000);
const CALL_MS = Number(process.env.E2E_CEILING_CALL_MS ?? 90_000);
/** The connections in the page for the last call: the budget a Mac gives its groups. */
const HEADROOM_AT = 40;

/**
 * Every connection the page makes is kept (`__peers`), the microphone is a tone (WKWebView has no fake devices), and
 * the native constructor stays reachable for the loopback edges. Idempotent.
 */
const HOOKS = `
  if (window.__peers) return;
  window.__peers = [];
  const Native = window.RTCPeerConnection;
  window.__nativePeer = Native;
  window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.__peers.push(this); } };
  const context = new AudioContext();
  MediaDevices.prototype.getUserMedia = async () => {
    void context.resume();
    const tone = context.createOscillator();
    tone.frequency.value = 440;
    const out = context.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    return new MediaStream(out.stream.getAudioTracks());
  };
`;
/** The page's connections by state: the app's own (`app`), and the loopback edges' (`loop`, two per edge). */
const PEERS = `
  const count = (list) => { const states = {}; for (const pc of list) states[pc.connectionState] = (states[pc.connectionState] ?? 0) + 1; return states; };
  const loop = (window.__loop ?? []).flatMap((e) => [e.a, e.b]);
  return { app: count(window.__peers ?? []), loop: count(loop), loopEdges: (window.__loop ?? []).length, singles: (window.__single ?? []).length };
`;
/** The app's own connections that are not closed. */
const APP_OPEN = `return (window.__peers ?? []).filter((pc) => pc.connectionState !== "closed").length;`;
/** The app's newest connection: what it gathered, and how far it got. */
const NEWEST = `
  const pc = (window.__peers ?? []).at(-1);
  if (!pc) return null;
  const sdp = pc.localDescription?.sdp ?? "";
  return { connection: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, localCandidates: (sdp.match(/a=candidate/g) ?? []).length };
`;

/**
 * Loopback edges, one after another, until `arguments[0]` are up or one does not open within `arguments[1]` ms: that
 * one's two connections are closed, and how many are up is the answer.
 */
const FILL = `
  const done = arguments[arguments.length - 1];
  const [most, wait] = arguments;
  const Peer = window.__nativePeer ?? window.RTCPeerConnection;
  window.__loop ??= [];
  (async () => {
    while (window.__loop.length < most) {
      const a = new Peer(), b = new Peer();
      a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
      b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
      const channel = a.createDataChannel("edge");
      const far = new Promise((resolve) => { b.ondatachannel = (event) => { event.channel.onmessage = () => {}; resolve(); }; });
      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer());
      await a.setRemoteDescription(b.localDescription);
      const open = await Promise.race([
        Promise.all([far, new Promise((resolve) => { if (channel.readyState === "open") resolve(); else channel.onopen = resolve; })]).then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), wait)),
      ]);
      if (!open) { a.close(); b.close(); break; }
      window.__loop.push({ a, b, channel });
    }
    return window.__loop.length;
  })().then(done, (error) => done(String(error)));
`;
/** Loopback edges that are not up any more are closed and forgotten. */
const PRUNE = `window.__loop = (window.__loop ?? []).filter((e) => { const up = e.a.connectionState === "connected" && e.b.connectionState === "connected"; if (!up) { e.a.close(); e.b.close(); } return up; }); return window.__loop.length;`;
/**
 * Single connections that only gather their candidates (a loopback edge needs two at once, so the page may take one
 * more): added until one gathers none within `arguments[1]` ms, at most `arguments[0]`. That one is closed; the page
 * is then at its ceiling, where the next connection is the one that gathered nothing.
 */
const GATHER = `
  const done = arguments[arguments.length - 1];
  const [most, wait] = arguments;
  const Peer = window.__nativePeer ?? window.RTCPeerConnection;
  window.__single ??= [];
  (async () => {
    let added = 0;
    while (added < most) {
      const pc = new Peer();
      pc.createDataChannel("gather");
      let candidates = 0;
      pc.onicecandidate = (e) => { if (e.candidate) candidates++; };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((resolve) => { const stop = setTimeout(resolve, wait); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(stop); resolve(); } }; });
      if (!candidates) { pc.close(); break; }
      window.__single.push(pc);
      added++;
    }
    return window.__single.length;
  })().then(done, (error) => done(String(error)));
`;
const CLOSE_ALL = `for (const e of window.__loop ?? []) { e.a.close(); e.b.close(); } for (const pc of window.__single ?? []) pc.close(); window.__loop = []; window.__single = []; return true;`;
/** The singles, closed: room for exactly one more connection than the ceiling left. */
const CLOSE_SINGLES = `for (const pc of window.__single ?? []) pc.close(); window.__single = []; return true;`;

test("at WKWebView's connection ceiling: does a call connect, and a fresh 1:1 chat?", {
  tag: ["@client:desktop", "@feature:calls.paired", "@feature:groups.hubs.budget", "@gated"],
}, async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS only: the system WKWebView");
  test.skip(!process.env.E2E_CONNECTION_CEILING, "A measurement: E2E_CONNECTION_CEILING=1");
  test.setTimeout(30 * 60_000);
  const relay = new LocalRelay();
  const { default: testnet } = (await import(HYPERDHT_TESTNET)) as { default: (size: number, opts?: { port?: number }) => Promise<{ bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }> };
  const dht = await testnet(3, { port: PORTS.dht });
  const relayUrl = await relay.listen(PORTS.relay);
  const bootstrap = dht.bootstrap.map((node) => `${node.host}:${node.port}`).join(",");
  const env = { GHOSTLY_PKARR_RELAYS: relayUrl, GHOSTLY_HYPERDHT_BOOTSTRAP: bootstrap };
  process.env.GHOSTLY_HYPERDHT_BOOTSTRAP = bootstrap;
  const bot = new HeadlessBot();
  const apps: MacDesktop[] = [];
  let mac: DesktopPerson | undefined;
  const report: Record<string, unknown> = {};
  const save = () => writeFileSync(testInfo.outputPath("ceiling.json"), JSON.stringify(report, null, 2));
  forgetSharedData();
  try {
    await bot.start(relayUrl, "Bot");
    await bot.run("call", "auto", "on");
    mac = await desktopPerson("a", {
      env,
      open: async () => {
        const desktop = await openMacDesktop({ name: "a", port: PORTS.a, env });
        apps.push(desktop);
        return { app: desktop.app, stop: () => desktop.stop() };
      },
    });
    const app = mac;
    await app.app.execute(HOOKS);
    const peers = () => app.app.execute<Record<string, unknown>>(PEERS);
    const newest = () => app.app.execute<Record<string, unknown> | null>(NEWEST);

    /**
     * Loopback edges until `most` are up or one more does not open, a few at a time (the driver waits 120 s at most for
     * a script); then, to the ceiling, single connections until one gathers no candidate.
     */
    const fill = async (most = 40, ceiling = true) => {
      await app.app.execute(PRUNE);
      await app.app.execute(CLOSE_SINGLES);
      const started = Date.now();
      let edges: number | string = 0;
      for (const step of [...[8, 16, 20, 24, 28, 32].filter((n) => n < most), most]) {
        edges = await app.app.executeAsync<number | string>(FILL, step, EDGE_WAIT_MS);
        if (typeof edges !== "number" || edges < step) break;
      }
      expect(typeof edges, `the fill: ${edges}`).toBe("number");
      const singles = ceiling ? await app.app.executeAsync<number | string>(GATHER, 12, 15_000) : 0;
      return { edges: edges as number, singles, appOwn: await app.app.execute<number>(APP_OPEN), seconds: Math.round((Date.now() - started) / 1000), peers: await peers() };
    };
    /** A fresh 1:1 chat with the bot: whether it goes live within `PAIR_MS`, how long, over what. */
    const pair = async (label: string) => {
      const invite = await bot.run("invite", "create", "--label", label);
      const started = Date.now();
      await app.join(invite.link as string);
      const live = await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", String(Math.round(PAIR_MS / 1000))).then(() => true, () => false);
      return { chat: invite.chat as string, hash: await app.hash(), live, seconds: Math.round((Date.now() - started) / 1000), transport: await app.connection().catch(() => null), newest: await newest(), peers: await peers() };
    };
    /** A call from the app to the bot: whether the bot's side connects within `CALL_MS`, how long, and what the page's connections did. */
    const call = async () => {
      await expect.poll(() => app.callButton(), { timeout: 60_000, message: "the app may call the bot" }).toMatchObject({ disabled: false });
      const seen = bot.events.length;
      const started = Date.now();
      await app.app.click('[data-testid="call-audio"]');
      const connected = await bot.event((e) => bot.events.indexOf(e) >= seen && e.type === "call.connected", CALL_MS).then(() => true, () => false);
      const result: Record<string, unknown> = { connected, seconds: Math.round((Date.now() - started) / 1000), callPeer: await newest(), peers: await peers() };
      await app.press("End call").catch(() => {});
      await bot.run("call", "hangup").catch(() => {});
      await expect.poll(() => app.app.text('[title="End call"]'), { timeout: 30_000 }).toBeNull().catch(() => {});
      // What the other connections did after the call ended.
      await new Promise((r) => setTimeout(r, 15_000));
      result.peersAfter = await peers();
      return result;
    };

    let first: Awaited<ReturnType<typeof pair>> | undefined;
    await test.step("a 1:1 chat with the bot, the page empty", async () => {
      first = await pair("first");
      report.firstChat = first;
      save();
      expect(first.live, "the first chat goes live").toBe(true);
    });
    await test.step("fill the page with loopback edges until one more does not open", async () => {
      report.fill = await fill();
      save();
    });
    await test.step("at the ceiling: the app calls the bot", async () => {
      report.callAtCeiling = await call();
      save();
    });
    await test.step("at the ceiling: a fresh 1:1 chat", async () => {
      report.refill = await fill();
      report.chatAtCeiling = await pair("second");
      save();
    });
    await test.step(`with ${HEADROOM_AT} connections in the page: the app calls the bot again`, async () => {
      await app.app.execute(CLOSE_ALL);
      await new Promise((r) => setTimeout(r, 10_000));
      const own = await app.app.execute<number>(APP_OPEN);
      report.headroom = await fill(Math.max(1, Math.floor((HEADROOM_AT - own) / 2)), false);
      await app.go(first!.hash);
      await bot.run("chat", "wait", first!.chat, "--until", "live", "--timeout", "120").catch(() => {});
      report.callWithHeadroom = await call();
      save();
    });
    console.log(`CONNECTION_CEILING ${JSON.stringify(report)}`);
    await testInfo.attach("ceiling.json", { path: testInfo.outputPath("ceiling.json"), contentType: "application/json" });
  } catch (error) {
    if (mac) writeFileSync(testInfo.outputPath("app.txt"), `${await mac.snapshot().catch((e: unknown) => String(e))}\n\n${apps.map((d) => d.log.join("")).join("\n")}`);
    writeFileSync(testInfo.outputPath("bot-events.txt"), bot.events.map((e) => JSON.stringify(e)).join("\n"));
    throw error;
  } finally {
    save();
    await mac?.app.execute(CLOSE_ALL).catch(() => {});
    await Promise.all(apps.map((d) => d.stop().catch(() => {})));
    await bot.stop().catch(() => {});
    forgetSharedData();
    relay.close();
    await dht.destroy().catch(() => {});
  }
});
