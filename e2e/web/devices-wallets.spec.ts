import { execFileSync } from "node:child_process";
import { TEST_COINS, chat, connect, createWallet, expect, getTestCoins, link, openChat, openWallet, test, walletCard, type Peer } from "../support/fixtures";
import { DEVICE_SET_PASSWORD, enrollDevice, untilShown } from "../support/devices";
import { mintEndpoint } from "../support/mint";
import { composerRow } from "../support/composer";
import { paymentCard } from "../support/payments";

/**
 * Wallets in a handoff (WISP 06 § Wallets, part 8). Test coins only: the suite's own Cashu mint (fake Lightning,
 * worthless sats) and e2e/infra's regtest federation. Every password here is a test value.
 *
 * - Testnet ecash moves with the profile: the whole balance is on the new device, the old one runs no wallet, and
 *   ecash the new device spent is refused by the mint when the old device's frozen copy offers it again.
 * - A Fedimint wallet stays on its home device: the new device shows it "On <device>" and never opens it; when the
 *   profile comes back, the home device opens it again from its own database.
 */

/** The ecash a device holds for the profile this page runs (or held, for a frozen copy), from storage. */
const storedProofs = (peer: Peer) => peer.page.evaluate(async () => {
  const registry = JSON.parse(localStorage.getItem("ghostly_profiles") ?? "null") as { active?: string; profiles?: { id: string; space?: string }[] } | null;
  const active = registry?.active ?? "";
  const ns = registry?.profiles?.find((p) => p.id === active)?.space ?? active;
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(ns ? `ghostly_${ns}` : "ghostly"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const rows = await new Promise<{ id: string; amount: number; secret: string; C: string; reserved?: boolean }[]>((resolve, reject) => { const r = db.transaction("proofs", "readonly").objectStore("proofs").getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  db.close();
  return rows.map(({ id, amount, secret, C }) => ({ id, amount, secret, C }));
});

/** The Cashu balance on the open wallet page, in sats. */
const sats = async (peer: Peer) => Number((await peer.page.getByTestId("wallet-balance").innerText()).replace(/[^\d]/g, ""));

/** Use here on `taker` with the lock password, until it is the active device and `giver` shows the standby screen. */
async function pull(taker: Peer, giver: Peer): Promise<void> {
  await taker.page.getByTestId("handoff-use-here").click();
  await taker.page.getByTestId("handoff-password").fill(DEVICE_SET_PASSWORD);
  await taker.page.getByTestId("handoff-start").click();
  await untilShown(taker.page, taker.page.getByTitle("New Chat"), { timeout: 400_000 });
  await untilShown(giver.page, giver.page.getByTestId("device-standby").and(giver.page.locator("[data-state=standby]")));
}

test("Testnet ecash moves with the profile: whole on the new device, no wallet on the old one, and what the new one spent is refused from the old copy", { tag: ["@feature:devices.handoff.wallets"] }, async ({ peer }) => {
  test.setTimeout(12 * 60_000);
  const [desktop, phone, contact] = await Promise.all([peer("desktop", { offlineMainnet: true }), peer("phone", { offlineMainnet: true }), peer("contact", { offlineMainnet: true })]);
  for (const p of [desktop, contact]) await createWallet(p, "cashu", "testnet");
  await link(desktop, contact);
  await connect(desktop, contact);
  await getTestCoins(desktop);
  await expect(desktop.page.getByTestId("wallet-balance")).toHaveText(/^10,000\s*test sats$/);
  const before = await storedProofs(desktop);
  expect(before.reduce((sum, p) => sum + p.amount, 0)).toBe(TEST_COINS);

  await enrollDevice(desktop, phone);
  await pull(phone, desktop);

  // The whole balance is on the new device, checked with the mint once there (every proof was still unspent).
  await openWallet(phone, "cashu-testnet");
  await expect(phone.page.getByTestId("wallet-balance")).toHaveText(/^10,000\s*test sats$/, { timeout: 60_000 });
  expect((await storedProofs(phone)).map((p) => p.secret).sort()).toEqual(before.map((p) => p.secret).sort());

  // The old device runs no wallet: its pages are the standby screen, the wallet page included.
  await desktop.page.goto("/#/wallet");
  await untilShown(desktop.page, desktop.page.getByTestId("device-standby"));
  await expect(desktop.page.getByTestId("wallet-chip")).toHaveCount(0);
  await expect(desktop.page.getByTestId("wallet-balance")).toHaveCount(0);

  // The new device spends: ecash to the contact, in the chat that moved with the profile.
  await phone.page.getByTestId("sidebar").getByTestId("chat-row").first().click();
  await (await composerRow(phone.page, "payment-button")).click();
  await paymentCard(phone.page, "cashu-testnet").click();
  await phone.page.getByTestId("payment-amount").fill("6000");
  await phone.page.getByTestId("payment-send").click();
  await phone.page.getByTestId("payment-composer").getByTestId("payment-review").getByRole("button", { name: "Approve payment" }).click();
  await expect(chat(contact).getByTestId("payment-bubble").filter({ hasText: "6,000" }).getByTestId("payment-state")).toHaveText(/Received/, { timeout: 180_000 });
  await openWallet(phone, "cashu-testnet");
  await expect.poll(() => sats(phone), { timeout: 60_000 }).toBeLessThan(TEST_COINS - 6000 + 1);

  // The frozen copy on the old device still holds every proof it had. Each is either spent (the mint refuses it
  // again) or still the new device's own: none can be spent twice.
  const frozen = await storedProofs(desktop);
  expect(frozen.map((p) => p.secret).sort()).toEqual(before.map((p) => p.secret).sort());
  const { Wallet } = await import("@cashu/cashu-ts");
  const mint = new Wallet(mintEndpoint(), { unit: "sat" });
  await mint.loadMint();
  const states = await mint.checkProofsStates(frozen);
  const spent = frozen.filter((_, i) => states[i]?.state === "SPENT");
  expect(spent.length, "the new device spent some of the ecash it was given").toBeGreaterThan(0);
  await expect(mint.receive(spent), "spent ecash from the frozen copy").rejects.toThrow(/spent/i);
  const held = new Set((await storedProofs(phone)).map((p) => p.secret));
  for (const proof of frozen.filter((p) => !spent.includes(p))) expect(held.has(proof.secret), "an unspent proof is the new device's").toBe(true);
  await openChat(contact);
});

test("a Fedimint wallet stays on its home device: On <device> on the new one, never opened there, and opened again at home", { tag: ["@gated", "@feature:devices.handoff.wallets"] }, async ({ peer }) => {
  test.skip(process.env.GHOSTLY_FEDIMINT_REGTEST !== "1", "Requires e2e/infra's federation (npm run e2e:infra:up) and GHOSTLY_FEDIMINT_REGTEST=1");
  test.setTimeout(14 * 60_000);
  const { invite } = JSON.parse(execFileSync(process.execPath, ["e2e/support/fedimint-regtest/regtest.mjs", "ready"], { encoding: "utf8", stdio: "pipe" }).trim()) as { invite: string };
  const [desktop, phone] = await Promise.all([peer("desktop", { offlineMainnet: true }), peer("phone", { offlineMainnet: true })]);
  await createWallet(desktop, "fedimint", "testnet", { invite, timeout: 120_000 });
  await expect(walletCard(desktop.page, "fedimint-testnet")).toBeVisible();

  await enrollDevice(desktop, phone);
  await pull(phone, desktop);

  // On the new device the card says where the wallet is, and its panel how to use it; nothing of it opens here.
  await openWallet(phone, "fedimint-testnet");
  await expect(walletCard(phone.page, "fedimint-testnet")).toContainText("Elsewhere");
  const away = phone.page.getByTestId("wallet-away");
  await expect(away).toContainText("Fedimint can't be used here. Use it on");
  await expect(phone.page.getByTestId("fedimint-invite")).toHaveCount(0);

  // Back home, with Move to from the phone: the desktop's own database opens again, and the wallet is usable there.
  await phone.page.goto("/#/profile");
  const row = phone.page.getByTestId("device-row").filter({ has: phone.page.getByTestId("device-move") }).first();
  await expect(row.getByTestId("device-link-status")).toHaveAttribute("data-status", "live", { timeout: 90_000 });
  await row.getByTestId("device-move").click();
  await expect(desktop.page.getByTestId("handoff-offer")).toBeVisible({ timeout: 60_000 });
  await desktop.page.getByTestId("handoff-accept").click();
  await untilShown(desktop.page, desktop.page.getByTitle("New Chat"), { timeout: 400_000 });
  await openWallet(desktop, "fedimint-testnet");
  await expect(desktop.page.getByTestId("wallet-away")).toHaveCount(0);
  await expect(walletCard(desktop.page, "fedimint-testnet")).not.toContainText("Elsewhere", { timeout: 120_000 });
});
