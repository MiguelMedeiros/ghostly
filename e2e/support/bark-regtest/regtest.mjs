#!/usr/bin/env node
// Drives the disposable Bark regtest stack in docker-compose.yml: worthless coins only.
//   node e2e/support/bark-regtest/regtest.mjs ready        mine, fund the server and a funder wallet, board it
//   node e2e/support/bark-regtest/regtest.mjs pay <addr> <sats>   the funder pays an Ark address
//   node e2e/support/bark-regtest/regtest.mjs send-onchain <addr> <sats>   bitcoind pays an on-chain address
//   node e2e/support/bark-regtest/regtest.mjs mine [blocks]
//   node e2e/support/bark-regtest/regtest.mjs balance      the funder's balance
import { execFileSync } from "node:child_process";

export const BARK_REGTEST = { server: "http://127.0.0.1:44135", esplora: "http://127.0.0.1:44102" };
const run = (container, args) => execFileSync("docker", ["exec", container, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cli = (...args) => run("ghostly-bark-bitcoind", ["bitcoin-cli", "-regtest", "-rpcuser=second", "-rpcpassword=ark", ...args]);
const miner = (...args) => cli("-rpcwallet=miner", ...args);
const bark = (...args) => run("ghostly-bark-funder", ["bark", "--no-logfile", "-q", ...args]);
const json = (text) => JSON.parse(text);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function mine(blocks = 1) { miner("generatetoaddress", String(blocks), miner("getnewaddress")); }

function ensureMiner() {
  if (!json(cli("listwallets")).includes("miner")) {
    try { cli("loadwallet", "miner"); } catch { cli("createwallet", "miner"); }
  }
  if (Number(miner("getbalance")) < 50) mine(101);
}

export async function ready() {
  ensureMiner();
  // The server needs on-chain funds for rounds and its VTXO pool.
  const server = json(run("ghostly-bark-captaind", ["captaind", "rpc", "wallet"])).rounds;
  if (server.total_balance < 100_000_000) { miner("sendtoaddress", server.address, "5"); mine(1); }
  // The funder: a bark CLI wallet on the same server, boarded, so it can pay test addresses over Ark.
  try { bark("config"); } catch {
    bark("create", "--regtest", "--ark", "http://captaind:3535", "--bitcoind", "http://bitcoind:18443", "--bitcoind-user", "second", "--bitcoind-pass", "ark");
  }
  const balance = () => json(bark("balance"));
  if (balance().spendable_sat < 200_000) {
    miner("sendtoaddress", json(bark("onchain", "address")).address, "0.01");
    mine(1);
    bark("board", "900000sat");
    for (let i = 0; i < 30 && balance().spendable_sat < 200_000; i++) { mine(1); await wait(1000); try { bark("maintain"); } catch { /* next block */ } }
  }
  if (balance().spendable_sat < 200_000) throw new Error("The funder did not board");
  return balance();
}

/** The funder pays an Ark address; returns that movement (status, VTXO ids) as evidence. */
export function pay(address, sats) {
  bark("send", address, `${sats}sat`);
  const last = json(bark("history")).at(-1);
  return { status: last.status, kind: last.subsystem.kind, sat: last.intended_balance_sat, vtxos: last.output_vtxos };
}

const [command, ...args] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === "ready") console.log(JSON.stringify({ ...BARK_REGTEST, funder: await ready() }));
  else if (command === "pay") console.log(JSON.stringify(pay(args[0], Number(args[1]))));
  else if (command === "send-onchain") { ensureMiner(); console.log(miner("sendtoaddress", args[0], (Number(args[1]) / 1e8).toFixed(8))); mine(1); }
  else if (command === "mine") mine(Number(args[0] ?? 1));
  else if (command === "balance") console.log(bark("balance"));
  else { console.error("usage: regtest.mjs ready | pay <address> <sats> | send-onchain <address> <sats> | mine [n] | balance"); process.exit(2); }
}
