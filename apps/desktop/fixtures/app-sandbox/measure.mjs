#!/usr/bin/env node
// The Desktop sandbox spike's measurement (WISP 12xx, marketplace PR 0). It starts its own listeners, starts a
// Desktop build that has the test driver (`--features e2e-driver`), opens malicious-app.html in app windows
// under each guard (`full` as the app will run it, `header` without the navigation lock, `control` with no
// policy either), and prints what got out: what the page saw, what reached the listeners, what the window
// was refused.
//
//   node apps/desktop/fixtures/app-sandbox/measure.mjs --app <path to the ghostly binary> [--port-base 4300] [--out results.json]
//     [--guards full,header+lock,header,control] [--groups net,nav-top,…]
//   Layers for --guards (Guard::parse): full, control, or header+lock+rules+prefs+proxy+webrtc (webrtc: Linux,
//   WebRTC switched on, to show the nested-frame case closed by the other layers).
//
// `full` also sends the window's network to the app's own proxy that goes nowhere; what it caught is listed.
// Ports, from --port-base: +0 the driver, +10 HTTP (fetch and the rest), +11 UDP (STUN), +12 TCP (preconnect),
// +14 TCP (TURN). Everything it starts, it stops. The app's PID goes in --pid-file (default: next to --out).
//
// Build the app first (see the WISP change file docs/wisps/changes/1200-marketplace/*-desktop-sandbox-spike.md):
//   mkdir -p apps/desktop/native-runtime
//   TAURI_CONFIG='{"identifier":"tools.ghostly.e2e.spike","build":{"frontendDist":"<absolute path to stub-main>"}}' \
//     cargo build -p ghostly --features e2e-driver,tauri/custom-protocol

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []));
if (!args.app) throw new Error("--app <path to the ghostly binary built with --features e2e-driver>");
const base = Number(args["port-base"] ?? 4300);
const ports = { driver: base, http: base + 10, udp: base + 11, tcp: base + 12, turn: base + 14 };
const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "127.0.0.1";
const fixture = readFileSync(join(here, "malicious-app.html"), "utf8");
const commands = [
  ...readFileSync(join(here, "..", "..", "build.rs"), "utf8").match(/const COMMANDS[^]*?\];/)[0].match(/"([a-z_]+)"/g).map((s) => s.slice(1, -1)).filter((c) => c !== "app_broker"),
  "plugin:event|listen", "plugin:event|emit", "plugin:event|emit_to", "plugin:window|close", "plugin:window|get_all_windows",
  "plugin:webview|create_webview_window", "plugin:webview|get_all_webviews", "plugin:app|version", "plugin:path|resolve_directory",
  "plugin:updater|check", "plugin:process|restart", "plugin:notification|notify", "plugin:dialog|open", "plugin:opener|open_url",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Listeners: every hit, with what it was for.
const hits = [];
const hit = (kind, what) => hits.push({ kind, what, at: Date.now() });
const servers = [];
const httpServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => hit("http", `${req.method} ${req.url}${body ? " body " + body.slice(0, 40) : ""}`));
  if (req.url.endsWith("/eventsource")) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("data: x\n\n"); return; }
  res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
  res.end("x");
});
httpServer.on("upgrade", (req, socket) => { hit("http", `UPGRADE ${req.url}`); socket.destroy(); });
const raw = (kind) => net.createServer((socket) => { hit(kind, `connection from ${socket.remoteAddress}`); socket.destroy(); });
const preconnect = raw("preconnect");
const turn = raw("turn");
const stun = dgram.createSocket("udp4");
stun.on("message", (_, from) => hit("stun", `packet from ${from.address}`));

const listen = (server, port, host) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { servers.push(server); resolve(); }); });
await listen(httpServer, ports.http, "127.0.0.1");
await listen(preconnect, ports.tcp, "0.0.0.0");
await listen(turn, ports.turn, "0.0.0.0");
await new Promise((resolve) => stun.bind(ports.udp, "0.0.0.0", resolve));

// --- The app, with its driver.
const token = randomBytes(16).toString("hex");
const child = spawn(args.app, [], { env: { ...process.env, GHOSTLY_E2E_DRIVER: String(ports.driver), GHOSTLY_E2E_DRIVER_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
let appLog = "";
child.stdout.on("data", (d) => (appLog += d));
child.stderr.on("data", (d) => (appLog += d));
writeFileSync(args["pid-file"] ?? `${args.out ?? "measure"}.pid`, String(child.pid));

async function driver(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${ports.driver}${path}`, { method, headers: { "x-ghostly-e2e": token }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  return JSON.parse(text);
}
const evalIn = async (window, script) => { const v = await driver("POST", "/eval", { window, script }); return typeof v === "string" ? JSON.parse(v) : v; };

async function run(group, guard) {
  const nonce = `m0${randomBytes(5).toString("hex")}`;
  const probe = { group, nonce, host: "127.0.0.1", lan, http: ports.http, udp: ports.udp, tcp: ports.tcp, turn: ports.turn, dnsName: `${nonce}.local`, commands };
  const entry = `<script>window.__PROBE = ${JSON.stringify(probe)};</script>\n${fixture}`;
  const before = new Set(await driver("GET", "/windows"));
  const startHits = hits.length;
  const caughtBefore = (await driver("GET", "/app-caught")).length;
  const label = await driver("POST", "/app-open", { app: "spike/malicious", entry, guard });
  let results = null;
  for (let i = 0; i < (group === "net" ? 60 : 8); i++) {
    await sleep(500);
    try { results = await evalIn(label, "JSON.stringify(window.__results || null)"); } catch { results = null; }
    if (results?.done) break;
  }
  await sleep(group === "net" ? 3000 : 2500);
  let location = null;
  try { location = await evalIn(label, "JSON.stringify(location.href)"); } catch (e) { location = `eval failed: ${e.message}`; }
  const refused = await driver("POST", "/app-refused", label).catch((e) => [`(${e.message})`]);
  const after = await driver("GET", "/windows");
  const newWindows = after.filter((w) => !before.has(w) && w !== label);
  const sinceHits = hits.slice(startHits);
  const mine = sinceHits.filter((h) => h.what.includes(nonce) || ["stun", "turn", "preconnect"].includes(h.kind));
  const caught = (await driver("GET", "/app-caught")).slice(caughtBefore);
  await driver("POST", "/app-close", label).catch(() => {});
  return { group, guard, label, location, results, refused, newWindows, hits: mine, caught };
}

const outcome = { platform: process.platform, lan, webkit: null, runs: [] };
try {
  for (let i = 0; i < 60; i++) {
    try { await driver("GET", "/windows"); break; } catch { await sleep(500); }
  }
  // The Ghostly window is read after the first app window ran, not at start: a script sent to a window still
  // loading its page never answers (the driver's 504 after 30 s, seen on Linux and macOS).
  const readMain = async () => {
    for (let i = 0; i < 2; i++) {
      try { return await evalIn("main", "JSON.stringify({ origin: self.origin, rtc: typeof RTCPeerConnection, seen: window.__seen || null, ready: document.readyState })"); }
      catch (e) { if (i === 1) return `main eval failed: ${e.message}`; await sleep(2000); }
    }
  };
  outcome.webkit = await driver("GET", "/app-webkit").catch((e) => `(${e.message})`);
  const groups = args.groups ? args.groups.split(",") : ["net", "nav-top", "nav-tauri", "nav-reload", "nav-meta", "nav-form", "nav-form-blank", "nav-open", "nav-link-blank", "nav-ping", "nav-frame-top"];
  const guards = (args.guards ?? "full,header+lock,header,control").split(",");
  for (const guard of guards) {
    for (const group of groups) {
      const r = await run(group, guard);
      outcome.runs.push(r);
      if (outcome.main === undefined) outcome.main = await readMain();
      console.error(`${guard} ${group}: ${r.hits.length} hits, refused ${r.refused.length}, new windows ${r.newWindows.length}, proxy caught ${r.caught.length}`);
    }
  }
  outcome.mainAfter = await readMain();
} finally {
  child.kill("SIGTERM");
  await sleep(1000);
  if (child.exitCode === null) child.kill("SIGKILL");
  for (const s of servers) s.close();
  stun.close();
}
outcome.appLogTail = appLog.split("\n").filter((l) => /app|sandbox|CSP|Refused|refused|blocked/i.test(l)).slice(-60);
const json = JSON.stringify(outcome, null, 2);
if (args.out) writeFileSync(args.out, json);
else console.log(json);
