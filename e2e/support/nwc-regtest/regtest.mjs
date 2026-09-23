#!/usr/bin/env node
// Drives the disposable NWC regtest stack in docker-compose.yml: worthless coins only.
//   node e2e/support/nwc-regtest/regtest.mjs ready                 mine, fund both LND nodes, open alice -> bob, start both hubs
//   node e2e/support/nwc-regtest/regtest.mjs balances              channel balances of both nodes, in sats
//   node e2e/support/nwc-regtest/regtest.mjs mine [blocks]
//   node e2e/support/nwc-regtest/regtest.mjs invoice <alice|bob> <sats> [memo]   an invoice straight from that LND node
//   node e2e/support/nwc-regtest/regtest.mjs pay <alice|bob> <bolt11>            that LND node pays it directly
// Pairing URIs come only from the module (`nwcUri`), never from the CLI: they carry a spending secret.
import { execFileSync } from "node:child_process";

export const NWC_REGTEST = {
  /** The relay as the host (browser, Node test) reaches it; the hubs reach it as ws://relay:7777. */
  relay: "ws://127.0.0.1:44502",
  bitcoindRpc: "http://127.0.0.1:44501",
  lndRest: { alice: "https://127.0.0.1:44511", bob: "https://127.0.0.1:44512" },
  hub: { alice: "http://127.0.0.1:44521", bob: "http://127.0.0.1:44522" },
  channel: { capacity: 1_000_000, push: 400_000 },
};
const INNER_RELAY = "ws://relay:7777";
// Test-only, guards worthless regtest coins; it matches AUTO_UNLOCK_PASSWORD in docker-compose.yml.
const HUB_PASSWORD = "ghostly-nwc-regtest";
const SCOPES = ["pay_invoice", "make_invoice", "lookup_invoice", "get_balance", "get_info"];
const WHO = ["alice", "bob"];

const run = (container, args) => execFileSync("docker", ["exec", container, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cli = (...args) => run("ghostly-nwc-bitcoind", ["bitcoin-cli", "-regtest", "-rpcuser=nwc", "-rpcpassword=regtest", ...args]);
const miner = (...args) => cli("-rpcwallet=miner", ...args);
const lncli = (who, ...args) => JSON.parse(run(`ghostly-nwc-lnd-${side(who)}`, ["lncli", "--network", "regtest", ...args]));
const json = (text) => JSON.parse(text);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function side(who) {
  if (!WHO.includes(who)) throw new Error(`who must be "alice" or "bob", not ${JSON.stringify(who)}`);
  return who;
}

async function until(what, check, { tries = 60, every = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const value = await check(); if (value) return value; } catch { /* not yet */ }
    await wait(every);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export function mine(blocks = 1) { miner("generatetoaddress", String(blocks), miner("getnewaddress")); }

function ensureMiner() {
  if (!json(cli("listwallets")).includes("miner")) {
    try { cli("loadwallet", "miner"); } catch { cli("createwallet", "miner"); }
  }
  if (Number(miner("getbalance")) < 50) mine(101);
}

const synced = (who) => until(`${who} to sync`, () => lncli(who, "getinfo").synced_to_chain, { tries: 90 });

async function fund(who) {
  const confirmed = () => Number(lncli(who, "walletbalance").confirmed_balance);
  if (confirmed() >= 50_000_000) return;
  miner("sendtoaddress", lncli(who, "newaddress", "p2wkh").address, "1");
  mine(6);
  await until(`${who}'s coins to confirm`, () => confirmed() >= 50_000_000, { tries: 60 });
}

function aliceChannel(bobKey) {
  return lncli("alice", "listchannels", "--peer", bobKey).channels[0];
}

async function ensureChannel(bobKey) {
  const pending = () => lncli("alice", "pendingchannels").pending_open_channels.some((p) => p.channel.remote_node_pub === bobKey);
  if (!aliceChannel(bobKey) && !pending()) {
    try { lncli("alice", "connect", `${bobKey}@lnd-bob:9735`); } catch (e) { if (!/already connected/.test(String(e.stderr))) throw e; }
    const { capacity, push } = NWC_REGTEST.channel;
    lncli("alice", "openchannel", "--node_key", bobKey, "--local_amt", String(capacity), "--push_amt", String(push));
  }
  await until("the channel to open", () => {
    if (aliceChannel(bobKey)?.active) return true;
    mine(1);
    return false;
  }, { tries: 60 });
  await synced("alice"); await synced("bob");
  // Bob's side must see it active too, or bob -> alice fails.
  await until("bob to see the channel active", () => lncli("bob", "listchannels").channels.some((c) => c.active));
  return aliceChannel(bobKey);
}

// --- Alby Hub, over its own HTTP API (not NWC) ------------------------------------------------------------------
const tokens = {};

async function hub(who, method, path, body, token) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${NWC_REGTEST.hub[side(who)]}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Unlock, start and app creation share one slow rate limiter (1/s).
    if (res.status === 429 && attempt < 10) { await wait(1100); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`${who}'s hub ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    return text ? json(text) : null;
  }
}

async function ensureHub(who) {
  const info = () => hub(who, "GET", "/api/info");
  const first = await until(`${who}'s hub to answer`, info, { tries: 60 });
  if (!first.setupCompleted) await hub(who, "POST", "/api/setup", { unlockPassword: HUB_PASSWORD });
  else if (!first.running) {
    // A set-up hub starts itself (AUTO_UNLOCK_PASSWORD) shortly after boot; give it that chance first.
    await until(`${who}'s hub to start itself`, async () => { const now = await info(); return now.running || now.startupState; }, { tries: 8 }).catch(() => {});
  }
  const now = await info();
  if (!now.running && !now.startupState) tokens[who] = (await hub(who, "POST", "/api/start", { unlockPassword: HUB_PASSWORD })).token;
  const running = await until(`${who}'s hub to run`, async () => {
    const state = await info();
    return state.running && state.relays?.every((r) => r.online) ? state : null;
  }, { tries: 60 }).catch(async (e) => { throw new Error(`${e.message}: ${(await info()).startupError || "no startup error"}`); });
  return { network: running.network, backend: running.backendType, version: running.version, relays: running.relays.map((r) => r.url) };
}

async function hubToken(who) {
  tokens[who] ??= (await hub(who, "POST", "/api/unlock", { unlockPassword: HUB_PASSWORD, permission: "full" })).token;
  return tokens[who];
}

export async function ready() {
  ensureMiner();
  await synced("alice"); await synced("bob");
  await fund("alice"); await fund("bob");
  const bobKey = lncli("bob", "getinfo").identity_pubkey;
  const channel = await ensureChannel(bobKey);
  const hubs = { alice: await ensureHub("alice"), bob: await ensureHub("bob") };
  return {
    ...NWC_REGTEST,
    nodes: { alice: lncli("alice", "getinfo").identity_pubkey, bob: bobKey },
    channel: { capacity: Number(channel.capacity), active: channel.active, point: channel.channel_point },
    balances: balances(),
    hubs,
  };
}

const uris = {};

/**
 * A NIP-47 pairing URI for `who`'s wallet, relay rewritten to the host's view. Reused within this process unless
 * `fresh` or given a `budgetSat` (0 = no budget; default 1,000,000, never renewed); a new app connection otherwise.
 * Keep it in memory: its secret spends that wallet.
 */
export async function nwcUri(who, { fresh = false, name, budgetSat } = {}) {
  side(who);
  if (uris[who] && !fresh && budgetSat === undefined) return uris[who];
  await ensureHub(who);
  const created = await hub(who, "POST", "/api/apps", {
    name: name ?? `ghostly-e2e-${who}-${Date.now()}`,
    scopes: SCOPES,
    maxAmountSat: budgetSat ?? 1_000_000,
    budgetRenewal: "never",
    isolated: false,
  }, await hubToken(who));
  const uri = new URL(created.pairingUri);
  const relays = uri.searchParams.getAll("relay").map((r) => (r === INNER_RELAY ? NWC_REGTEST.relay : r));
  uri.searchParams.delete("relay");
  const rest = [...uri.searchParams];
  const params = new URLSearchParams([...relays.map((r) => ["relay", r]), ...rest]);
  const pairing = `nostr+walletconnect://${uri.host}?${params}`;
  if (budgetSat === undefined) uris[who] = pairing;
  return pairing;
}

/** A BOLT11 invoice straight from `who`'s LND node. */
export function invoice(who, sats, memo = "ghostly e2e") {
  const made = lncli(who, "addinvoice", "--amt", String(sats), "--memo", memo);
  return { invoice: made.payment_request, paymentHash: made.r_hash };
}

/** `who`'s LND node pays `bolt11` directly (not through NWC). */
export function pay(who, bolt11) {
  try {
    const paid = lncli(who, "payinvoice", "--force", "--json", "--timeout", "30s", bolt11);
    return { status: paid.status, paymentHash: paid.payment_hash, preimage: paid.payment_preimage, feeSat: Number(paid.fee_sat ?? 0), failure: paid.failure_reason };
  } catch (e) {
    const out = String(e.stdout ?? "");
    try { const paid = json(out); return { status: paid.status, paymentHash: paid.payment_hash, failure: paid.failure_reason }; } catch { /* not JSON */ }
    return { status: "FAILED", failure: String(e.stderr || e.message).trim().split("\n").at(-1) };
  }
}

/** The channel balances of both nodes, in sats. */
export function balances() {
  const of = (who) => {
    const b = lncli(who, "channelbalance");
    return { local: Number(b.local_balance?.sat ?? 0), remote: Number(b.remote_balance?.sat ?? 0) };
  };
  return { alice: of("alice"), bob: of("bob") };
}

const [command, ...args] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === "ready") console.log(JSON.stringify(await ready(), null, 2));
  else if (command === "balances") console.log(JSON.stringify(balances()));
  else if (command === "mine") { ensureMiner(); mine(Number(args[0] ?? 1)); }
  else if (command === "invoice") console.log(JSON.stringify(invoice(args[0], Number(args[1]), args[2])));
  else if (command === "pay") console.log(JSON.stringify(pay(args[0], args[1])));
  else { console.error("usage: regtest.mjs ready | balances | mine [n] | invoice <alice|bob> <sats> [memo] | pay <alice|bob> <bolt11>"); process.exit(2); }
}
