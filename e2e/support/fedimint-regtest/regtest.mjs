#!/usr/bin/env node
// Drives the Fedimint part of e2e/infra: a one-guardian federation on the regtest chain, its LND-backed gateway, and
// an LND peer with a channel to the gateway's node (Lightning in and out of the federation). Worthless coins only.
//   node e2e/support/fedimint-regtest/regtest.mjs ready            set the federation up (DKG), connect the gateway,
//                                                                   open peer → gateway (half pushed), print the invite
//   node e2e/support/fedimint-regtest/regtest.mjs invite           the federation's invite code
//   node e2e/support/fedimint-regtest/regtest.mjs pay <invoice>    the peer pays an invoice (a federation's, through the gateway)
//   node e2e/support/fedimint-regtest/regtest.mjs invoice <sats>   an invoice of the peer (for the federation to pay)
//   node e2e/support/fedimint-regtest/regtest.mjs lookup <hash>    whether the peer's invoice of that hash is settled
// The admin and gateway passwords are test-only (docker-compose.yml); nothing here prints a secret of a wallet.
import { endpoints } from "../../infra/env.mjs";
import { ensureMiner, mine, miner, retry, run, until } from "../../infra/chain.mjs";

export { mine };
const PASSWORD = "ghostly-fedimint-regtest";
/** The guardian's API as every container of the federation sees it (the port is the same inside and out). */
const API = "ws://127.0.0.1:47140";
const GATEWAY = "http://127.0.0.1:47141";

const fedimintCli = (...args) => run("fedimintd", ["fedimint-cli", "--password", PASSWORD, ...args]);
const setup = (...args) => fedimintCli("admin", "setup", API, ...args);
const gatewayCli = (...args) => JSON.parse(run("fedimint-gateway", ["gateway-cli", "--address", GATEWAY, "--rpcpassword", PASSWORD, ...args]));
const lncli = (node, ...args) => JSON.parse(run(node, ["lncli", "--network=regtest", ...args]));
const peer = (...args) => lncli("fedimint-lnd-peer", ...args);
const gatewayNode = (...args) => lncli("fedimint-lnd", ...args);

/** The invite code, once the federation is set up (fedimintd writes it next to its config). */
export const invite = () => run("fedimintd", ["cat", "/data/invite-code"]);

async function federation() {
  try { return invite(); } catch { /* not set up yet */ }
  await until("the guardian's setup API", () => setup("status"), { tries: 120 });
  const status = setup("status");
  if (/AwaitingLocalParams|awaiting_local_params/i.test(status)) {
    setup("set-local-params", "ghostly-guardian", "--federation-name", "Ghostly regtest", "--federation-size", "1");
  }
  if (!/Consensus|running/i.test(setup("status"))) {
    try { setup("start-dkg"); } catch (error) { if (!/already|started|Consensus/i.test(String(error.stderr ?? error.message))) throw error; }
  }
  return until("the invite code", () => invite(), { tries: 180 });
}

export async function ready() {
  ensureMiner();
  const code = await federation();

  // The gateway serves the federation (LNv1: it registers itself in the federation's consensus).
  if (!(gatewayCli("info").federations ?? []).length) {
    await retry("connecting the gateway to the federation", async () => gatewayCli("connect-fed", code));
  }

  // Lightning in and out: the peer opens a channel to the gateway's node and pushes half, so both directions route.
  for (const node of ["fedimint-lnd", "fedimint-lnd-peer"]) await until(`${node} synced`, () => lncli(node, "getinfo").synced_to_chain);
  const gateway = gatewayNode("getinfo").identity_pubkey;
  if (!peer("listchannels").channels.some((c) => c.remote_pubkey === gateway && c.active)) {
    if (Number(peer("walletbalance").confirmed_balance) < 3_000_000) {
      miner("sendtoaddress", peer("newaddress", "p2tr").address, "0.05");
      mine(1);
      await until("the peer's coins", () => Number(peer("walletbalance").confirmed_balance) >= 3_000_000);
    }
    if (!peer("listpeers").peers.some((p) => p.pub_key === gateway)) peer("connect", `${gateway}@fedimint-lnd:9735`);
    const synced = async () => { for (const node of ["fedimint-lnd", "fedimint-lnd-peer"]) await until(`${node} synced`, () => lncli(node, "getinfo").synced_to_chain); };
    if (!peer("pendingchannels").pending_open_channels.length) {
      await retry("opening the peer's channel", () => peer("openchannel", "--node_key", gateway, "--local_amt", "2000000", "--push_amt", "1000000"), { before: synced });
    }
    mine(6);
    await until("the channel", () => peer("listchannels").channels.some((c) => c.remote_pubkey === gateway && c.active)
      && gatewayNode("listchannels").channels.some((c) => c.active));
    mine(1);
  }
  // LNv1: the gateway funds a payment into the federation with ecash of its own, so it needs some (a peg-in).
  const federationId = gatewayCli("info").federations?.[0]?.federation_id;
  const ecash = () => Number(gatewayCli("get-balances").ecash_balances?.find((b) => b.federation_id === federationId)?.ecash_balance_msats ?? 0);
  if (ecash() < 2_000_000_000) {
    const address = gatewayCli("ecash", "pegin", "--federation-id", federationId).address;
    miner("sendtoaddress", address, "0.05");
    // The federation counts a deposit once its consensus block count (the tip minus a finality delay of ~10,
    // agreed about once a minute) passes it: a block now and then until it does.
    mine(12);
    let polls = 0;
    await until("the gateway's ecash", () => { if (ecash() >= 2_000_000_000) return true; if (++polls % 4 === 0) mine(2); return false; }, { tries: 120, every: 3000 });
  }
  return { invite: code, federation: federationId, gatewayEcashMsats: ecash(), api: endpoints.fedimint.api };
}

export const pay = (request) => peer("payinvoice", "--force", "--json", request);
export const invoice = (sats, memo = "fedimint regtest") => peer("addinvoice", "--amt", String(sats), "--memo", memo);
export const lookup = (hash) => peer("lookupinvoice", hash);

const [command, ...args] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === "ready") console.log(JSON.stringify(await ready()));
  else if (command === "invite") console.log(invite());
  else if (command === "pay") { const p = pay(args[0]); console.log(JSON.stringify({ status: p.status, hash: p.payment_hash, fee: p.fee_sat })); }
  else if (command === "invoice") console.log(JSON.stringify(invoice(Number(args[0]))));
  else if (command === "lookup") console.log(JSON.stringify(lookup(args[0])));
  else if (command === "mine") mine(Number(args[0] ?? 1));
  else { console.error("usage: regtest.mjs ready | invite | pay <invoice> | invoice <sats> | lookup <hash> | mine [n]"); process.exit(2); }
}
