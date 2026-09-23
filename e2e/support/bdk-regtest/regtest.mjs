#!/usr/bin/env node
// Drives the disposable BDK regtest stack in docker-compose.yml: worthless coins only.
//   node e2e/support/bdk-regtest/regtest.mjs ready                 a miner wallet with coins, Esplora caught up
//   node e2e/support/bdk-regtest/regtest.mjs send <addr> <sats>    the miner pays an address and mines a block
//   node e2e/support/bdk-regtest/regtest.mjs address               an address of the miner's (someone else's)
//   node e2e/support/bdk-regtest/regtest.mjs mine [blocks]
//   node e2e/support/bdk-regtest/regtest.mjs tx <txid>             bitcoind's view of a transaction (evidence)
import { execFileSync } from "node:child_process";

export const BDK_REGTEST = { esplora: "http://127.0.0.1:44202" };
const cli = (...args) => execFileSync("docker", ["exec", "ghostly-bdk-bitcoind", "bitcoin-cli", "-regtest", "-rpcuser=ghostly", "-rpcpassword=bdk", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const miner = (...args) => cli("-rpcwallet=miner", ...args);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves once the Esplora server has indexed bitcoind's tip. */
export async function synced() {
  const height = cli("getblockcount");
  for (let i = 0; i < 60; i++) {
    const tip = await fetch(`${BDK_REGTEST.esplora}/blocks/tip/height`).then((r) => r.text()).catch(() => "");
    if (tip === height) return Number(height);
    await wait(500);
  }
  throw new Error(`Esplora did not reach height ${height}`);
}
export function mine(blocks = 1) { miner("generatetoaddress", String(blocks), miner("getnewaddress")); }
export async function ready() {
  if (!JSON.parse(cli("listwallets")).includes("miner")) { try { cli("loadwallet", "miner"); } catch { cli("createwallet", "miner"); } }
  if (Number(miner("getbalance")) < 50) mine(101);
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
