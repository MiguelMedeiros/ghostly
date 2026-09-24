#!/usr/bin/env node
// Drives the Ark (Arkade's arkd) part of e2e/infra: worthless regtest coins only.
//   node e2e/support/ark-regtest/regtest.mjs ready          create and unlock the server wallet, fund it, set its fees
//   node e2e/support/ark-regtest/regtest.mjs note <sats>    a bearer note of that value, redeemable on the server
//   node e2e/support/ark-regtest/regtest.mjs mine [blocks]
// The setup follows ArkLabsHQ/arkade-regtest (lib/setup/arkd.mjs), minus its ark CLI client: Ghostly's tests fund
// their wallets with notes. A note is spendable by whoever holds it: callers keep it in memory, never in a log.
import { endpoints } from "../../infra/env.mjs";
import { ensureMiner, mine, miner, run, until } from "../../infra/chain.mjs";

export { mine };
export const ARK_REGTEST = { server: endpoints.ark.server, esplora: endpoints.ark.esplora };
// The admin API is published next to the public one (7071 beside 7070 inside the container).
const admin = () => { const url = new URL(ARK_REGTEST.server); url.port = String(Number(url.port) + 1); return url.origin; };
const PASSWORD = "secret";
/** The fees the stack's earlier recipe ran with; the tests allow for them (a 10,000-sat note settles to 9,900). */
const FEES = { offchainInputFee: "amount * 0.01", onchainInputFee: "amount * 0.01", offchainOutputFee: "0.0", onchainOutputFee: "250.0" };

async function call(path, body) {
  const response = await fetch(`${admin()}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`arkd ${path}: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const status = () => call("/v1/admin/wallet/status");

export async function ready() {
  ensureMiner();
  // arkd answers its admin API once it reached its wallet service, which waits on NBXplorer and bitcoind.
  await until("arkd's admin API", status, { tries: 180 });
  if (!(await status()).initialized) {
    const { seed } = await call("/v1/admin/wallet/seed");
    await call("/v1/admin/wallet/create", { seed, password: PASSWORD });
  }
  if (!(await status()).unlocked) await call("/v1/admin/wallet/unlock", { password: PASSWORD });
  await until("arkd's wallet to sync", async () => (await status()).synced === true, { tries: 180 });
  // Many confirmed coins, so rounds have inputs and fee estimation has history.
  const balance = await call("/v1/admin/wallet/balance");
  if (Number(balance.mainAccount?.available ?? 0) < 10) {
    const { address } = await call("/v1/admin/wallet/address");
    for (let i = 0; i < 21; i++) miner("sendtoaddress", address, "1");
    mine(1);
    await until("arkd's coins", async () => Number((await call("/v1/admin/wallet/balance")).mainAccount?.available ?? 0) >= 10);
  }
  await call("/v1/admin/intentFees", { fees: FEES });
  const info = await until("arkd's info", async () => {
    const answer = await fetch(`${ARK_REGTEST.server}/v1/info`).then((r) => r.json());
    return answer.signerPubkey ? answer : null;
  });
  return { ...ARK_REGTEST, network: info.network, signerPubkey: info.signerPubkey };
}

/** A note of `sats` from the server (its operator's faucet). Returns the `arknote…` string; keep it out of logs. */
export function note(sats) {
  const output = run("arkd", ["arkd", "note", "--amount", String(sats)]);
  const found = output.match(/arknote[a-zA-Z0-9]+/)?.[0];
  if (!found) throw new Error("arkd returned no note");
  return found;
}

const [command, ...args] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === "ready") console.log(JSON.stringify(await ready()));
  else if (command === "note") process.stdout.write(note(Number(args[0])));
  else if (command === "mine") mine(Number(args[0] ?? 1));
  else { console.error("usage: regtest.mjs ready | note <sats> | mine [n]"); process.exit(2); }
}
