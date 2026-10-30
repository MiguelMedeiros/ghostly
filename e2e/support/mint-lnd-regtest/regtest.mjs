#!/usr/bin/env node
// Drives the mint-on-LND part of e2e/infra: mintd on a regtest LND node, and a peer with a channel to it (half pushed,
// so Lightning goes in and out of the mint). Worthless coins only.
//   node e2e/support/mint-lnd-regtest/regtest.mjs ready             mine, fund the node, open node → peer
//   node e2e/support/mint-lnd-regtest/regtest.mjs invoice [sats]    an invoice of the peer, with no amount when none is given
//   node e2e/support/mint-lnd-regtest/regtest.mjs pay <invoice>     the peer pays an invoice (a mint quote's)
//   node e2e/support/mint-lnd-regtest/regtest.mjs lookup <hash>     the peer's invoice of that hash
import { ensureMiner, mine, miner, retry, run, until } from "../../infra/chain.mjs";

const lncli = (node, ...args) => JSON.parse(run(node, ["lncli", "--network=regtest", ...args]));
const NODES = ["mint-lnd", "mint-lnd-peer"];

export async function ready() {
  ensureMiner();
  const synced = async () => { for (const node of NODES) await until(`${node} synced`, () => lncli(node, "getinfo").synced_to_chain); };
  await synced();
  const peer = lncli("mint-lnd-peer", "getinfo").identity_pubkey;
  const up = () => lncli("mint-lnd", "listchannels").channels.some((c) => c.remote_pubkey === peer && c.active)
    && lncli("mint-lnd-peer", "listchannels").channels.some((c) => c.active);
  if (!up()) {
    if (Number(lncli("mint-lnd", "walletbalance").confirmed_balance) < 3_000_000) {
      miner("sendtoaddress", lncli("mint-lnd", "newaddress", "p2tr").address, "0.05");
      mine(1);
      await until("the node's coins", () => Number(lncli("mint-lnd", "walletbalance").confirmed_balance) >= 3_000_000);
    }
    if (!lncli("mint-lnd", "listpeers").peers.some((p) => p.pub_key === peer)) lncli("mint-lnd", "connect", `${peer}@mint-lnd-peer:9735`);
    if (!lncli("mint-lnd", "pendingchannels").pending_open_channels.length) {
      await retry("opening the node's channel", () => lncli("mint-lnd", "openchannel", "--node_key", peer, "--local_amt", "2000000", "--push_amt", "1000000"), { before: synced });
    }
    mine(6);
    // A funding transaction that reached the mempool after those blocks confirms only with more of them.
    let polls = 0;
    await until("the channel", () => { if (up()) return true; if (++polls % 5 === 0) mine(1); return false; });
    // Both sides need to see the channel in their graph before they route over it.
    mine(1);
  }
  return { channel: true };
}

/** An invoice of the peer. With no `sats`, one with no amount: the payer chooses. */
export const invoice = (sats = 0, memo = "mint regtest") => lncli("mint-lnd-peer", "addinvoice", "--amt", String(sats), "--memo", memo);
export const pay = (request) => lncli("mint-lnd-peer", "payinvoice", "--force", "--json", request);
export const lookup = (hash) => lncli("mint-lnd-peer", "lookupinvoice", hash);

const [command, ...args] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === "ready") console.log(JSON.stringify(await ready()));
  else if (command === "invoice") console.log(JSON.stringify(invoice(Number(args[0] ?? 0))));
  else if (command === "pay") { const p = pay(args[0]); console.log(JSON.stringify({ status: p.status, hash: p.payment_hash, fee: p.fee_sat })); }
  else if (command === "lookup") console.log(JSON.stringify(lookup(args[0])));
  else { console.error("usage: regtest.mjs ready | invoice [sats] | pay <invoice> | lookup <hash>"); process.exit(2); }
}
