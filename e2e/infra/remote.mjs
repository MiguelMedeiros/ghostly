// The end-to-end environment on another machine (a Docker host reached over SSH on a Tailscale network), for
// Macs that should not pay for forty containers. Browsers, the app build and Playwright stay on this machine.
//
//   npm run e2e:infra:up -- --host miguel@one        or   E2E_INFRA_HOST=miguel@one npm run e2e:infra:up
//
// Docker runs there through DOCKER_HOST=ssh://<host>; published ports are bound to that host's Tailscale address
// (E2E_INFRA_ADDRESS, read with `tailscale ip -4` over SSH unless set) and never to 0.0.0.0. Every endpoint of
// env.mjs then names that address instead of 127.0.0.1, and `docker exec` goes over one shared SSH connection.
//
// Import this module before env.mjs: it sets the variables env.mjs reads at load time.
import { execFileSync, spawnSync } from "node:child_process";

/** Short names for known hosts (the maintainer's test server): `--host one`. */
const ALIASES = { one: "miguel@one" };

/** `--host <target>` or `--host=<target>`, taken out of argv so the command line reads as before. */
function hostFromArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host") { const [, value] = argv.splice(i, 2); return { value, flag: true }; }
    if (argv[i].startsWith("--host=")) { const [arg] = argv.splice(i, 1); return { value: arg.slice(7), flag: true }; }
  }
  return { value: process.env.E2E_INFRA_HOST || "", flag: false };
}

const fromArgs = hostFromArgs(process.argv);
/** The SSH target the environment runs on (user@host), or "" for this machine's Docker. */
export const HOST = ALIASES[fromArgs.value] ?? fromArgs.value;
/** Whether the command line itself named the host (`down` and `reset` of a shared environment want that). */
export const HOST_FLAG = fromArgs.flag;
export const remote = Boolean(HOST);

/** A Tailscale address (100.64.0.0/10): the only kind this module binds to without being told. */
const tailscale = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(ip);

function address() {
  const given = process.env.E2E_INFRA_ADDRESS;
  if (given) {
    if (given === "0.0.0.0" || given === "::") throw new Error("E2E_INFRA_ADDRESS must be one interface, not every one");
    return given;
  }
  const found = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HOST, "tailscale", "ip", "-4"], { encoding: "utf8" });
  const ip = (found.stdout ?? "").split("\n")[0].trim();
  if (found.status !== 0 || !tailscale(ip)) {
    throw new Error(`Could not read ${HOST}'s Tailscale address (${(found.stderr ?? "").trim() || ip || "no answer"}); set E2E_INFRA_ADDRESS`);
  }
  return ip;
}

if (remote) {
  process.env.E2E_INFRA_HOST = HOST;
  process.env.E2E_INFRA_ADDRESS = address();
  process.env.DOCKER_HOST = `ssh://${HOST}`;
}

// ── SSH ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Short sockets in /tmp (a Unix socket path is limited to ~104 bytes on macOS); %C is ssh's hash of the target.
const BASE = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30"];
const MUX = [...BASE, "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/ghostly-e2e-mux-%C", "-o", "ControlPersist=300"];
const TUNNEL = "/tmp/ghostly-e2e-tunnel-%C";

const quote = (arg) => `'${String(arg).replaceAll("'", "'\\''")}'`;

/**
 * `docker <args>` on the environment's host, over one multiplexed SSH connection: the support scripts run
 * hundreds of `docker exec`, and a fresh SSH handshake for each (what DOCKER_HOST=ssh:// does) costs ~0.4 s.
 */
export const docker = (args, options = {}) => execFileSync("ssh", [...MUX, HOST, "docker", ...args.map(quote)], options);

/**
 * The web app names three services by a fixed 127.0.0.1 port (its Regtest options: Ark, Bark and their Esplora,
 * the local EVM chain). With the environment elsewhere, one SSH connection in the background forwards those ports
 * of this machine to it; every other endpoint is reached directly. One tunnel per machine, shared by every checkout.
 */
export function tunnel(ports) {
  const check = spawnSync("ssh", [...BASE, "-S", TUNNEL, "-O", "check", HOST], { stdio: "ignore" });
  if (check.status === 0) return "running";
  const forwards = ports.flatMap((port) => ["-L", `127.0.0.1:${port}:${process.env.E2E_INFRA_ADDRESS}:${port}`]);
  const started = spawnSync("ssh", [...BASE, "-f", "-N", "-M", "-S", TUNNEL, "-o", "ControlPersist=yes", "-o", "ExitOnForwardFailure=yes", ...forwards, HOST], { encoding: "utf8" });
  if (started.status !== 0) {
    throw new Error(`Could not forward 127.0.0.1:${ports.join(",")} to ${HOST} (is the local environment up?): ${(started.stderr ?? "").trim()}`);
  }
  return "started";
}

export const tunnelUp = () => spawnSync("ssh", [...BASE, "-S", TUNNEL, "-O", "check", HOST], { stdio: "ignore" }).status === 0;
export const closeTunnel = () => { spawnSync("ssh", [...BASE, "-S", TUNNEL, "-O", "exit", HOST], { stdio: "ignore" }); };
