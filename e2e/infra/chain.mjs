// The regtest chain every Bitcoin service of e2e/infra runs on, as the support scripts drive it: `docker exec`
// into the environment's containers (here, or over SSH on E2E_INFRA_HOST), a "miner" wallet in bitcoind that
// pays for everything. Worthless coins.
import { execFileSync } from "node:child_process";
import { docker, remote } from "./remote.mjs";
import { container, endpoints } from "./env.mjs";

/** Runs a command in one of the environment's containers (by service name) and returns its trimmed output. */
export function run(service, args) {
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 22 };
  const command = ["exec", container(service), ...args];
  return (remote ? docker(command, options) : execFileSync("docker", command, options)).trim();
}

export const cli = (...args) => run("bitcoind", ["bitcoin-cli", "-regtest", `-rpcuser=${endpoints.bitcoind.user}`, `-rpcpassword=${endpoints.bitcoind.password}`, ...args]);
export const miner = (...args) => cli("-rpcwallet=miner", ...args);
export const height = () => Number(cli("getblockcount"));
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function mine(blocks = 1) { miner("generatetoaddress", String(blocks), miner("getnewaddress")); }

/**
 * The miner wallet, loaded and able to pay: made on first use, and given mature coinbases whenever it runs low.
 * Several suites pay from it at once, so it keeps many coins rather than one large one.
 */
export function ensureMiner() {
  if (!JSON.parse(cli("listwallets")).includes("miner")) {
    try { cli("loadwallet", "miner"); } catch { try { cli("createwallet", "miner"); } catch { cli("loadwallet", "miner"); } }
  }
  if (Number(miner("getbalance")) < 50) mine(height() < 200 ? 200 : 101);
}

/** Pays `sats` to an address from the miner; returns the txid (unconfirmed: mine to confirm it). */
export const pay = (address, sats) => miner("sendtoaddress", address, (sats / 1e8).toFixed(8));

/** Resolves once the environment's Esplora has indexed at least bitcoind's current tip. */
export async function esploraSynced(esplora = endpoints.esplora) {
  const target = height();
  for (let i = 0; i < 120; i++) {
    const tip = await fetch(`${esplora}/blocks/tip/height`).then((r) => r.text()).catch(() => "");
    // Other suites mine on the same chain: at least the height asked for, not exactly it.
    if (tip && Number(tip) >= target) return Number(tip);
    await wait(500);
  }
  throw new Error(`Esplora did not reach height ${target}`);
}

/** Polls `check` once a second until it returns something truthy (errors count as "not yet"). */
export async function until(what, check, { tries = 90, every = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const value = await check(); if (value) return value; } catch { /* not yet */ }
    await wait(every);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Runs `work` until it succeeds, `before` first each time: opening a channel fails while either side is still
 * catching up with blocks another suite just mined, and succeeds once both are synced.
 */
export async function retry(what, work, { tries = 10, before = async () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    await before();
    try { return await work(); } catch (error) {
      if (attempt >= tries) throw new Error(`${what} failed ${tries} times: ${String(error.stderr || error.message).trim()}`);
      await wait(2000);
    }
  }
}
