#!/usr/bin/env node
// The end-to-end environment, one command at a time. Worthless regtest coins, test tokens and throwaway keys.
//   node e2e/infra/infra.mjs up       start every service (docker-compose.yml), wait for health, fund and open
//                                     channels (idempotent), write .env.e2e            (npm run e2e:infra:up)
//   node e2e/infra/infra.mjs seed     only the funding step, again: safe to repeat
//   node e2e/infra/infra.mjs down     stop and remove everything, volumes included, and .env.e2e (npm run e2e:infra:down)
//   node e2e/infra/infra.mjs reset    down, then up: a fresh chain                      (npm run e2e:infra:reset)
//   node e2e/infra/infra.mjs status   the containers and whether each endpoint answers
//   node e2e/infra/infra.mjs use      an environment that is already up, as it is: check it answers, write .env.e2e
//                                     (npm run e2e:infra:use; with --host, how another checkout joins the shared one)
//   node e2e/infra/infra.mjs full [--keep] [--no-vitest] [-- <playwright args>]         (npm run e2e:full)
//                                     down, up, the gated provider contracts (vitest), the web and extension
//                                     end-to-end suites with every gated suite on, then down — even on failure
//                                     or Ctrl-C, unless --keep.
// Only this project's containers (ghostly-e2e-*) are ever started, stopped or removed.
//
// Every command takes --host <ssh target> (or E2E_INFRA_HOST) to run the environment on another machine's Docker
// instead of this one's (remote.mjs): `--host one` is the maintainer's test server. There, `up` joins a stack that
// is already up rather than seeding it again under other checkouts' tests, `full` never takes it down, and
// `down` / `reset` want --host on the command line itself.
import { HOST, HOST_FLAG, SOCKET, disconnect, forward, remote } from "./remote.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMiner } from "./chain.mjs";
import { PROJECT, SERVICE_PORTS, VARIABLES, dotenv, endpoints, localPort, read } from "./env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE = join(ROOT, "e2e", "infra", "docker-compose.yml");
const COMPOSE_REMOTE = join(ROOT, "e2e", "infra", "docker-compose.remote.yml");
const CONFIG = join(ROOT, "e2e", "infra", "config");
const ENV_FILE = join(ROOT, ".env.e2e");
const started = Date.now();
const elapsed = (since = started) => `${Math.round((Date.now() - since) / 1000)}s`;
const log = (message) => console.log(`[e2e-infra ${elapsed()}] ${message}`);
const where = remote ? `${PROJECT} on ${HOST} (${process.env.E2E_INFRA_ADDRESS})` : PROJECT;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The environment's own variables (defaults, or what the shell set), for compose and every child. */
function environment(extra = {}) {
  const values = Object.fromEntries(Object.keys(VARIABLES).map((name) => [name, read(name)]));
  return { ...process.env, ...values, ...extra };
}

/** The config files, as docker-compose.remote.yml takes them: another host's Docker cannot mount this checkout. */
const configs = () => ({
  E2E_INFRA_CAPTAIND_TOML: readFileSync(join(CONFIG, "captaind.toml"), "utf8"),
  E2E_INFRA_CAPTAIND_START: readFileSync(join(CONFIG, "captaind-start.sh"), "utf8"),
  E2E_INFRA_STRFRY_CONF: readFileSync(join(CONFIG, "strfry.conf"), "utf8"),
});

function compose(args, { quiet = false } = {}) {
  const files = remote ? ["-f", COMPOSE, "-f", COMPOSE_REMOTE] : ["-f", COMPOSE];
  const result = spawnSync("docker", ["compose", "-p", PROJECT, ...files, ...args], { cwd: ROOT, env: environment(remote ? configs() : {}), stdio: quiet ? "pipe" : "inherit", encoding: "utf8", maxBuffer: 1 << 28 });
  return result.status === 0 ? (result.stdout ?? "") : null;
}

function containers() {
  const out = compose(["ps", "-a", "--format", "json"], { quiet: true }) ?? "";
  // One JSON object per line (Compose 2.21 and later), or one array (earlier).
  return out.split("\n").filter(Boolean).flatMap((line) => JSON.parse(line));
}

// ── Health ────────────────────────────────────────────────────────────────────────────────────────────────────
const tcp = (url) => new Promise((resolve) => {
  const { hostname, port } = new URL(url);
  const socket = connect({ host: hostname, port: Number(port) }, () => { socket.end(); resolve(true); });
  socket.on("error", () => resolve(false));
  socket.setTimeout(3000, () => { socket.destroy(); resolve(false); });
});
const http = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
const rpc = (url, method) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }), signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);

/** One check per endpoint the suites use: what "up" means, as the host sees it. */
const PROBES = {
  "bitcoind RPC": () => tcp(endpoints.bitcoind.url),
  Esplora: () => http(`${endpoints.esplora}/blocks/tip/height`),
  arkd: () => tcp(endpoints.ark.server),
  captaind: () => tcp(endpoints.bark.server),
  "LND alice / bob": async () => (await tcp(endpoints.lnd.alice)) && tcp(endpoints.lnd.bob),
  "WebLN LND alice / bob": async () => (await tcp(endpoints.webln.alice)) && tcp(endpoints.webln.bob),
  "CLN alice / bob": async () => (await tcp(endpoints.cln.alice.replace(/^ws/, "http"))) && tcp(endpoints.cln.bob.replace(/^ws/, "http")),
  "NWC relay": () => tcp(endpoints.nwc.relay.replace(/^ws/, "http")),
  "Alby Hubs": async () => (await http(`${endpoints.nwc.hub.alice}/api/info`)) && http(`${endpoints.nwc.hub.bob}/api/info`),
  Anvil: () => rpc(endpoints.usdt.rpc, "eth_chainId"),
  S3: () => http(`${endpoints.s3.endpoint}/health`),
  // The environment's own mint, whatever E2E_MINT_URL points the suite at.
  "Cashu mint": () => http(`${read("E2E_MINT_URL")}/v1/info`),
};

async function probe() {
  const results = await Promise.all(Object.entries(PROBES).map(async ([name, check]) => [name, await check()]));
  return Object.fromEntries(results);
}

async function waitHealthy(timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  const restarted = new Set();
  for (;;) {
    const list = containers();
    // A container that gave up (exited, or unhealthy for good) gets one restart: first boots race each other.
    for (const c of list) {
      const stuck = c.State === "exited" || c.Health === "unhealthy";
      if (stuck && !restarted.has(c.Name)) {
        log(`restarting ${c.Name} (${c.State}${c.Health ? `, ${c.Health}` : ""})`);
        spawnSync("docker", ["restart", c.Name], { stdio: "ignore" });
        restarted.add(c.Name);
      }
    }
    const pending = list.filter((c) => c.State !== "running" || (c.Health && c.Health !== "healthy")).map((c) => c.Service);
    const answers = await probe();
    const silent = Object.entries(answers).filter(([, ok]) => !ok).map(([name]) => name);
    if (!pending.length && !silent.length) return;
    if (Date.now() > deadline) {
      for (const c of list.filter((c) => pending.includes(c.Service))) spawnSync("docker", ["logs", "--tail", "40", c.Name], { stdio: "inherit" });
      throw new Error(`Not healthy after ${timeoutMs / 1000}s: ${[...pending, ...silent].join(", ")}`);
    }
    await wait(3000);
  }
}

// ── Funding ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Each suite's own idempotent `ready`: fund its nodes, open its channels, deploy its contract. */
const SEEDS = {
  bdk: ["e2e/support/bdk-regtest/regtest.mjs", "ready"],
  ark: ["e2e/support/ark-regtest/regtest.mjs", "ready"],
  bark: ["e2e/support/bark-regtest/regtest.mjs", "ready"],
  lnd: ["e2e/support/lnd-regtest/regtest.mjs", "ready"],
  webln: ["e2e/support/webln-regtest/regtest.mjs", "ready"],
  cln: ["e2e/support/cln-regtest/regtest.mjs", "ready"],
  nwc: ["e2e/support/nwc-regtest/regtest.mjs", "ready"],
  usdt: ["e2e/support/usdt-local.mjs", "ready"],
};

function node(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { output += String(error); });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function seed() {
  // One chain under all of them: the miner wallet first, then they run at once, each mining what it needs.
  ensureMiner();
  const env = environment();
  const results = await Promise.all(Object.entries(SEEDS).map(async ([name, args]) => {
    const since = Date.now();
    const { code, output } = await node(args, env);
    log(`${code === 0 ? "ready" : "FAILED"}: ${name} (${elapsed(since)})`);
    return { name, code, output };
  }));
  // Seeds are idempotent: one that lost a race with the others (a busy host, a block mined under it) goes again,
  // alone, before the environment is called broken.
  const failed = [];
  for (const first of results.filter((r) => r.code !== 0)) {
    log(`again: ${first.name}`);
    const since = Date.now();
    const again = await node(SEEDS[first.name], env);
    log(`${again.code === 0 ? "ready" : "FAILED"}: ${first.name} (${elapsed(since)})`);
    if (again.code !== 0) failed.push({ name: first.name, output: `${first.output}\n--- again\n${again.output}` });
  }
  for (const f of failed) console.error(`--- ${f.name}\n${f.output.trim()}`);
  if (failed.length) throw new Error(`Seeding failed: ${failed.map((f) => f.name).join(", ")}`);
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Whether every container runs (healthy where it says) and every endpoint answers: an environment to join. */
async function answering() {
  const list = containers();
  if (!list.length || list.some((c) => c.State !== "running" || (c.Health && c.Health !== "healthy"))) return false;
  return Object.values(await probe()).every(Boolean);
}

/** Remote: every published port, forwarded to this machine's port for it (env.mjs `localPort`). */
const FORWARDS = SERVICE_PORTS.map((port) => [localPort(port), port]);
const LOCAL_PORTS = `127.0.0.1:${FORWARDS[0][0]}-${FORWARDS.at(-1)[0]}`;

function forwardAll({ strict = true } = {}) {
  const held = forward(FORWARDS);
  if (!held.length) return true;
  const message = `127.0.0.1:${held.join(",")} is held on this machine (a local ghostly-e2e?), so it cannot be forwarded to ${HOST}. `
    + "Stop what holds it, or set E2E_INFRA_LOCAL_PORTS=<first free port> to use other ports here (the app's own Regtest "
    + "options, Ark, Bark and the EVM chain, then do not reach the environment).";
  if (strict) throw new Error(message);
  console.log(`WARNING: ${message}`);
  return false;
}

function writeEnv() {
  writeFileSync(ENV_FILE, dotenv(Object.fromEntries(Object.keys(VARIABLES).map((name) => [name, process.env[name]]).filter(([, v]) => v))));
  log(`up: variables in ${ENV_FILE}`);
}

async function use() {
  if (remote) forwardAll();
  if (!(await answering())) throw new Error(`${where} is not up (or not every service answers): npm run e2e:infra:status${remote ? ` -- --host ${HOST}` : ""}`);
  log(`joining ${where}, as it is${remote ? `; its ports forwarded to ${LOCAL_PORTS}` : ""}`);
  writeEnv();
}

async function up() {
  if (remote) {
    forwardAll();
    // Shared by every checkout that points at it: seeding again would mine blocks under their running tests.
    if (await answering()) { await use(); return; }
  }
  log(`starting ${where} (docker compose up)`);
  // bitcoind and its miner wallet first: NBXplorer warms the chain up through the node's loaded wallet.
  if (compose(["up", "-d", "--wait", "--remove-orphans", "bitcoind"]) === null) throw new Error("docker compose up bitcoind failed");
  ensureMiner();
  if (compose(["up", "-d", "--remove-orphans"]) === null) throw new Error("docker compose up failed");
  await waitHealthy();
  log("every service answers; funding");
  await seed();
  writeEnv();
}

function down() {
  // Other checkouts' tests run on a shared environment: a variable left in a shell must not take it down.
  if (remote && !HOST_FLAG) throw new Error(`${where} is shared: name it on the command line to take it down (--host ${HOST})`);
  log(`removing ${where} (containers, volumes, network)`);
  compose(["down", "-v", "--remove-orphans", "--timeout", "5"]);
  rmSync(ENV_FILE, { force: true });
}

async function status() {
  // The endpoints below are probed through the forwards: ports held here would answer for something else.
  const forwarded = !remote || forwardAll({ strict: false });
  const list = containers();
  if (!list.length) { console.log(`${where} is not running.`); process.exitCode = 1; return; }
  for (const c of list) console.log(`${c.Name.padEnd(32)} ${c.State}${c.Health ? ` (${c.Health})` : ""}  ${c.RunningFor ?? ""}`);
  const answers = await probe();
  for (const [name, ok] of Object.entries(answers)) console.log(`${ok ? "answers " : "SILENT  "} ${name}`);
  if (remote) console.log(`connection to ${HOST}: up (Docker at ${SOCKET}, ports at ${LOCAL_PORTS})`);
  const file = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const joined = file && (remote ? file.includes(`E2E_INFRA_HOST=${HOST}\n`) : !file.includes("E2E_INFRA_HOST="));
  console.log(joined ? `variables: ${ENV_FILE}` : `this checkout's .env.e2e does not point here (npm run e2e:infra:use${remote ? ` -- --host ${HOST}` : ""})`);
  const every = forwarded && list.every((c) => c.State === "running" && (!c.Health || c.Health === "healthy")) && Object.values(answers).every(Boolean);
  console.log(every ? `${where}: up` : `${where}: NOT READY`);
  if (!every) process.exitCode = 1;
}

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: "inherit" });
    child.on("error", (error) => { console.error(`${command}: ${error.message}`); resolve(1); });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** The gated provider contracts of @ghostly/browser, against the same services (before the browsers: they share nodes). */
const VITEST_FILES = ["bitcoind.regtest", "bdk.regtest", "arkade.regtest", "usdt.integration", "lndProvider", "weblnProvider.regtest", "coreLightning.regtest", "nwc.regtest"];

async function full(args) {
  const keep = args.includes("--keep");
  const vitest = !args.includes("--no-vitest");
  const separator = args.indexOf("--");
  const playwrightArgs = separator >= 0 ? args.slice(separator + 1) : [];
  let cleaned = false;
  // A shared environment elsewhere stays: `full` joins it (or brings it up) and leaves it for the others.
  const cleanup = () => { if (!cleaned && !keep && !remote) { cleaned = true; down(); } };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
  process.on("SIGHUP", () => { cleanup(); process.exit(129); });

  const phases = [];
  const phase = async (name, work) => { const since = Date.now(); const result = await work(); phases.push(`${name} ${elapsed(since)}`); return result; };
  let code = 1;
  try {
    if (!remote) await phase("down", async () => down());
    await phase("up", up);
    // Breez's regtest is hosted by Breez and Lightspark, and its faucet now wants a reCAPTCHA: on only with a funded
    // counterpart wallet of one's own (GHOSTLY_BREEZ_COUNTERPART), or when the shell turned it on.
    // The Ark SDK opens server-sent events, which Node has behind a flag.
    const env = environment({
      GHOSTLY_BREEZ_TESTNET: process.env.GHOSTLY_BREEZ_TESTNET ?? (process.env.GHOSTLY_BREEZ_COUNTERPART ? "1" : "0"),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--experimental-eventsource"].filter(Boolean).join(" "),
    });
    // One file at a time: bitcoind.regtest mines a hundred blocks at once, which runs out the clock of any HTLC
    // another file has in flight on the same chain (Core Lightning closes that channel).
    const contracts = vitest ? await phase("vitest", () => run("npm", ["test", "-w", "@ghostly/browser", "--", "--no-file-parallelism", ...VITEST_FILES], env)) : 0;
    await phase("build:extension", () => run("npm", ["run", "build:extension"], env));
    const browsers = await phase("playwright", () => run("npx", ["playwright", "test", "-c", "e2e/playwright.config.ts", ...playwrightArgs], env));
    code = contracts || browsers;
    if (contracts) console.error("The provider contracts (vitest) failed; see above.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    // What the services said, for the report: the environment is gone once this returns.
    if (code !== 0) {
      mkdirSync(join(ROOT, "test-results"), { recursive: true });
      writeFileSync(join(ROOT, "test-results", "e2e-infra.log"), compose(["logs", "--no-color", "--timestamps"], { quiet: true }) ?? "");
      log("service logs: test-results/e2e-infra.log");
    }
    await phase("down", async () => cleanup());
    log(`e2e:full ${code === 0 ? "passed" : "FAILED"} in ${elapsed()} (${phases.join(", ")})`);
  }
  process.exit(code);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "up") await up();
  else if (command === "seed") { if (remote) forwardAll(); await seed(); }
  // The background connection goes too (forwards, Docker socket); `reset` still needs it for its `up`.
  else if (command === "down") { down(); if (remote) disconnect(); }
  else if (command === "reset") { down(); await up(); }
  else if (command === "status") await status();
  else if (command === "use") await use();
  else if (command === "full") await full(rest);
  else { console.error("usage: infra.mjs [--host <ssh target>] up | seed | down | reset | status | use | full [--keep] [--no-vitest] [-- <playwright args>]"); process.exit(2); }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
