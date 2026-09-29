#!/usr/bin/env node
// Drives the on-chain part of e2e/infra for the BDK tests: the regtest chain and its Esplora, worthless coins only.
//   node e2e/support/bdk-regtest/regtest.mjs ready                 a miner wallet with coins, Esplora caught up
//   node e2e/support/bdk-regtest/regtest.mjs send <addr> <sats>    the miner pays an address and mines a block
//   node e2e/support/bdk-regtest/regtest.mjs address               an address of the miner's (someone else's)
//   node e2e/support/bdk-regtest/regtest.mjs mine [blocks]
//   node e2e/support/bdk-regtest/regtest.mjs tx <txid>             bitcoind's view of a transaction (evidence)
import { endpoints } from "../../infra/env.mjs";
import { cli, ensureMiner, esploraSynced, mine, miner } from "../../infra/chain.mjs";

export { mine };
export const BDK_REGTEST = { esplora: endpoints.esplora };

/** Resolves once the Esplora server has indexed bitcoind's tip. */
export const synced = () => esploraSynced(BDK_REGTEST.esplora);
export async function ready() {
  ensureMiner();
  return { ...BDK_REGTEST, height: await synced(), miner: Number(miner("getbalance")) };
}
/** Pays an address and confirms it; returns the txid. */
export async function send(address, sats) {
  const txid = miner("sendtoaddress", address, (sats / 1e8).toFixed(8));
  mine(1);
  await synced();
  return txid;
}
export const address = () => miner("getnewaddress");
export const tx = (txid) => JSON.parse(cli("getrawtransaction", txid, "1"));

const [command, ...args] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === "ready") console.log(JSON.stringify(await ready()));
  else if (command === "send") console.log(await send(args[0], Number(args[1])));
  else if (command === "address") console.log(address());
  else if (command === "mine") { mine(Number(args[0] ?? 1)); console.log(await synced()); }
  else if (command === "tx") { const t = tx(args[0]); console.log(JSON.stringify({ txid: t.txid, confirmations: t.confirmations ?? 0, vout: t.vout.map((o) => ({ sats: Math.round(o.value * 1e8), address: o.scriptPubKey.address })) })); }
  else { console.error("usage: regtest.mjs ready | send <address> <sats> | address | mine [n] | tx <txid>"); process.exit(2); }
}
