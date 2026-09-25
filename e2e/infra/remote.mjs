// The end-to-end environment on another machine (a Docker host reached over SSH on a Tailscale network), for
// Macs that should not pay for forty containers. Browsers, the app build and Playwright stay on this machine.
//
//   npm run e2e:infra:up -- --host miguel@one        or   E2E_INFRA_HOST=miguel@one npm run e2e:infra:up
//
// There the ports are published on the host's Tailscale address (E2E_INFRA_ADDRESS, read with `tailscale ip -4`
// unless set), never on 0.0.0.0. One SSH connection in the background, one per machine and shared by every
// checkout, carries everything else:
//   - every published port, forwarded to the same port of 127.0.0.1 here (or from E2E_INFRA_LOCAL_PORTS on, see
//     env.mjs): the app takes plain HTTP and WS from loopback only (S3, Esplora, the NWC relay, the EVM RPC), and
//     names its Regtest options (Ark, Bark, the EVM chain) as 127.0.0.1. So `.env.e2e` reads as in local mode.
//   - that host's Docker socket, as a socket here (DOCKER_HOST=unix:///tmp/ghostly-e2e-docker-<host>.sock), for
//     Compose and the tests that run `docker` themselves. DOCKER_HOST=ssh:// opens a connection per call, and
//     Compose makes dozens at once: sshd's MaxStartups resets them.
//   - the support scripts' `docker exec` (chain.mjs), run by the host's own docker CLI: ~0.15 s, where this
//     machine's CLI through the socket takes ~1 s on a busy Mac.
//
// infra.mjs imports it first: in that process it reads --host, connects and sets the variables env.mjs reads at
// load time. Anywhere else (the scripts and tests, with .env.e2e loaded) it only lends `exec`.
import { execFileSync, spawnSync } from "node:child_process";
import { basename } from "node:path";

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

const main = basename(process.argv[1] ?? "") === "infra.mjs";
const fromArgs = main ? hostFromArgs(process.argv) : { value: process.env.E2E_INFRA_HOST || "", flag: false };
/** The SSH target the environment runs on (user@host), or "" for this machine's Docker. */
export const HOST = ALIASES[fromArgs.value] ?? fromArgs.value;
/** Whether the command line itself named the host (`down` and `reset` of a shared environment want that). */
export const HOST_FLAG = fromArgs.flag;
export const remote = Boolean(HOST);

// Short paths in /tmp: a Unix socket path is limited to ~104 bytes on macOS.
const slug = HOST.replace(/[^\w@.-]/g, "_");
const CONTROL = `/tmp/ghostly-e2e-ssh-${slug}`;
export const SOCKET = `/tmp/ghostly-e2e-docker-${slug}.sock`;
const BASE = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
const ssh = (args, options = {}) => spawnSync("ssh", [...BASE, ...args], { encoding: "utf8", ...options });
const quote = (arg) => `'${String(arg).replaceAll("'", "'\\''")}'`;

/**
 * `docker exec <container> <args>` on the host, over the background connection (a fresh one of its own if that
 * is down). Same contract as execFileSync: the output, or a throw with `stderr` on failure.
 */
export const exec = (container, args, options) =>
  execFileSync("ssh", [...BASE, "-S", CONTROL, HOST, ["docker", "exec", container, ...args].map(quote).join(" ")], options);

/** Whether the background connection is up. */
export const connected = () => ssh(["-S", CONTROL, "-O", "check", HOST], { stdio: "ignore" }).status === 0;

/** The background connection, started unless it runs: the host's Docker socket forwarded to SOCKET. */
export function connect() {
  if (connected()) return "running";
  const started = ssh(["-f", "-N", "-M", "-S", CONTROL, "-o", "ControlPersist=yes", "-o", "ExitOnForwardFailure=yes",
    "-o", "StreamLocalBindUnlink=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
    "-L", `${SOCKET}:/var/run/docker.sock`, HOST]);
  if (started.status !== 0) throw new Error(`Could not connect to ${HOST}: ${(started.stderr ?? "").trim()}`);
  return "started";
}

export const disconnect = () => { ssh(["-S", CONTROL, "-O", "exit", HOST], { stdio: "ignore" }); };

/**
 * Forwards ports of 127.0.0.1 here ([local, published] pairs) to the host's published ports, over the background
 * connection; returns the local ones that could not be (held by something here: a local environment). Forwarding
 * one again is harmless.
 */
export function forward(pairs) {
  return pairs.filter(([local, port]) => ssh(["-S", CONTROL, "-O", "forward", "-L", `127.0.0.1:${local}:${process.env.E2E_INFRA_ADDRESS}:${port}`, HOST], { stdio: "ignore" }).status !== 0).map(([local]) => local);
}

/** A Tailscale address (100.64.0.0/10): the only kind this module binds to without being told. */
const tailscale = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(ip);

function address() {
  const given = process.env.E2E_INFRA_ADDRESS;
  if (given) {
    if (given === "0.0.0.0" || given === "::") throw new Error("E2E_INFRA_ADDRESS must be one interface, not every one");
    return given;
  }
  const found = ssh(["-S", CONTROL, HOST, "tailscale", "ip", "-4"]);
  const ip = (found.stdout ?? "").split("\n")[0].trim();
  if (found.status !== 0 || !tailscale(ip)) {
    throw new Error(`Could not read ${HOST}'s Tailscale address (${(found.stderr ?? "").trim() || ip || "no answer"}); set E2E_INFRA_ADDRESS`);
  }
  return ip;
}

/** This machine's own Docker (whatever DOCKER_HOST was before this module pointed it elsewhere), for `docker` here. */
export const LOCAL_DOCKER = { ...process.env };

if (remote && main) {
  connect();
  process.env.E2E_INFRA_HOST = HOST;
  process.env.E2E_INFRA_ADDRESS = address();
  process.env.DOCKER_HOST = `unix://${SOCKET}`;
}
