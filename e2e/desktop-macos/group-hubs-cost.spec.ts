import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { desktopPerson, type DesktopPerson } from "../matrix/people";
import { HYPERDHT_TESTNET } from "../matrix/desktop";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";
import { HeadlessBot } from "../support/headless";
import { LocalRelay } from "../support/relay";

/**
 * A measurement, not a check (WISP 902 · Group Mesh § Cost per member): what a private group of 32 costs the Desktop
 * app on a Mac, the system WKWebView, where each edge is an `RTCPeerConnection` with one data channel. One app and
 * `E2E_MESH_COST_N - 1` headless bots (31 by default; packages/cli, `GHOSTLY_HUB=0`, so the app, which stays online,
 * is the only hub unless the admin decides otherwise) on a local relay. Three states of the same group, each measured
 * idle and then while the bots post:
 *
 *   1. the app the only hub: an edge with every member (what a member of a full mesh keeps) and every message passed on;
 *   2. the app a plain member: two bots pinned as hubs and the app excluded, so it keeps two edges;
 *   3. a full mesh: the bots unpinned, nobody a hub. Every pair must connect through the relay, which takes long with
 *      32 apps on one machine: measured at whatever the app reached within `E2E_MESH_COST_MESH_MS` (10 minutes), and said.
 *
 * What is measured: the resident memory and CPU of the app's own process and of the WebKit processes that appeared
 * with it (its web content, networking and GPU processes; WebRTC's sockets live in the networking one), sampled with
 * `ps`, CPU as CPU time over wall time. Run it (macOS only, about 30 minutes):
 *
 *   npm run desktop:macos:build
 *   E2E_MESH_COST=1 npx playwright test -c e2e/playwright.desktop-macos.config.ts group-hubs-cost
 */

// 49740-49749: this test's ports.
const PORTS = { relay: 49741, dht: 49742, a: 49745 };
const N = Number(process.env.E2E_MESH_COST_N ?? 32);
/** How long the app may take to hold its edges in each state. */
const SETTLE_MS = Number(process.env.E2E_MESH_COST_SETTLE_MS ?? 20 * 60_000);
const IDLE_MS = Number(process.env.E2E_MESH_COST_IDLE_MS ?? 120_000);
/** Loopback edges made in the page: a group of 32's, whatever the size of the real group below. */
const LOOP_EDGES = Number(process.env.E2E_MESH_COST_LOOPBACK ?? 31);
const BUSY_MS = Number(process.env.E2E_MESH_COST_BUSY_MS ?? 60_000);

/** Every peer connection the page makes, kept, so the test can count the edges that are up. Idempotent. */
const COUNT_PEERS = `
  if (window.__meshPeers) return;
  window.__meshPeers = [];
  const Native = window.RTCPeerConnection;
  window.__nativePeer = Native;
  window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.__meshPeers.push(this); } };
`;
const CONNECTED = `return (window.__meshPeers ?? []).filter((pc) => pc.connectionState === "connected").length;`;
/** What the page's peer connections are doing, and whether the counter is still there (a reload would drop it). */
const PEERS = `
  const all = window.__meshPeers;
  const states = {};
  for (const pc of all ?? []) states[pc.connectionState] = (states[pc.connectionState] ?? 0) + 1;
  return { counting: !!all, made: all?.length ?? 0, states, href: location.href };
`;

/**
 * `arguments[0]` edges made in the page itself: two peer connections each, connected to each other over loopback, with
 * one data channel, as an edge is. What WKWebView pays per edge without a network or peers in the way (both ends are
 * here, so it counts two connections per edge: an upper bound).
 */
const LOOPBACK = `
  const done = arguments[arguments.length - 1];
  const n = arguments[0], wait = arguments.length > 2 ? arguments[1] : 20000;
  const Peer = window.__nativePeer ?? window.RTCPeerConnection;
  (async () => {
    window.__loop = [];
    for (let i = 0; i < n; i++) {
      const a = new Peer(), b = new Peer();
      a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
      b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
      const channel = a.createDataChannel("edge");
      const far = new Promise((resolve) => { b.ondatachannel = (event) => { event.channel.onmessage = () => {}; resolve(event.channel); }; });
      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer());
      await a.setRemoteDescription(b.localDescription);
      await Promise.race([Promise.all([far, new Promise((resolve) => { if (channel.readyState === "open") resolve(); else channel.onopen = resolve; })]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("edge " + i + " did not open")), wait))]);
      window.__loop.push({ a, b, channel });
    }
    return window.__loop.length;
  })().then(done, (error) => done(String(error)));
`;
/** One message on every loopback edge, as a hub passes one on: a frame of about 400 bytes each. */
const LOOP_SEND = `const text = "x".repeat(400); let sent = 0; for (const e of window.__loop ?? []) { if (e.channel.readyState === "open") { e.channel.send(text); sent++; } } return sent;`;
const LOOP_CLOSE = `for (const e of window.__loop ?? []) { e.a.close(); e.b.close(); } window.__loop = []; return true;`;

interface Sample { at: number; rss: Record<string, number>; cpu: Record<string, number> }
/** `ps` time (`[[dd-]hh:]mm:ss.cc`) in seconds. */
function cpuSeconds(time: string): number {
  const [days, rest] = time.includes("-") ? time.split("-") : ["0", time];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}
function webkitPids(): Map<number, string> {
  const out = execFileSync("ps", ["-axo", "pid=,comm="]).toString();
  const pids = new Map<number, string>();
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match && /com\.apple\.WebKit\./.test(match[2])) pids.set(Number(match[1]), match[2].split("/").pop()!);
  }
  return pids;
}
function sample(pids: Map<number, string>): Sample {
  const rss: Record<string, number> = {}, cpu: Record<string, number> = {};
  const list = [...pids.keys()].join(",");
  const out = execFileSync("ps", ["-o", "pid=,rss=,time=", "-p", list]).toString();
  for (const line of out.split("\n")) {
    const [pid, kb, time] = line.trim().split(/\s+/);
    if (!pid) continue;
    const name = pids.get(Number(pid)) ?? pid;
    rss[name] = (rss[name] ?? 0) + Number(kb) / 1024;
    cpu[name] = (cpu[name] ?? 0) + cpuSeconds(time);
  }
  return { at: Date.now(), rss, cpu };
}
/** Samples every 5 s for `ms`: mean and peak resident MiB, and CPU (% of one core) per process, and in total. */
async function measure(pids: Map<number, string>, ms: number) {
  const samples: Sample[] = [sample(pids)];
  while (Date.now() - samples[0].at < ms) { await new Promise((r) => setTimeout(r, 5_000)); samples.push(sample(pids)); }
  const first = samples[0], last = samples[samples.length - 1], wall = (last.at - first.at) / 1000;
  const names = Object.keys(last.rss);
  const per = Object.fromEntries(names.map((name) => [name, {
    rssMiB: Math.round(samples.reduce((s, x) => s + (x.rss[name] ?? 0), 0) / samples.length),
    peakMiB: Math.round(Math.max(...samples.map((x) => x.rss[name] ?? 0))),
    cpuPercent: Math.round(((last.cpu[name] ?? 0) - (first.cpu[name] ?? 0)) / wall * 1000) / 10,
  }]));
  const total = { rssMiB: names.reduce((s, n) => s + per[n].rssMiB, 0), cpuPercent: Math.round(names.reduce((s, n) => s + per[n].cpuPercent, 0) * 10) / 10 };
  return { seconds: Math.round(wall), total, per };
}

test("what a private group of 32 costs the Desktop app in WKWebView: full mesh, a member with hubs, the hub", {
  tag: ["@client:desktop", "@feature:groups.hubs", "@gated"],
}, async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS only: the system WKWebView");
  test.skip(!process.env.E2E_MESH_COST, "A measurement: E2E_MESH_COST=1");
  test.setTimeout(90 * 60_000);
  const relay = new LocalRelay();
  const { default: testnet } = (await import(HYPERDHT_TESTNET)) as { default: (size: number, opts?: { port?: number }) => Promise<{ bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }> };
  const dht = await testnet(3, { port: PORTS.dht });
  const relayUrl = await relay.listen(PORTS.relay);
  const bootstrap = dht.bootstrap.map((node) => `${node.host}:${node.port}`).join(",");
  const env = { GHOSTLY_PKARR_RELAYS: relayUrl, GHOSTLY_HYPERDHT_BOOTSTRAP: bootstrap };
  // The bots inherit these: the same HyperDHT network as the app, and no bot offers itself as a hub.
  process.env.GHOSTLY_HYPERDHT_BOOTSTRAP = bootstrap;
  process.env.GHOSTLY_HUB = "0";
  const bots = Array.from({ length: N - 1 }, () => new HeadlessBot());
  const apps: MacDesktop[] = [];
  let mac: DesktopPerson | undefined;
  const report: Record<string, unknown> = { members: N };
  forgetSharedData();
  try {
    const [admin] = bots;
    await admin.start(relayUrl, "Admin");
    const group = (await admin.run("group", "create", "Cost", "--mesh")).group as string;
    const link = (await admin.run("group", "link", group)).link as string;
    const members = async () => (await admin.run("group", "show", group)).members as { key: string; name: string | null; me: boolean; online: boolean; hub?: boolean }[];

    const before = webkitPids();
    let desktop: MacDesktop | undefined;
    mac = await desktopPerson("a", {
      env,
      open: async () => {
        desktop = await openMacDesktop({ name: "a", port: PORTS.a, env });
        apps.push(desktop);
        return { app: desktop.app, stop: () => desktop!.stop() };
      },
    });
    const app = mac;
    await app.app.execute(COUNT_PEERS);
    // The app's processes: its own, and the WebKit ones that came with it.
    const pids = new Map([[desktop!.pid!, "app"], ...[...webkitPids()].filter(([pid]) => !before.has(pid))]);
    report.processes = [...pids.values()];
    report.alone = await measure(pids, 30_000);
    writeFileSync(testInfo.outputPath("mesh-cost.json"), JSON.stringify(report, null, 2));

    await test.step(`${LOOP_EDGES} edges in the page itself (loopback), idle and passing a message on every 2 s`, async () => {
      const made = await app.app.executeAsync<number | string>(LOOPBACK, LOOP_EDGES);
      report.loopbackEdges = made;
      if (typeof made === "number") {
        const idle = await measure(pids, IDLE_MS);
        const stop = Date.now() + BUSY_MS;
        let messages = 0;
        const sending = (async () => { while (Date.now() < stop) { await app.app.execute(LOOP_SEND); messages++; await new Promise((r) => setTimeout(r, 2_000)); } })();
        const busy = await measure(pids, BUSY_MS);
        await sending;
        report.loopback = { edges: made, idle, busy: { ...busy, messages } };
      }
      await app.app.execute(LOOP_CLOSE);
      writeFileSync(testInfo.outputPath("mesh-cost.json"), JSON.stringify(report, null, 2));
    });
    // Past about 23 loopback edges (46 connections) WKWebView opened no more, and its next session did not come up
    // either: `E2E_MESH_COST_LOOPBACK_ONLY=1` stops here, for the per-edge cost below that ceiling.
    if (process.env.E2E_MESH_COST_LOOPBACK_ONLY) {
      // How many loopback edges open at all (60 s each), and whether a fresh one opens after they are all closed.
      const started = Date.now();
      report.ceiling = { opened: await app.app.executeAsync<number | string>(LOOPBACK, 48, 60_000), seconds: Math.round((Date.now() - started) / 1000),
        live: await app.app.execute<number>(`return (window.__loop ?? []).length;`) };
      await app.app.execute(LOOP_CLOSE);
      await new Promise((r) => setTimeout(r, 15_000));
      report.afterCeiling = await app.app.executeAsync<number | string>(LOOPBACK, 1, 60_000);
      await app.app.execute(LOOP_CLOSE);
      writeFileSync(testInfo.outputPath("mesh-cost.json"), JSON.stringify(report, null, 2));
      console.log(`MESH_COST ${JSON.stringify(report)}`);
      return;
    }

    await test.step(`the app and ${N - 2} more bots join through the admin's link`, async () => {
      // Pasted into Join, as a person does with a link someone sent them.
      await app.join(link);
      await expect.poll(async () => (await members()).length, { timeout: 180_000, message: "the app is let in" }).toBe(2)
        .catch(async (error) => { writeFileSync(testInfo.outputPath("app.txt"), `${await app.snapshot()}\n\n${desktop!.log.join("")}`); throw error; });
      // Three at a time (the admin runs four entry sessions at once). A join stuck for four minutes (the entry session
      // under this load) is started again with a fresh key, as a person would: forget it, open the link again.
      const status = async (bot: HeadlessBot) => (await bot.run("group", "show", group).catch(() => ({ status: null }))).status;
      const join = async (bot: HeadlessBot, name: string) => {
        await bot.start(relayUrl, name);
        for (let attempt = 0; attempt < 4; attempt++) {
          await bot.run("group", "join", link);
          const until = Date.now() + 4 * 60_000;
          while (Date.now() < until && (await status(bot)) !== "active") await new Promise((r) => setTimeout(r, 3_000));
          if ((await status(bot)) === "active") { if (attempt) report.joinRetries = (report.joinRetries as number ?? 0) + attempt; return; }
          await bot.run("group", "forget", group, "--yes").catch(() => bot.run("group", "forget", group));
        }
        throw new Error(`${name} could not join`);
      };
      const rest = bots.slice(1);
      for (let i = 0; i < rest.length; i += 3) await Promise.all(rest.slice(i, i + 3).map((bot, j) => join(bot, `Bot ${i + j + 1}`)));
      await expect.poll(async () => (await members()).length, { timeout: 300_000 }).toBe(N);
    });
    const botKeys = new Set(await Promise.all(bots.map(async (bot) => (await bot.run("group", "show", group)).me as string)));
    const appKey = (await members()).find((m) => !botKeys.has(m.key))!.key;
    const edges = () => app.app.execute<number>(CONNECTED);
    const hub = (member: string, flag: string) => admin.run("group", "hub", group, member, flag);
    const busy = async () => {
      let i = 0;
      const stop = Date.now() + BUSY_MS;
      const posting = (async () => { while (Date.now() < stop) { await bots[1 + (i % (N - 2))].run("group", "send", group, "--", `load ${i++}`).catch(() => {}); await new Promise((r) => setTimeout(r, 2_000)); } })();
      const result = await measure(pids, BUSY_MS);
      await posting;
      return { ...result, messages: i };
    };
    const state = async (name: string, wantEdges: number, within = SETTLE_MS, strict = true) => {
      const started = Date.now();
      const reached = expect.poll(edges, { timeout: within, intervals: [5_000], message: `${name}: the app's edges` }).toBe(wantEdges);
      await reached.catch(async (error) => {
        // What was going on, for the next run: the page's connections, the admin's view, the app's screen and log.
        writeFileSync(testInfo.outputPath(`${name}-stalled.txt`), JSON.stringify({ peers: await app.app.execute(PEERS), members: await members() }, null, 2)
          + `\n\n${await app.snapshot()}\n\n${desktop!.log.join("")}`);
        if (strict) throw error;
      });
      report[name] = { edges: await edges(), wanted: wantEdges, settledSeconds: Math.round((Date.now() - started) / 1000), idle: await measure(pids, IDLE_MS), busy: await busy() };
      writeFileSync(testInfo.outputPath("mesh-cost.json"), JSON.stringify(report, null, 2));
    };

    await test.step("the app the only hub: an edge with everyone, passing everything on", async () => {
      await state("theHub", N - 1, SETTLE_MS, false);
    });
    await test.step("the app a plain member of a group on two hubs: two edges", async () => {
      await hub([...botKeys][1], "--pin");
      await hub([...botKeys][2], "--pin");
      await hub(appKey, "--exclude");
      await state("memberWithHubs", 2, SETTLE_MS, false);
    });
    if (process.env.E2E_MESH_COST_MESH) await test.step("a full mesh: nobody a hub, every pair on its own edge", async () => {
      await hub([...botKeys][1], "--auto");
      await hub([...botKeys][2], "--auto");
      await state("fullMesh", N - 1, Number(process.env.E2E_MESH_COST_MESH_MS ?? 10 * 60_000), false);
    });
    console.log(`MESH_COST ${JSON.stringify(report)}`);
    await testInfo.attach("mesh-cost.json", { path: testInfo.outputPath("mesh-cost.json"), contentType: "application/json" });
  } finally {
    await mac?.stop().catch(() => {});
    for (const desktop of apps) await desktop.stop().catch(() => {});
    await Promise.all(bots.map((bot) => bot.stop().catch(() => {})));
    relay.close();
    await dht.destroy().catch(() => {});
    delete process.env.GHOSTLY_HUB;
  }
});
