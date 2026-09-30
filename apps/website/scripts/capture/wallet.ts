// Test coins for the wallet shots, from the shared regtest environment (e2e/infra, joined with
// `npm run e2e:infra:use -- --host one`), the same recipes the gated e2e specs and e2e/matrix/rails.ts use.
// Testnet wallets only, each made with Wallets → New: no step here can reach a Mainnet wallet. Each rail is funded on its own and a rail that cannot be
// funded is reported and left as it is, so one slow service never costs the whole capture.
//
// Nothing here prints a recovery phrase, a key or a token. Phrases the helpers need (the Ark seed
// fund-ark.mjs returns, the Spark counterpart's) stay in variables.
import { expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { Interface } from "ethers";
import { BDK_REGTEST } from "../../../../e2e/support/bdk-regtest/regtest.mjs";
import { USDT_LOCAL } from "../../../../e2e/support/usdt-local.mjs";
import { choose } from "../../../../e2e/support/select";
import { TEST_COINS, createWallet, getTestCoins, showNetwork, walletCard, type CreateWallet } from "../../../../e2e/support/fixtures";
import { REPO, type Peer } from "./helpers";

export type Rail = "cashu" | "arkade" | "bark" | "spark" | "usdt" | "bitcoin" | "fedimint";

const node = (script: string, ...args: string[]) =>
  execFileSync(process.execPath, ["--experimental-eventsource", script, ...args], { cwd: REPO, encoding: "utf8", stdio: "pipe" }).trim();
const regtest = (suite: string) => (...args: string[]) => node(`e2e/support/${suite}-regtest/regtest.mjs`, ...args);

/** The Wallets page, on the Testnet tab, with that network's `card` chosen. */
export async function openWallet(p: Peer, card?: Rail | "lightning") {
  if (!await p.page.getByTestId("wallet").isVisible()) {
    // A phone shows its tabs on the chat list, not inside a chat.
    const back = p.page.getByTestId("chat-back");
    if (await back.isVisible()) await back.click();
    const tab = p.page.getByTestId("mobile-tab-wallet");
    if (await tab.isVisible()) await tab.click();
    else await p.page.getByTestId("wallet-chip").click();
  }
  await expect(p.page.getByTestId("wallet")).toBeVisible();
  if (!card) return;
  await showNetwork(p.page, "testnet");
  await walletCard(p.page, `${card}-testnet`).click();
}

/** A Testnet wallet of this kind, made with Wallets → New the way a person does (nothing when the card exists). */
const make = (p: Peer, kind: Rail, options: CreateWallet = {}) => createWallet(p, kind, "testnet", { timeout: 120_000, ...options });

const amount = async (el: ReturnType<Peer["page"]["getByTestId"]>) => Number((await el.innerText()).trim().match(/^[\d,.]*/)![0].replace(/,/g, "") || NaN);

/**
 * Cashu: "Get test coins" pressed until the wallet holds `sats` (TEST_COINS a press, from the test mint, which the
 * infra's mint answers). Receive never fills a Testnet wallet by itself.
 */
async function cashu(p: Peer, sats: number) {
  await make(p, "cashu");
  for (let i = 0; i < Math.ceil(sats / TEST_COINS); i++) await getTestCoins(p);
  await expect(p.page.getByTestId("wallet-balance")).toHaveText(new RegExp(`^${sats.toLocaleString("en-US")}\\s*test sats`), { timeout: 60_000 });
}

/** Ark: a seed fund-ark.mjs settled an arknote into, restored after the wallet moves to the regtest server. */
async function arkade(p: Peer) {
  await make(p, "arkade");
  const phrase = node("e2e/support/fund-ark.mjs");
  // New made it on Mutinynet; an empty wallet moves to the local regtest server.
  await openWallet(p, "arkade");
  const panel = p.page.getByTestId("ark-wallet");
  await panel.getByRole("radio", { name: "Regtest", exact: true }).click({ timeout: 60_000 });
  await expect(panel.getByTestId("ark-balance")).toContainText("Regtest", { timeout: 60_000 });
  await panel.getByRole("button", { name: "Restore", exact: true }).click();
  await panel.getByLabel("Recovery phrase", { exact: true }).fill(phrase);
  await panel.getByRole("button", { name: "Restore from phrase", exact: true }).click();
  await expect(panel.getByTestId("ark-balance")).toHaveText(/^9,900\s*(test )?sats/, { timeout: 60_000 });
}

/** Bark: the regtest server's funder wallet pays the app's Ark address. */
async function bark(p: Peer, sats: number) {
  const bark = regtest("bark");
  bark("ready");
  await make(p, "bark");
  // New made it on signet; an empty wallet makes way for the local regtest server.
  await openWallet(p, "bark");
  const panel = p.page.getByTestId("bark-wallet");
  await panel.getByRole("radio", { name: "Regtest", exact: true }).click({ timeout: 90_000 });
  await expect(panel.getByTestId("bark-balance")).toContainText("Regtest", { timeout: 90_000 });
  const address = (await panel.getByTestId("bark-address").innerText()).trim();
  bark("pay", address, String(sats));
  await expect(panel.getByTestId("bark-balance")).toHaveText(new RegExp(`^${sats.toLocaleString("en-US")}\\s*(test )?sats`), { timeout: 90_000 });
}

/** Spark: Breez's hosted regtest; the counterpart whose phrase GHOSTLY_SPARK_COUNTERPART holds pays the app's address. */
async function spark(p: Peer, sats: number) {
  if (!process.env.GHOSTLY_SPARK_COUNTERPART && !process.env.GHOSTLY_BREEZ_COUNTERPART) throw new Error("no GHOSTLY_SPARK_COUNTERPART");
  await make(p, "spark");
  await openWallet(p, "spark");
  const panel = p.page.getByTestId("spark-wallet");
  await expect(panel.getByTestId("spark-balance")).toContainText("Regtest", { timeout: 120_000 });
  const address = (await panel.getByTestId("spark-address").innerText()).trim();
  const { sparkCounterpart } = await import("../../../../e2e/support/spark");
  const funder = await sparkCounterpart(sats);
  try { await funder.pay(address, sats); } finally { await funder.close(); }
  await expect(panel.getByTestId("spark-balance")).toHaveText(new RegExp(`^${sats.toLocaleString("en-US")}\\s*(test )?sats`), { timeout: 120_000 });
}

/** USDT: the local EVM chain's test token, minted to the app's address (plus gas). */
async function usdt(p: Peer, tokens: number) {
  let id = 0;
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(USDT_LOCAL.provider, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const result = await response.json(); if (result.error) throw new Error("Local EVM operation failed"); return result.result;
  };
  await make(p, "usdt");
  await openWallet(p, "usdt");
  const panel = p.page.getByTestId("usdt-wallet");
  await panel.getByRole("radio", { name: "Local test chain", exact: true }).click({ timeout: 60_000 });
  await panel.getByLabel("Token contract", { exact: true }).fill(USDT_LOCAL.token);
  await panel.getByRole("button", { name: "Switch network", exact: true }).click();
  await expect(p.page.getByTestId("wallet-card-usdt-testnet")).toContainText("EVM local", { timeout: 60_000 });
  await expect(panel.getByTestId("usdt-balance")).toHaveText(/^0 TEST-USDT/, { timeout: 60_000 });
  const address = (await panel.getByTestId("usdt-address").innerText()).trim();
  await rpc("anvil_setBalance", [address, "0xde0b6b3a7640000"]);
  const [from] = await rpc("eth_accounts");
  await rpc("eth_sendTransaction", [{ from, to: USDT_LOCAL.token, data: new Interface(["function mint(address,uint256)"]).encodeFunctionData("mint", [address, BigInt(tokens) * 1_000_000n]) }]);
  await rpc("evm_mine");
  await expect(panel.getByTestId("usdt-balance")).toHaveText(new RegExp(`^${tokens} TEST-USDT`), { timeout: 60_000 });
}

/** On-chain: a BDK wallet on the regtest chain, paid by the miner and confirmed. */
async function bitcoin(p: Peer, sats: number) {
  const bdk = regtest("bdk");
  bdk("ready");
  // BDK is the one on-chain source a browser runs, so New shows its form at once.
  await make(p, "bitcoin", { fill: async (area) => {
    await area.getByTestId("bdk-written").check();
    await choose(area.getByTestId("provider-form-bdk").getByLabel("Network"), "regtest");
    await area.getByLabel("Esplora server").fill(BDK_REGTEST.esplora);
    await area.getByTestId("provider-save").click();
  } });
  await openWallet(p, "bitcoin");
  const panel = p.page.getByTestId("bitcoin-wallet");
  await expect(panel.getByTestId("onchain-source-status")).toContainText(/Connected/, { timeout: 60_000 });
  await panel.getByTestId("bitcoin-new-address").click();
  const address = (await panel.getByTestId("bitcoin-address").innerText()).trim();
  bdk("send", address, String(sats));
  await expect.poll(async () => {
    bdk("mine", "1");
    await panel.getByRole("button", { name: "Refresh now" }).click();
    return amount(panel.getByTestId("bitcoin-balance"));
  }, { timeout: 120_000, intervals: [3_000] }).toBe(sats);
}

/** Fedimint: join the regtest federation by invite, then ecash in over its Lightning gateway. */
async function fedimint(p: Peer, sats: number) {
  const fed = regtest("fedimint");
  const { invite } = JSON.parse(fed("ready")) as { invite: string };
  await make(p, "fedimint", { invite });
  await openWallet(p, "fedimint");
  const panel = p.page.getByTestId("fedimint-wallet");
  await expect(panel.getByTestId("fedimint-balance")).toHaveText(/^0\s*test sats/, { timeout: 90_000 });
  await p.page.getByTestId("wallet-receive").click();
  await panel.getByTestId("fedimint-receive-amount").fill(String(sats));
  await panel.getByTestId("fedimint-receive-invoice").click();
  const invoice = (await panel.getByTestId("fedimint-invoice").innerText()).trim();
  fed("pay", invoice);
  await expect.poll(() => amount(panel.getByTestId("fedimint-balance")), { timeout: 90_000 }).toBeGreaterThan(sats * 0.99);
}

/** What to put in each wallet, in sats (USDT in whole test tokens). */
export type Funding = Partial<Record<Rail, number>>;

/**
 * A Testnet Cashu wallet (the one every shot's payments use), then each rail made and funded in turn. A rail
 * given 0 is made and left empty. Returns the rails that could not be funded.
 */
export async function fund(p: Peer, funding: Funding): Promise<Rail[]> {
  await make(p, "cashu");
  const steps: Record<Rail, (n: number) => Promise<void>> = {
    cashu: (n) => cashu(p, n), arkade: () => arkade(p), bark: (n) => bark(p, n), spark: (n) => spark(p, n),
    usdt: (n) => usdt(p, n), bitcoin: (n) => bitcoin(p, n), fedimint: (n) => fedimint(p, n),
  };
  const failed: Rail[] = [];
  for (const [rail, n] of Object.entries(funding) as [Rail, number][]) {
    const started = Date.now();
    try {
      if (n > 0) await steps[rail](n); else await make(p, rail);
      console.log(`  [${p.name}] ${rail} funded (${Math.round((Date.now() - started) / 1000)} s)`);
    } catch (e) {
      failed.push(rail);
      // The message only: a failed step's call log can hold what was typed.
      console.log(`  [${p.name}] ${rail} not funded: ${String((e as Error).message).split("\n")[0]}`);
      await p.page.keyboard.press("Escape").catch(() => {});
    }
  }
  return failed;
}
