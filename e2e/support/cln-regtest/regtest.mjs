#!/usr/bin/env node
// Drives the Core Lightning part of e2e/infra (two nodes, alice and bob, on the regtest chain): worthless coins only.
//   node e2e/support/cln-regtest/regtest.mjs ready     mine, fund both nodes, open a channel alice → bob (both sides can spend)
//   node e2e/support/cln-regtest/regtest.mjs mine [blocks]
//   node e2e/support/cln-regtest/regtest.mjs status    both nodes: id, channel state, spendable sats
//   node e2e/support/cln-regtest/regtest.mjs pay <node> <bolt11>   that node pays an invoice
// Tests import `CLN_REGTEST` and `rune()` from here. A rune is made on demand, handed to the caller and
// never printed: `rune()` returns it, it does not log it.
import { fileURLToPath } from "node:url";
import { container, endpoints } from "../../infra/env.mjs";
import { cli, ensureMiner, height, mine, miner, run, until } from "../../infra/chain.mjs";

export { mine };
export const CLN_REGTEST = {
  alice: { container: container("cln-alice"), service: "cln-alice", websocket: endpoints.cln.alice },
  bob: { container: container("cln-bob"), service: "cln-bob", websocket: endpoints.cln.bob },
};
/** What a Ghostly source may call, and nothing else: what the rune of the provider's form should allow. */
export const GHOSTLY_METHODS = ["getinfo", "invoice", "listinvoices", "xpay", "pay", "listpays", "listfunds"];

const ln = (node, ...args) => JSON.parse(run(CLN_REGTEST[node].service, ["lightning-cli", "--network=regtest", ...args]).split("\n").filter((line) => !line.startsWith("#")).join("\n") || "null");

export const nodeId = (node) => ln(node, "getinfo").id;
// Other suites mine on the same chain: caught up means at least the height asked about.
const synced = (node) => { const info = ln(node, "getinfo"); return !info.warning_bitcoind_sync && !info.warning_lightningd_sync && info.blockheight >= height() - 1; };
const channel = (node) => ln(node, "listpeerchannels").channels.find((c) => c.state === "CHANNELD_NORMAL");

/** A rune restricted to what Ghostly calls, made fresh on the node. Handed back, never printed. */
export function rune(node, methods = GHOSTLY_METHODS) {
  const restrictions = JSON.stringify([methods.map((method) => `method=${method}`)]);
  return ln(node, "createrune", `restrictions=${restrictions}`).rune;
}

/** An invoice of this node for `sats`, for someone else to pay. */
export function invoice(node, sats, description = "ghostly e2e") {
  return ln(node, "invoice", `amount_msat=${sats * 1000}`, `label=e2e-${crypto.randomUUID()}`, `description=${description}`).bolt11;
}

/** This node pays an invoice (the counterpart's side of a test). */
export function pay(node, bolt11) {
  return ln(node, "xpay", `invstring=${bolt11}`);
}

/** Sats on this node's side of its normal channels (`listfunds`): what a Ghostly source shows as its balance. */
export function channelBalance(node) {
  return ln(node, "listfunds").channels.filter((c) => c.state === "CHANNELD_NORMAL").reduce((sum, c) => sum + Math.floor(c.our_amount_msat / 1000), 0);
}

/** Spendable sats over this node's channels in the normal state. */
export function spendable(node) {
  return ln(node, "listpeerchannels").channels.filter((c) => c.state === "CHANNELD_NORMAL").reduce((sum, c) => sum + Math.floor(c.spendable_msat / 1000), 0);
}

export async function ready() {
  ensureMiner();
  if (channel("alice") && channel("bob")) return;
  for (const node of ["alice", "bob"]) {
    const funds = ln(node, "listfunds").outputs.filter((o) => o.status === "confirmed").reduce((sum, o) => sum + o.amount_msat, 0);
    if (funds < 2_000_000_000) miner("sendtoaddress", (({ p2tr, bech32 }) => p2tr ?? bech32)(ln(node, "newaddr")), "0.05");
  }
  mine(6);
  await until("the nodes to see their funds", () => synced("alice") && synced("bob") && ln("alice", "listfunds").outputs.some((o) => o.status === "confirmed"));
  const bob = nodeId("bob");
  ln("alice", "connect", `${bob}@cln-bob:9735`);
  // A closed channel (ONCHAIN, CLOSINGD_*) stays listed: only one that is open or opening counts.
  const live = (c) => /^(CHANNELD_NORMAL|CHANNELD_AWAITING_LOCKIN|DUALOPEND_|OPENINGD)/.test(c.state);
  if (!ln("alice", "listpeerchannels").channels.some(live)) ln("alice", "fundchannel", `id=${bob}`, "amount=1000000", "push_msat=400000000", "announce=true");
  await until("the funding transaction in the mempool", () => Number(JSON.parse(cli("getmempoolinfo")).size) > 0, { tries: 20 }).catch(() => {});
  mine(6);
  await until("the channel to be usable on both sides", () => { mine(1); return !!channel("alice") && !!channel("bob"); });
}

export function status() {
  return Object.fromEntries(["alice", "bob"].map((node) => [node, { id: nodeId(node), channel: channel(node)?.state ?? "none", spendable: spendable(node) }]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, arg] = process.argv.slice(2);
  if (command === "ready") { await ready(); console.log(JSON.stringify(status(), null, 2)); }
  else if (command === "mine") mine(Number(arg ?? 1));
  else if (command === "pay") console.log(JSON.stringify(pay(arg, process.argv[4])));
  else if (command === "status") console.log(JSON.stringify(status(), null, 2));
  else { console.error("Usage: regtest.mjs ready | mine [blocks] | status | pay <node> <bolt11>"); process.exit(1); }
}
