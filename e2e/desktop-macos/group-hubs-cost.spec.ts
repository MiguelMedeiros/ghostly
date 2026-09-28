import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { desktopPerson, type DesktopPerson } from "../matrix/people";
import { HYPERDHT_TESTNET } from "../matrix/desktop";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";
import { HeadlessBot } from "../support/headless";
import { LocalRelay } from "../support/relay";

/**
 * A measurement, not a check (WISP 9xx · Group Mesh § Cost per member): what a private group of 32 costs the Desktop
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
const IDLE_MS = Number(process.env.E2E_MESH_COST_IDLE_MS ?? 120_000);
const BUSY_MS = Number(process.env.E2E_MESH_COST_BUSY_MS ?? 60_000);

/** Every peer connection the page makes, kept, so the test can count the edges that are up. Idempotent. */
const COUNT_PEERS = `
  if (window.__meshPeers) return;
  window.__meshPeers = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.__meshPeers.push(this); } };
`;
const CONNECTED = `return (window.__meshPeers ?? []).filter((pc) => pc.connectionState === "connected").length;`;

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

    await test.step(`the app and ${N - 2} more bots join through the admin's link`, async () => {
      // Pasted into Join, as a person does with a link someone sent them.
      await app.join(link);
      await expect.poll(async () => (await members()).length, { timeout: 180_000, message: "the app is let in" }).toBe(2)
        .catch(async (error) => { writeFileSync(testInfo.outputPath("app.txt"), `${await app.snapshot()}\n\n${desktop!.log.join("")}`); throw error; });
      for (const [i, bot] of bots.slice(1).entries()) {
        await bot.start(relayUrl, `Bot ${i + 1}`);
        await bot.run("group", "join", link);
        await expect.poll(async () => (await bot.run("group", "show", group)).status, { timeout: 600_000, intervals: [3_000] }).toBe("active");
      }
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
    const state = async (name: string, wantEdges: number, within = 20 * 60_000, strict = true) => {
      const started = Date.now();
      const reached = expect.poll(edges, { timeout: within, intervals: [5_000], message: `${name}: the app's edges` }).toBe(wantEdges);
      if (strict) await reached; else await reached.catch(() => {});
      report[name] = { edges: await edges(), wanted: wantEdges, settledSeconds: Math.round((Date.now() - started) / 1000), idle: await measure(pids, IDLE_MS), busy: await busy() };
      writeFileSync(testInfo.outputPath("mesh-cost.json"), JSON.stringify(report, null, 2));
    };

    await test.step("the app the only hub: an edge with everyone, passing everything on", async () => {
      await state("theHub", N - 1);
    });
    await test.step("the app a plain member of a group on two hubs: two edges", async () => {
      await hub([...botKeys][1], "--pin");
      await hub([...botKeys][2], "--pin");
      await hub(appKey, "--exclude");
      await state("memberWithHubs", 2);
    });
    await test.step("a full mesh: nobody a hub, every pair on its own edge", async () => {
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
