import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator } from "@playwright/test";
import { Interface } from "ethers";
import { chatPayments } from "../support/payments";
import { choose } from "../support/select";
import { chatPane, either, newWallet, openChat, paymentCard, wallet, type Actor } from "./actors";

/**
 * The Testnet payment blocks of the rails that need e2e/infra (Lightning through LND, Core Lightning, NWC
 * and Breez; Ark through Arkade and Bark; Bitcoin on-chain through BDK; USDT). Each one sets its Testnet wallet
 * up the way a person does (New with the provider's form, or the wallet New made moved to its own Regtest option),
 * funds it from the environment's scripts (e2e/support/*-regtest, fund-ark.mjs), then pays in the chat both ways (a
 * request each way and a direct Send each way) and checks the bubbles and the balances on both sides.
 * They reuse what each provider's own gated spec does (e2e/web/wallet-lnd, wallet-cln, wallet-nwc,
 * breez-wallet, wallet-providers, wallet-bdk), in either language and on either screen.
 *
 * A (the host, English, laptop) is the one the environment funds; B gets its money from A in the chat
 * before paying anything back.
 */

/* ---------- shared by every rail ---------- */

/**
 * These methods off in this person's chat (+ → Payment → Accept): a test mint pays a request's own Lightning invoice
 * by itself.
 */
export async function chatMethods(actor: Actor, off: string[]): Promise<void> {
  await openChat(actor);
  await chatPayments(actor.page, Object.fromEntries(off.map((method) => [method, false])));
}

/** A note of the scenario's own on a payment: the one thing in its bubble no clock or amount can match by accident. */
export const memo = (actor: Actor, text: string) => actor.page.getByLabel("What for? (optional)").fill(text);
export const bubble = (actor: Actor, text: string) => chatPane(actor).getByTestId("payment-bubble").filter({ hasText: text }).last();
export const approve = (scope: Locator) => scope.getByTestId("payment-review").getByRole("button", { name: either("Approve payment") }).click({ timeout: 60_000 });

const SETTLED = new RegExp(`^(?:${[either("Paid").source, either("Received").source].join("|")})$`);

/** The first number in a balance line, whatever the language groups its thousands with (integers only). */
const amountIn = (text: string) => Number(/\d[\d.,\s]*/.exec(text)?.[0].replace(/[^\d]/g, "") ?? NaN);

/**
 * Work on a shared node pair, one scenario at a time. The matrix runs several workers, and the Lightning
 * suites of e2e/infra have one pair of nodes each: two scenarios paying over the same channel at once would
 * each see the other's payments in the balances. A lock directory per rail, held by a live process.
 */
async function exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), "ghostly-matrix-locks", name);
  mkdirSync(join(dir, ".."), { recursive: true });
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      break;
    } catch {
      let holder = NaN;
      try { holder = Number(readFileSync(join(dir, "pid"), "utf8")); } catch { /* just made: its pid comes next */ }
      let alive = true;
      if (Number.isInteger(holder)) try { process.kill(holder, 0); } catch { alive = false; }
      if (!alive) rmSync(dir, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface ChatPayment {
  card: string;
  amount: string;
  note: string;
  /** The fee cap the payer allows (the bubble's "Maximum fee"), when its default is too low for the chain. */
  maxFee?: string;
}

/**
 * A direct Send in the chat: the payer's app asks the payee's for somewhere to pay, the payer reviews and
 * approves; the payee's app settles it from its own wallet. `confirm` runs while the payee waits (a block).
 */
async function sendInChat(from: Actor, to: Actor, p: ChatPayment, confirm?: () => void): Promise<void> {
  await openChat(from);
  await paymentCard(from, p.card);
  await from.page.getByTestId("payment-amount").fill(p.amount);
  await memo(from, p.note);
  await from.page.getByTestId("payment-send").click();
  const composer = from.page.getByTestId("payment-composer");
  await approve(composer);
  // Gone out: the sheet closes, back to the chat, whose bubbles tell the rest.
  await expect(composer).toHaveCount(0, { timeout: 90_000 });
  // The payee's app made the request this was paid against, with the note: it settles from its own wallet
  // (a USDT one once the transfer is confirmed, which is also when the payer's next payment may go).
  await openChat(to);
  await settles(bubble(to, p.note), confirm);
}

/** A request: `payee` asks, `payer` pays it from the bubble after reviewing it. */
async function requestInChat(payee: Actor, payer: Actor, p: ChatPayment, confirm?: () => void): Promise<void> {
  await openChat(payee);
  await paymentCard(payee, p.card);
  await payee.page.getByTestId("payment-amount").fill(p.amount);
  await memo(payee, p.note);
  await payee.page.getByTestId("payment-request").click();
  await openChat(payer);
  const request = bubble(payer, p.note);
  if (p.maxFee) await request.getByLabel(either("Maximum fee (sats)")).fill(p.maxFee);
  await request.getByTestId("payment-pay").click({ timeout: 60_000 });
  await approve(request);
  await settles(bubble(payee, p.note), confirm);
  await settles(request, confirm);
  if (!confirm && p.card !== "lightning") await expect(request.getByTestId("payment-review").getByTestId("review-status")).toHaveText(/settled|confirmed/, { timeout: 90_000 });
}

/** Paid (or Received) — mining a block at a time while it waits, for a rail that settles on-chain. */
async function settles(target: Locator, confirm?: () => void): Promise<void> {
  const state = target.getByTestId("payment-state");
  if (!confirm) return expect(state).toHaveText(SETTLED, { timeout: 120_000 });
  await expect.poll(async () => { confirm(); return state.innerText(); }, { timeout: 150_000, intervals: [3_000] }).toMatch(SETTLED);
}

/* ---------- Lightning through a node ---------- */

type Who = "alice" | "bob";

interface LightningNode {
  /** The lock the rail's nodes are shared under. */
  lock: string;
  /** Anything to do before the scenario pays (fund, open the channel): idempotent. */
  ready?: () => Promise<unknown>;
  /** Makes one of the environment's nodes the source of this person's Testnet Lightning wallet, through New and its form. */
  connect: (actor: Actor, who: Who) => Promise<void>;
  /** The node's own balance, in sats, once nothing is in flight on it. */
  balance: (who: Who) => Promise<number>;
}

/**
 * A Testnet Lightning wallet through `provider`, made with New: `fill` fills the source's form (the dialog's form area)
 * and saves it; the app checks the source before the card appears. Returns the card's source section. It is the
 * person's one wallet, so every request carries an invoice of this source alone.
 */
async function lightningSource(actor: Actor, provider: string, fill: (form: Locator) => Promise<void>, secret?: string): Promise<Locator> {
  await newWallet(actor, "lightning", "testnet", { provider, fill, timeout: 90_000 });
  await wallet(actor, "lightning-testnet");
  const source = actor.page.getByTestId("lightning-source");
  // The credentials are sealed in the engine, never back in the page.
  if (secret) expect(await actor.page.content()).not.toContain(secret);
  return source;
}

const LND: LightningNode = {
  lock: "lnd",
  connect: async (actor, who) => {
    const lnd = await import("../support/lnd-regtest/regtest.mjs");
    const { url, macaroon, cert } = lnd.credentials(who);
    const source = await lightningSource(actor, "lnd", async (area) => {
      const form = area.getByTestId("provider-form-lnd");
      await form.getByLabel("REST address").fill(url);
      await form.getByLabel("Macaroon (hex)").fill(macaroon);
      await form.getByLabel("TLS certificate").fill(cert);
      await form.getByTestId("provider-save").click();
    }, macaroon);
    await expect(source.getByTestId("lightning-source-status")).toContainText(`ghostly-${who}`);
  },
  balance: async (who) => {
    const lnd = await import("../support/lnd-regtest/regtest.mjs");
    // Right after a payment the payer's balance still carries the HTLC's share of the commitment fee.
    await expect.poll(() => lnd.settled(who), { timeout: 60_000 }).toBe(true);
    return lnd.balance(who);
  },
};

const CLN: LightningNode = {
  lock: "cln",
  connect: async (actor, who) => {
    const cln = await import("../support/cln-regtest/regtest.mjs");
    const rune: string = cln.rune(who);
    const source = await lightningSource(actor, "core-lightning", async (area) => {
      const form = area.getByTestId("provider-form-core-lightning");
      await form.getByLabel("Node id").fill(cln.nodeId(who));
      await form.getByLabel("WebSocket address").fill(cln.CLN_REGTEST[who].websocket);
      await form.getByLabel("Rune").fill(rune);
      await form.getByTestId("provider-save").click();
    }, rune);
    await expect(source.getByTestId("lightning-source-current")).toContainText("Core Lightning");
  },
  balance: async (who) => (await import("../support/cln-regtest/regtest.mjs")).channelBalance(who),
};

const NWC: LightningNode = {
  lock: "nwc",
  ready: async () => (await import("../support/nwc-regtest/regtest.mjs")).ready(),
  connect: async (actor, who) => {
    const nwc = await import("../support/nwc-regtest/regtest.mjs");
    // An app connection of this scenario's own on the person's Alby Hub.
    const uri: string = await nwc.nwcUri(who, { fresh: true });
    const source = await lightningSource(actor, "nwc", async (area) => {
      await area.getByTestId("provider-form-nwc").getByLabel("Connection URI").fill(uri);
      await area.getByTestId("provider-save").click();
    }, uri);
    await expect(source.getByTestId("lightning-source-current")).toContainText("Nostr Wallet Connect");
  },
  balance: async (who) => (await import("../support/nwc-regtest/regtest.mjs")).balances()[who].local,
};

async function cardBalance(actor: Actor): Promise<number> {
  await wallet(actor, "lightning");
  return amountIn(await actor.page.getByTestId("wallet-balance").innerText());
}

/** Lightning in a chat only pays requests; a direct Send is Lightning's too: an invoice of the payee's own card, paid from the payer's. */
async function payInvoiceOfCard(from: Actor, to: Actor, sats: number): Promise<void> {
  await wallet(to, "lightning");
  await to.page.getByTestId("wallet-receive").click();
  await to.page.getByTestId("wallet-receive-amount").fill(String(sats));
  await to.page.getByTestId("wallet-create-invoice").click();
  const invoice = (await to.page.getByTestId("wallet-invoice").innerText()).trim();
  expect(invoice).toMatch(/^lnbcrt/);
  await wallet(from, "lightning");
  await from.page.getByTestId("wallet-send").click();
  await from.page.getByTestId("wallet-pay-input").fill(invoice);
  await from.page.getByRole("button", { name: `Pay ${sats.toLocaleString("en")} sats` }).click();
  await from.page.getByRole("button", { name: either("Pay") }).click();
  await expect(from.page.getByTestId("wallet-notice")).toHaveText(either("Paid."), { timeout: 90_000 });
  await expect(to.page.getByTestId("wallet-paid")).toBeVisible({ timeout: 60_000 });
}

/** Sats the payer's node may spend on top of the amounts, over the whole block (a direct channel: none, in practice). */
const FEE_SLACK = 30;

async function lightningNode(a: Actor, b: Actor, rail: string, node: LightningNode): Promise<void> {
  await exclusive(node.lock, async () => {
    await node.ready?.();
    await node.connect(a, "alice");
    await node.connect(b, "bob");
    const start = { alice: await node.balance("alice"), bob: await node.balance("bob"), a: await cardBalance(a), b: await cardBalance(b) };
    // Lightning is each person's one wallet: every request carries an invoice of the asker's own node.

    await requestInChat(b, a, { card: "lightning", amount: "210", note: `${rail}: B asks A` });
    await requestInChat(a, b, { card: "lightning", amount: "120", note: `${rail}: A asks B` });
    // The chat's Send is refused on Lightning, with the reason; the direct payment goes card to card.
    await openChat(a);
    await paymentCard(a, "lightning");
    await expect(a.page.getByTestId("payment-send")).toBeDisabled();
    await a.page.keyboard.press("Escape");
    await payInvoiceOfCard(a, b, 50);

    // Bob's node: 210 in, 120 out, 50 in. Alice's: the other side of each, and any fee on what she paid.
    const moved = async (who: Who) => (await node.balance(who)) - start[who];
    await expect.poll(() => moved("bob"), { timeout: 60_000 }).toBeGreaterThanOrEqual(140 - FEE_SLACK);
    expect(await moved("bob")).toBeLessThanOrEqual(140);
    expect(await moved("alice")).toBeLessThanOrEqual(-140);
    expect(await moved("alice")).toBeGreaterThanOrEqual(-140 - FEE_SLACK);
    // Each card shows what its node did.
    for (const [actor, who, key] of [[a, "alice", "a"], [b, "bob", "b"]] as const) {
      const expected = await moved(who);
      await expect.poll(async () => (await cardBalance(actor)) - start[key], { timeout: 60_000 }).toBe(expected);
    }
  });
}

/* ---------- Breez (Spark), on Breez's own regtest ---------- */

async function breez(a: Actor, b: Actor): Promise<void> {
  const { counterpart } = await import("../support/breez");
  await exclusive("breez", async () => {
    const other = await counterpart();
    try {
      for (const p of [a, b]) {
        const source = await lightningSource(p, "breez", async (area) => {
          await area.getByTestId("breez-phrase-written").check();
          await area.getByTestId("provider-save").click();
        });
        await expect(source.getByTestId("lightning-source-status")).toContainText("regtest", { timeout: 90_000 });
      }
      // In: an invoice of A's Breez wallet, paid by the counterpart.
      await wallet(a, "lightning");
      await a.page.getByTestId("wallet-receive").click();
      await a.page.getByTestId("wallet-receive-amount").fill("1000");
      await a.page.getByTestId("wallet-create-invoice").click();
      await other.pay((await a.page.getByTestId("wallet-invoice").innerText()).trim());
      await expect(a.page.getByTestId("wallet-paid")).toBeVisible({ timeout: 90_000 });
      await requestInChat(b, a, { card: "lightning", amount: "300", note: "ln-breez: B asks A" });
      await requestInChat(a, b, { card: "lightning", amount: "100", note: "ln-breez: A asks B" });
      await payInvoiceOfCard(a, b, 50);
      // B: 300 in, 100 out and a small fee, 50 in. A: 1,000 in, the rest out, with fees.
      await expect.poll(() => cardBalance(b), { timeout: 90_000 }).toBeLessThanOrEqual(250);
      expect(await cardBalance(b)).toBeGreaterThanOrEqual(230);
      await expect.poll(() => cardBalance(a), { timeout: 90_000 }).toBeLessThanOrEqual(750);
      expect(await cardBalance(a)).toBeGreaterThanOrEqual(700);
    } finally {
      await other.close();
    }
  });
}

/* ---------- Ark: Arkade and Bark ---------- */

/** The four chat payments every wallet rail makes: A → B, a request of B's, B → A, a request of A's. */
async function bothWays(a: Actor, b: Actor, card: string, amounts: [number, number, number, number], ready?: (payer: Actor) => Promise<void>): Promise<void> {
  await ready?.(a);
  await sendInChat(a, b, { card, amount: String(amounts[0]), note: `${card}: A sends B` });
  await ready?.(a);
  await requestInChat(b, a, { card, amount: String(amounts[1]), note: `${card}: B asks A` });
  await ready?.(b);
  await sendInChat(b, a, { card, amount: String(amounts[2]), note: `${card}: B sends A` });
  await ready?.(b);
  await requestInChat(a, b, { card, amount: String(amounts[3]), note: `${card}: A asks B` });
}

/** The regtest chain, as the BDK suite drives it: `mine`, `send`, `tx`. */
const bdkRegtest = (...args: string[]) => execFileSync(process.execPath, ["e2e/support/bdk-regtest/regtest.mjs", ...args], { encoding: "utf8", stdio: "pipe" }).trim();

async function arkade(a: Actor, b: Actor): Promise<void> {
  const panel = (p: Actor) => p.page.getByTestId("ark-wallet");
  const sats = async (p: Actor) => amountIn(await panel(p).getByTestId("ark-balance").innerText());
  // Every coin of the story comes from A's funding batch, and arkd's regtest batches expire quickly
  // (e2e/infra: 180): B's wallet first, A funded last, so the payments start as soon as the coins exist.
  for (const p of [b, a]) {
    // New made it on Mutinynet; an empty wallet moves to the local regtest server.
    await wallet(p, "arkade-testnet");
    await panel(p).getByRole("radio", { name: either("Regtest") }).click({ timeout: 60_000 });
    await expect(panel(p).getByTestId("ark-balance")).toContainText("Regtest", { timeout: 60_000 });
    if (p === a) {
      const mnemonic = execFileSync(process.execPath, ["--experimental-eventsource", "e2e/support/fund-ark.mjs"], { encoding: "utf8", stdio: "pipe" }).trim();
      await panel(p).getByRole("button", { name: either("Restore") }).click();
      await panel(p).getByLabel(either("Recovery phrase")).fill(mnemonic);
      await panel(p).getByRole("button", { name: either("Restore from phrase") }).click();
    }
    await expect(panel(p).getByTestId("ark-address")).toBeVisible({ timeout: 60_000 });
  }
  await expect.poll(() => sats(a), { timeout: 60_000 }).toBe(9_900);
  // A regtest batch expires within minutes (e2e/infra: 180 s): coins that outlived theirs are recoverable, not
  // spendable, until the wallet's Recover moves them into a new batch — which a person does when the wallet
  // offers it. The server can recover only what it has swept, and its sweep waits for the chain's time to
  // pass the expiry: an idle regtest chain has no blocks to move it, so the test mines while it recovers.
  const recovered = async (p: Actor) => {
    await wallet(p, "arkade");
    const recoverable = panel(p).getByTestId("ark-recoverable");
    if (!(await recoverable.isVisible())) return;
    await expect(async () => {
      bdkRegtest("mine", "3");
      if (await recoverable.isVisible()) await panel(p).getByTestId("ark-recover").click();
      await expect(recoverable).toHaveCount(0, { timeout: 20_000 });
    }, `${p.name}'s expired coins are recovered`).toPass({ timeout: 180_000 });
    // Recovered into the next batch: spendable again once that round is done.
    await expect.poll(() => sats(p), { timeout: 120_000, message: `${p.name}'s recovered coins are back` }).toBeGreaterThan(0);
  };
  await bothWays(a, b, "arkade", [500, 100, 200, 50], recovered);
  // A: 9,900 − 500 − 100 + 200 + 50; B: 500 + 100 − 200 − 50, less what the recoveries cost (a few sats
  // each, to the new batch).
  for (const [p, expected] of [[a, 9_550], [b, 350]] as const) {
    await recovered(p);
    await expect.poll(() => sats(p), { timeout: 60_000 }).toBeLessThanOrEqual(expected);
    expect(await sats(p)).toBeGreaterThanOrEqual(expected - 60);
  }
}

const barkRegtest = (...args: string[]) => execFileSync(process.execPath, ["e2e/support/bark-regtest/regtest.mjs", ...args], { encoding: "utf8", stdio: "pipe" }).trim();

async function bark(a: Actor, b: Actor): Promise<void> {
  const panel = (p: Actor) => p.page.getByTestId("bark-wallet");
  const sats = async (p: Actor) => amountIn(await panel(p).getByTestId("bark-balance").innerText());
  for (const p of [a, b]) {
    await wallet(p, "bark-testnet");
    // New made it on signet; an empty wallet makes way for the local regtest server.
    await panel(p).getByRole("radio", { name: either("Regtest") }).click({ timeout: 90_000 });
    await expect(panel(p).getByTestId("bark-balance")).toContainText("Regtest", { timeout: 90_000 });
    await expect(panel(p).getByTestId("bark-address")).toHaveText(/tark1p/, { timeout: 60_000 });
  }
  // In over Ark: the environment's funder wallet pays A's address (one payment at a time from it).
  const address = (await panel(a).getByTestId("bark-address").innerText()).trim();
  await exclusive("bark-funder", async () => {
    barkRegtest("ready");
    expect(JSON.parse(barkRegtest("pay", address, "20000"))).toMatchObject({ status: "successful" });
  });
  await expect.poll(() => sats(a), { timeout: 60_000 }).toBe(20_000);
  await bothWays(a, b, "bark", [2_000, 1_000, 500, 400]);
  // Payments between Bark wallets of one server cost nothing.
  await wallet(a, "bark");
  await expect.poll(() => sats(a), { timeout: 60_000 }).toBe(20_000 - 2_000 - 1_000 + 500 + 400);
  await wallet(b, "bark");
  await expect.poll(() => sats(b), { timeout: 60_000 }).toBe(2_000 + 1_000 - 500 - 400);
}

/* ---------- Bitcoin on-chain through BDK ---------- */


async function bdk(a: Actor, b: Actor): Promise<void> {
  const { BDK_REGTEST } = await import("../support/bdk-regtest/regtest.mjs");
  bdkRegtest("ready");
  const panel = (p: Actor) => p.page.getByTestId("bitcoin-wallet");
  const balance = (p: Actor) => panel(p).getByTestId("bitcoin-balance");
  const refreshed = async (p: Actor) => { await panel(p).getByRole("button", { name: either("Refresh now") }).click(); return amountIn(await balance(p).innerText()); };
  const mine = () => { bdkRegtest("mine", "1"); };
  const address: Partial<Record<string, string>> = {};
  for (const p of [a, b]) {
    // A Testnet Bitcoin wallet, made with New: BDK is the one on-chain source a browser runs, so New shows its form at once.
    await newWallet(p, "bitcoin", "testnet", { timeout: 90_000, fill: async (area) => {
      await area.getByTestId("bdk-written").check();
      await choose(area.getByTestId("provider-form-bdk").getByLabel(either("Network")), "regtest");
      await area.getByLabel(either("Esplora server")).fill(BDK_REGTEST.esplora);
      await area.getByTestId("provider-save").click();
    } });
    await wallet(p, "bitcoin-testnet");
    await expect(panel(p).getByTestId("onchain-source-status")).toContainText(/Connected/, { timeout: 60_000 });
    await panel(p).getByTestId("bitcoin-new-address").click();
    address[p.name] = (await panel(p).getByTestId("bitcoin-address").innerText()).trim();
    expect(address[p.name]).toMatch(/^bcrt1q/);
  }
  // In: the regtest miner pays A's address.
  bdkRegtest("send", address[a.name]!, "100000");
  await expect.poll(async () => { mine(); return refreshed(a); }, { timeout: 90_000, intervals: [3_000] }).toBe(100_000);

  // Every chat payment settles once its transaction confirms: mine while each one waits.
  await sendInChat(a, b, { card: "bitcoin", amount: "20000", note: "bitcoin: A sends B" }, mine);
  // B spends what it has received once it is confirmed on its side too. Its Send first, from its one coin: a
  // chat Send's fee cap is a fixed 2,000 sats, and the shared regtest chain's fee estimates (about 10 sat/vB,
  // the Lightning suites' channels) put a two-input transaction above it.
  await wallet(b, "bitcoin");
  await expect.poll(async () => { mine(); return refreshed(b); }, { timeout: 90_000, intervals: [3_000] }).toBe(20_000);
  await sendInChat(b, a, { card: "bitcoin", amount: "5000", note: "bitcoin: B sends A" }, mine);
  // A request's cap is the bubble's to raise.
  await requestInChat(b, a, { card: "bitcoin", amount: "3000", note: "bitcoin: B asks A", maxFee: "10000" }, mine);
  await requestInChat(a, b, { card: "bitcoin", amount: "2000", note: "bitcoin: A asks B", maxFee: "10000" }, mine);

  // B: 20,000 − 5,000 + 3,000 − 2,000 and its two fees; A: the rest, less its own two fees.
  const settledBalance = async (p: Actor) => {
    await wallet(p, "bitcoin");
    await expect.poll(async () => { mine(); await refreshed(p); return balance(p).innerText(); }, { timeout: 90_000, intervals: [3_000] }).not.toContain("unconfirmed");
    return refreshed(p);
  };
  const bFees = 16_000 - (await settledBalance(b));
  expect(bFees).toBeGreaterThan(0);
  expect(bFees).toBeLessThan(10_000);
  const aFees = 100_000 - 20_000 - 3_000 + 5_000 + 2_000 - (await settledBalance(a));
  expect(aFees).toBeGreaterThan(0);
  expect(aFees).toBeLessThan(10_000);
}

/* ---------- USDT on the local EVM chain ---------- */

async function usdt(a: Actor, b: Actor): Promise<void> {
  const { USDT_LOCAL } = await import("../support/usdt-local.mjs");
  let id = 0;
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(USDT_LOCAL.provider, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const result = await response.json();
    if (result.error) throw new Error(`local EVM: ${method} failed`);
    return result.result;
  };
  const panel = (p: Actor) => p.page.getByTestId("usdt-wallet");
  const tokens = (p: Actor) => panel(p).getByTestId("usdt-balance");
  const address: Partial<Record<string, string>> = {};
  for (const p of [a, b]) {
    // New made it on Sepolia; an empty wallet moves to the local chain.
    await wallet(p, "usdt-testnet");
    await panel(p).getByRole("radio", { name: either("Local test chain") }).click({ timeout: 60_000 });
    await panel(p).getByLabel(either("Token contract")).fill(USDT_LOCAL.token);
    await panel(p).getByRole("button", { name: either("Switch network") }).click();
    // Sepolia is also "TEST-USDT": wait for the local chain itself before reading the address.
    await expect(p.page.getByTestId("wallet-card-usdt-testnet")).toContainText("EVM local", { timeout: 60_000 });
    await expect(tokens(p)).toHaveText(/^0 TEST-USDT/, { timeout: 60_000 });
    address[p.name] = (await panel(p).getByTestId("usdt-address").innerText()).trim();
    // Gas for both.
    await rpc("anvil_setBalance", [address[p.name], "0xde0b6b3a7640000"]);
  }
  // In: 10 test tokens minted to A.
  const [minter] = await rpc("eth_accounts");
  const mint = new Interface(["function mint(address,uint256)"]).encodeFunctionData("mint", [address[a.name], 10_000_000n]);
  await rpc("eth_sendTransaction", [{ from: minter, to: USDT_LOCAL.token, data: mint }]);
  await rpc("evm_mine");
  await wallet(a, "usdt");
  await expect(tokens(a)).toHaveText(/^10 TEST-USDT/, { timeout: 30_000 });
  await bothWays(a, b, "usdt", [3, 2, 1, 1]);
  await wallet(a, "usdt");
  await expect(tokens(a), "10 in, 3 out, 2 out, 1 in, 1 in").toHaveText(/^7 TEST-USDT/, { timeout: 30_000 });
  await wallet(b, "usdt");
  await expect(tokens(b), "3 in, 2 in, 1 out, 1 out").toHaveText(/^3 TEST-USDT/, { timeout: 30_000 });
}

type Pair = { a: Actor; b: Actor };

/** The rails of e2e/infra (and Breez's regtest), by the matrix's rail id. */
export const INFRA_RAILS = {
  "ln-lnd": ({ a, b }: Pair) => lightningNode(a, b, "ln-lnd", LND),
  "ln-cln": ({ a, b }: Pair) => lightningNode(a, b, "ln-cln", CLN),
  "ln-nwc": ({ a, b }: Pair) => lightningNode(a, b, "ln-nwc", NWC),
  "ln-breez": ({ a, b }: Pair) => breez(a, b),
  // One chain under all three: BDK mines while it waits for confirmations, Bark mines to board, and arkd's
  // VTXOs expire after 180 blocks (e2e/infra), so an Ark payment next to a BDK one sees its coins expire.
  "ark-arkade": ({ a, b }: Pair) => exclusive("regtest-chain", () => arkade(a, b)),
  bark: ({ a, b }: Pair) => exclusive("regtest-chain", () => bark(a, b)),
  "btc-bdk": ({ a, b }: Pair) => exclusive("regtest-chain", () => bdk(a, b)),
  usdt: ({ a, b }: Pair) => usdt(a, b),
} as const;
