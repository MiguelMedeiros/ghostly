// Test coins for the wallet shots, from the shared regtest environment (e2e/infra, joined with
// `npm run e2e:infra:use -- --host one`), the same recipes the gated e2e specs use. Testnet mode only:
// no step here can reach a Mainnet wallet. Each rail is funded on its own and a rail that cannot be
// funded is reported and left as it is, so one slow service never costs the whole capture.
//
// Nothing here prints a recovery phrase, a key or a token. Phrases the helpers need (the Ark seed
// fund-ark.mjs returns, the Spark counterpart's) stay in variables.
import { expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { Interface } from "ethers";
import { BDK_REGTEST } from "../../../e2e/support/bdk-regtest/regtest.mjs";
import { USDT_LOCAL } from "../../../e2e/support/usdt-local.mjs";
import { choose } from "../../../e2e/support/select";
import { REPO, type Peer } from "./helpers";

export type Rail = "cashu" | "arkade" | "bark" | "spark" | "usdt" | "bitcoin" | "fedimint";

const node = (script: string, ...args: string[]) =>
  execFileSync(process.execPath, ["--experimental-eventsource", script, ...args], { cwd: REPO, encoding: "utf8", stdio: "pipe" }).trim();
const regtest = (suite: string) => (...args: string[]) => node(`e2e/support/${suite}-regtest/regtest.mjs`, ...args);

export async function openWallet(p: Peer, card?: Rail | "lightning") {
  if (!await p.page.getByTestId("wallet").isVisible()) {
    // A phone shows its tabs on the chat list, not inside a chat.
    const back = p.page.getByTestId("chat-back");
    if (await back.isVisible()) await back.click();
    const tabs = p.page.getByTestId("mobile-tabs");
    if (await tabs.isVisible()) await tabs.getByRole("button", { name: /^Wallets?$/ }).click();
    else await p.page.getByTestId("wallet-chip").click();
  }
  await expect(p.page.getByTestId("wallet")).toBeVisible();
  if (card) await p.page.getByTestId(`wallet-card-${card}`).click();
}

/** Every wallet on test networks: the app says so on every card and in the wallet's notice. */
export async function useTestnet(p: Peer) {
  await openWallet(p);
  await p.page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
  await expect(p.page.getByTestId("testnet-notice")).toBeVisible();
}

const amount = async (el: ReturnType<Peer["page"]["getByTestId"]>) => Number((await el.innerText()).trim().match(/^[\d,.]*/)![0].replace(/,/g, "") || NaN);

/** Cashu: a mint quote at the test mint, which the infra's fake-Lightning mint pays by itself. */
async function cashu(p: Peer, sats: number) {
  await openWallet(p, "cashu");
  await p.page.getByTestId("wallet-receive").click();
  await p.page.getByTestId("wallet-receive-amount").fill(String(sats));
  await p.page.getByTestId("wallet-create-invoice").click();
  await expect(p.page.getByTestId("wallet-paid")).toContainText(`${sats.toLocaleString("en-US")} sats received`, { timeout: 90_000 });
}

/** Ark: a seed fund-ark.mjs settled an arknote into, restored after the wallet moves to the regtest server. */
async function arkade(p: Peer) {
  const phrase = node("e2e/support/fund-ark.mjs");
  await openWallet(p, "arkade");
  const panel = p.page.getByTestId("ark-wallet");
  await panel.getByRole("radio", { name: "Regtest", exact: true }).click({ timeout: 60_000 });
  await expect(panel.getByTestId("ark-balance")).toContainText("Regtest", { timeout: 60_000 });
  await panel.getByRole("button", { name: "Restore", exact: true }).click();
  await panel.getByLabel("Recovery phrase", { exact: true }).fill(phrase);
  await panel.getByRole("button", { name: "Restore from phrase", exact: true }).click();
  await expect(panel.getByTestId("ark-balance")).toHaveText(/^9,900\s*sats/, { timeout: 60_000 });
}

/** Bark: the regtest server's funder wallet pays the app's Ark address. */
async function bark(p: Peer, sats: number) {
  const bark = regtest("bark");
  bark("ready");
  await openWallet(p, "bark");
  const panel = p.page.getByTestId("bark-wallet");
  await panel.getByRole("radio", { name: "Regtest", exact: true }).click({ timeout: 90_000 });
  await expect(panel.getByTestId("bark-balance")).toContainText("Regtest", { timeout: 90_000 });
  const address = (await panel.getByTestId("bark-address").innerText()).trim();
  bark("pay", address, String(sats));
  await expect(panel.getByTestId("bark-balance")).toHaveText(new RegExp(`^${sats.toLocaleString("en-US")}\\s*sats`), { timeout: 90_000 });
}

/** Spark: Breez's hosted regtest; the counterpart whose phrase GHOSTLY_SPARK_COUNTERPART holds pays the app's address. */
async function spark(p: Peer, sats: number) {
  if (!process.env.GHOSTLY_SPARK_COUNTERPART && !process.env.GHOSTLY_BREEZ_COUNTERPART) throw new Error("no GHOSTLY_SPARK_COUNTERPART");
  await openWallet(p, "spark");
  const panel = p.page.getByTestId("spark-wallet");
  await expect(panel.getByTestId("spark-balance")).toContainText("Regtest", { timeout: 120_000 });
  const address = (await panel.getByTestId("spark-address").innerText()).trim();
  const { sparkCounterpart } = await import("../../../e2e/support/spark");
  const funder = await sparkCounterpart(sats);
  try { await funder.pay(address, sats); } finally { await funder.close(); }
  await expect(panel.getByTestId("spark-balance")).toHaveText(new RegExp(`^${sats.toLocaleString("en-US")}\\s*sats`), { timeout: 120_000 });
}

/** USDT: the local EVM chain's test token, minted to the app's address (plus gas). */
async function usdt(p: Peer, tokens: number) {
  let id = 0;
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(USDT_LOCAL.provider, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const result = await response.json(); if (result.error) throw new Error("Local EVM operation failed"); return result.result;
  };
  await openWallet(p, "usdt");
  const panel = p.page.getByTestId("usdt-wallet");
  await panel.getByRole("radio", { name: "Local test chain", exact: true }).click({ timeout: 60_000 });
  await panel.getByLabel("Token contract", { exact: true }).fill(USDT_LOCAL.token);
  await panel.getByRole("button", { name: "Switch network", exact: true }).click();
  await expect(p.page.getByTestId("wallet-card-usdt")).toContainText("EVM local", { timeout: 60_000 });
  await expect(panel.getByTestId("usdt-balance")).toHaveText("0 TEST-USDT", { timeout: 60_000 });
  const address = (await panel.getByTestId("usdt-address").innerText()).trim();
  await rpc("anvil_setBalance", [address, "0xde0b6b3a7640000"]);
  const [from] = await rpc("eth_accounts");
  await rpc("eth_sendTransaction", [{ from, to: USDT_LOCAL.token, data: new Interface(["function mint(address,uint256)"]).encodeFunctionData("mint", [address, BigInt(tokens) * 1_000_000n]) }]);
  await rpc("evm_mine");
  await expect(panel.getByTestId("usdt-balance")).toHaveText(`${tokens} TEST-USDT`, { timeout: 60_000 });
}

/** On-chain: a BDK wallet on the regtest chain, paid by the miner and confirmed. */
async function bitcoin(p: Peer, sats: number) {
  const bdk = regtest("bdk");
  bdk("ready");
  await openWallet(p, "bitcoin");
  const panel = p.page.getByTestId("bitcoin-wallet");
  await choose(panel.getByTestId("onchain-source-select"), "bdk");
  const form = panel.getByTestId("provider-form-bdk");
  await panel.getByTestId("bdk-written").check();
  await choose(form.getByLabel("Network"), "regtest");
  await form.getByLabel("Esplora server").fill(BDK_REGTEST.esplora);
  await form.getByTestId("provider-save").click();
  await expect(panel.getByTestId("onchain-source-saved")).toBeVisible({ timeout: 60_000 });
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
  await openWallet(p, "fedimint");
  const panel = p.page.getByTestId("fedimint-wallet");
  await panel.getByTestId("fedimint-invite").fill(invite);
  await panel.getByTestId("fedimint-preview").click();
  await expect(panel.getByTestId("fedimint-preview-facts-name")).toHaveText("Ghostly regtest", { timeout: 90_000 });
  await panel.getByTestId("fedimint-join").click();
  await expect(panel.getByTestId("fedimint-balance")).toHaveText(/^0\s*sats/, { timeout: 90_000 });
  await p.page.getByTestId("wallet-receive").click();
  await panel.getByTestId("fedimint-receive-amount").fill(String(sats));
  await panel.getByTestId("fedimint-receive-invoice").click();
  const invoice = (await panel.getByTestId("fedimint-invoice").innerText()).trim();
  fed("pay", invoice);
  await expect.poll(() => amount(panel.getByTestId("fedimint-balance")), { timeout: 90_000 }).toBeGreaterThan(sats * 0.99);
}

/** What to put in each wallet, in sats (USDT in whole test tokens). */
export type Funding = Partial<Record<Rail, number>>;

/** Testnet mode, then each rail funded in turn. Returns the rails that could not be funded. */
export async function fund(p: Peer, funding: Funding): Promise<Rail[]> {
  await useTestnet(p);
  const steps: Record<Rail, (n: number) => Promise<void>> = {
    cashu: (n) => cashu(p, n), arkade: () => arkade(p), bark: (n) => bark(p, n), spark: (n) => spark(p, n),
    usdt: (n) => usdt(p, n), bitcoin: (n) => bitcoin(p, n), fedimint: (n) => fedimint(p, n),
  };
  const failed: Rail[] = [];
  for (const [rail, n] of Object.entries(funding) as [Rail, number][]) {
    const started = Date.now();
    try {
      await steps[rail](n);
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
