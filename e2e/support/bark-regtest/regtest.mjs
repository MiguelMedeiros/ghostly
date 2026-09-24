#!/usr/bin/env node
// Drives the Bark (Second's Ark) part of e2e/infra: captaind and a funder wallet on the regtest chain, worthless coins only.
//   node e2e/support/bark-regtest/regtest.mjs ready        fund the server and a funder wallet, board it
//   node e2e/support/bark-regtest/regtest.mjs pay <addr> <sats>   the funder pays an Ark address
//   node e2e/support/bark-regtest/regtest.mjs send-onchain <addr> <sats>   bitcoind pays an on-chain address
//   node e2e/support/bark-regtest/regtest.mjs mine [blocks]
//   node e2e/support/bark-regtest/regtest.mjs balance      the funder's balance
import { endpoints } from "../../infra/env.mjs";
import { ensureMiner, mine, miner, retry, run, until, wait } from "../../infra/chain.mjs";

export { mine };
export const BARK_REGTEST = { server: endpoints.bark.server, esplora: endpoints.bark.esplora };
const bark = (...args) => run("bark-funder", ["bark", "--no-logfile", "-q", ...args]);
const json = (text) => JSON.parse(text);

export async function ready() {
  ensureMiner();
  // The server needs on-chain funds for rounds and its VTXO pool.
  // captaind listens before its wallet answers (it syncs first): ask until it does.
  const server = (await until("captaind's wallet", () => json(run("bark-captaind", ["captaind", "rpc", "wallet"])), { tries: 180 })).rounds;
  if (server.total_balance < 100_000_000) { miner("sendtoaddress", server.address, "5"); mine(1); }
  // The funder: a bark CLI wallet on the same server, boarded, so it can pay test addresses over Ark.
  await retry("the funder wallet", () => {
    try { bark("config"); } catch {
      bark("create", "--regtest", "--ark", "http://bark-captaind:3535", "--bitcoind", "http://bitcoind:18443",
        "--bitcoind-user", endpoints.bitcoind.user, "--bitcoind-pass", endpoints.bitcoind.password);
    }
  }, { tries: 30 });
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
