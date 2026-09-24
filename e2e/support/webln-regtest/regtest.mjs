#!/usr/bin/env node
// Drives the WebLN part of e2e/infra (two LND nodes behind the injected browser wallets): worthless coins only.
//   node e2e/support/webln-regtest/regtest.mjs ready      mine, fund both LND nodes, open a channel alice → bob (half pushed)
//   node e2e/support/webln-regtest/regtest.mjs mine [blocks]
//   node e2e/support/webln-regtest/regtest.mjs balance    both nodes' channel balances
// Nothing here prints a macaroon: the tests read them from the containers into memory (support/webln.ts).
import { endpoints } from "../../infra/env.mjs";
import { ensureMiner, mine, miner, retry, run, wait } from "../../infra/chain.mjs";

export { mine };
export const WEBLN_REGTEST = { alice: endpoints.webln.alice, bob: endpoints.webln.bob };
const lncli = (node, ...args) => JSON.parse(run(`webln-${node}`, ["lncli", "--network=regtest", ...args]));

async function until(what, check, tries = 60) {
  for (let i = 0; i < tries; i++) { if (await check()) return; await wait(1000); }
  throw new Error(`Timed out waiting for ${what}`);
}

const synced = (node) => { try { return lncli(node, "getinfo").synced_to_chain; } catch { return false; } };

export async function ready() {
  ensureMiner();
  for (const node of ["alice", "bob"]) await until(`${node} to sync`, () => { mine(1); return synced(node); });
  // On-chain funds for both, so either can open a channel later if a test wants one.
  for (const node of ["alice", "bob"]) {
    if (Number(lncli(node, "walletbalance").confirmed_balance) < 5_000_000) miner("sendtoaddress", lncli(node, "newaddress", "p2wkh").address, "0.1");
  }
  mine(6);
  const bob = lncli("bob", "getinfo").identity_pubkey;
  if (!lncli("alice", "listpeers").peers.some((p) => p.pub_key === bob)) lncli("alice", "connect", `${bob}@webln-bob:9735`);
  const channels = () => lncli("alice", "listchannels").channels.filter((c) => c.remote_pubkey === bob);
  if (!channels().length && !lncli("alice", "pendingchannels").pending_open_channels.length) {
    await until("alice to see her funds", () => Number(lncli("alice", "walletbalance").confirmed_balance) >= 5_000_000);
    // 2M sats, half on each side: both people can pay and be paid.
    const bothSynced = async () => { for (const node of ["alice", "bob"]) await until(`${node} to sync`, () => synced(node)); };
    await retry("opening alice's channel", () => lncli("alice", "openchannel", "--node_key", bob, "--local_amt", "2000000", "--push_amt", "1000000"), { before: bothSynced });
  }
  await until("the channel to open", () => { mine(1); return channels().some((c) => c.active); });
  // Both need the channel in their graph to route over it (invoices carry no route hints on a public channel).
  await until("bob to see it active", () => lncli("bob", "listchannels").channels.some((c) => c.active));
  return balance();
}

export function balance() {
  return Object.fromEntries(["alice", "bob"].map((node) => [node, Number(lncli(node, "channelbalance").local_balance?.sat ?? 0)]));
}

const [command, ...args] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === "ready") console.log(JSON.stringify({ ...WEBLN_REGTEST, balances: await ready() }));
  else if (command === "mine") { ensureMiner(); mine(Number(args[0] ?? 1)); }
  else if (command === "balance") console.log(JSON.stringify(balance()));
  else { console.error("usage: regtest.mjs ready | mine [n] | balance"); process.exit(2); }
}
