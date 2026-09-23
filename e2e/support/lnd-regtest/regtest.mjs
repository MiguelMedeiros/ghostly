#!/usr/bin/env node
// Drives the disposable LND regtest stack in docker-compose.yml: worthless coins only, never a real node.
//   node e2e/support/lnd-regtest/regtest.mjs ready                 mine, fund Alice, open Alice→Bob (half pushed to Bob), bake the scoped macaroons
//   node e2e/support/lnd-regtest/regtest.mjs invoice <node> <sats>  an invoice of that node (alice | bob)
//   node e2e/support/lnd-regtest/regtest.mjs pay <node> <invoice>   that node pays an invoice
//   node e2e/support/lnd-regtest/regtest.mjs balance <node>         its channel balance, in sats
//   node e2e/support/lnd-regtest/regtest.mjs mine [blocks]
// Nothing here prints a macaroon or a certificate: `credentials()` hands them to a test in memory.
import { execFileSync } from "node:child_process";

export const LND_REGTEST = { alice: "https://127.0.0.1:44710", bob: "https://127.0.0.1:44720" };
/** What the scoped macaroon may do: the provider's calls, nothing on-chain, no admin. */
export const SCOPE = ["info:read", "invoices:read", "invoices:write", "offchain:read", "offchain:write"];
const MACAROON = "/root/.lnd/ghostly-scoped.macaroon.hex";

const run = (container, args) => execFileSync("docker", ["exec", container, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 20 }).trim();
const container = (node) => { if (!(node in LND_REGTEST)) throw new Error(`No node ${node}`); return `ghostly-lnd-${node}`; };
export const lncli = (node, ...args) => JSON.parse(run(container(node), ["lncli", "--network=regtest", ...args]));
const cli = (...args) => run("ghostly-lnd-bitcoind", ["bitcoin-cli", "-regtest", "-rpcuser=ghostly", "-rpcpassword=regtest", ...args]);
const miner = (...args) => cli("-rpcwallet=miner", ...args);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function mine(blocks = 1) { miner("generatetoaddress", String(blocks), miner("getnewaddress")); }

async function until(what, check, tries = 60) {
  for (let i = 0; i < tries; i++) { if (await check()) return; await wait(1000); }
  throw new Error(`Timed out waiting for ${what}`);
}

export async function ready() {
  if (!JSON.parse(cli("listwallets")).includes("miner")) {
    try { cli("loadwallet", "miner"); } catch { cli("createwallet", "miner"); }
  }
  if (Number(miner("getbalance")) < 50) mine(101);
  for (const node of ["alice", "bob"]) await until(`${node} synced`, () => lncli(node, "getinfo").synced_to_chain);

  const bob = lncli("bob", "getinfo").identity_pubkey;
  if (!lncli("alice", "listchannels").channels.some((c) => c.remote_pubkey === bob && c.active)) {
    if (Number(lncli("alice", "walletbalance").confirmed_balance) < 2_000_000) {
      miner("sendtoaddress", lncli("alice", "newaddress", "p2tr").address, "0.05");
      mine(1);
      await until("Alice's coins", () => Number(lncli("alice", "walletbalance").confirmed_balance) >= 2_000_000);
    }
    if (!lncli("alice", "listpeers").peers.some((p) => p.pub_key === bob)) lncli("alice", "connect", `${bob}@bob:9735`);
    if (!lncli("alice", "pendingchannels").pending_open_channels.length) lncli("alice", "openchannel", "--node_key", bob, "--local_amt", "1000000", "--push_amt", "500000");
    mine(6);
    await until("the channel", () => lncli("alice", "listchannels").channels.some((c) => c.remote_pubkey === bob && c.active)
      && lncli("bob", "listchannels").channels.some((c) => c.active));
    // Both sides need to see the channel in their graph before they route over it.
    mine(1);
  }
  for (const node of ["alice", "bob"]) {
    try { run(container(node), ["test", "-s", MACAROON]); } catch {
      run(container(node), ["sh", "-c", `lncli --network=regtest bakemacaroon ${SCOPE.join(" ")} > ${MACAROON}`]);
    }
  }
  return { alice: balance("alice"), bob: balance("bob") };
}

/** A node's REST address, scoped macaroon (hex) and TLS certificate (PEM), for a test to use in memory. */
export function credentials(node) {
  return { url: LND_REGTEST[node], macaroon: run(container(node), ["cat", MACAROON]), cert: run(container(node), ["cat", "/root/.lnd/tls.cert"]) };
}

export const balance = (node) => Number(lncli(node, "channelbalance").local_balance.sat);
/** No HTLC left on the node's channels: its balance no longer carries an HTLC's share of the commitment fee. */
export const settled = (node) => lncli(node, "listchannels").channels.every((c) => !c.pending_htlcs?.length) && !Number(lncli(node, "channelbalance").unsettled_local_balance?.sat ?? 0);
export const invoice = (node, sats, memo = "regtest") => lncli(node, "addinvoice", "--amt", String(sats), "--memo", memo).payment_request;
export const pay = (node, request) => lncli(node, "payinvoice", "--force", "--json", request);
export const lookupInvoice = (node, hash) => lncli(node, "lookupinvoice", hash);

const [command, ...args] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === "ready") console.log(JSON.stringify({ ...LND_REGTEST, balances: await ready() }));
  else if (command === "invoice") console.log(invoice(args[0], Number(args[1])));
  else if (command === "pay") { const p = pay(args[0], args[1]); console.log(JSON.stringify({ status: p.status, hash: p.payment_hash, fee: p.fee_sat })); }
  else if (command === "balance") console.log(balance(args[0]));
  else if (command === "mine") mine(Number(args[0] ?? 1));
  else { console.error("usage: regtest.mjs ready | invoice <node> <sats> | pay <node> <invoice> | balance <node> | mine [n]"); process.exit(2); }
}
