import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, openWallet, test, type Peer } from "../support/fixtures";

/**
 * The self-custodial wallets' backups: the recovery phrase shown only on request, and a backup
 * file sealed with a password. Talks to the real default providers (arkade.computer, an Ethereum
 * RPC) for the wallets to be ready, but moves no funds.
 *
 * The phrase is money. These tests count its words and compare it with the file inside the test;
 * it is never printed, logged or put in an assertion message.
 */

/** Waits until the wallet is ready: an address to receive on. */
async function ready(p: Peer, card: "arkade" | "usdt"): Promise<Locator> {
  await openWallet(p, card);
  const panel = p.page.getByTestId(card === "arkade" ? "ark-wallet" : "usdt-wallet");
  await expect(panel.getByTestId(card === "arkade" ? "ark-address" : "usdt-address")).toBeVisible({ timeout: 90_000 });
  return panel;
}

/** Shows the phrase, reads it, hides it again. Returns its words; never prints them. */
async function phraseWords(panel: Locator, slug: "ark" | "usdt"): Promise<string[]> {
  await expect(panel.getByTestId(`${slug}-recovery`)).toHaveCount(0);
  await panel.getByRole("button", { name: "Show", exact: true }).click();
  const shown = panel.getByTestId(`${slug}-recovery`);
  await expect(shown).toBeVisible();
  const words = (await shown.innerText()).trim().split(/\s+/);
  expect([12, 24], "a BIP-39 phrase").toContain(words.length);
  expect(words.every((w) => /^[a-z]{3,8}$/.test(w)), "every word is a lowercase BIP-39 word").toBe(true);
  await panel.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(panel.getByTestId(`${slug}-recovery`)).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Show", exact: true })).toBeVisible();
  return words;
}

/** Downloads the wallet backup with a password; returns the file's text. */
async function downloadBackup(page: Page, panel: Locator, name: "Ark" | "USDT"): Promise<{ file: string; text: string }> {
  await panel.getByRole("button", { name: "Download", exact: true }).click();
  const password = panel.getByLabel(`${name} backup password`, { exact: true });
  await expect(password).toBeFocused();
  const submit = panel.getByRole("button", { name: "Download", exact: true });
  await password.fill("eleven-char");
  await expect(submit, "a password shorter than 12 characters is not enough").toBeDisabled();
  await password.fill("a long enough test password");
  await expect(submit).toBeEnabled();
  const downloading = page.waitForEvent("download");
  await submit.click();
  const download = await downloading;
  const text = readFileSync(await download.path(), "utf8");
  // The form closes once the file is out.
  await expect(password).toHaveCount(0);
  return { file: download.suggestedFilename(), text };
}

/** The file is sealed: neither the phrase nor any run of its words is in it. Compared here, never printed. */
function expectSealed(text: string, words: string[], format: string): void {
  const envelope = JSON.parse(text) as Record<string, unknown>;
  expect(envelope.format).toBe(format);
  expect(envelope.version).toBe(1);
  expect(typeof envelope.vault === "string" || (typeof envelope.vault === "object" && envelope.vault !== null)).toBe(true);
  const lower = text.toLowerCase();
  expect(lower.includes(words.join(" ")), "the phrase is not in the file").toBe(false);
  const pairs = words.slice(1).filter((w, i) => new RegExp(`(^|[^a-z])${words[i]}[^a-z]{1,4}${w}([^a-z]|$)`).test(lower));
  expect(pairs.length, "no two words of the phrase follow each other in the file").toBe(0);
  // Encrypted bytes can spell a short word now and then; a phrase in the clear would show most of them.
  const loose = words.filter((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(lower));
  expect(loose.length, "the words of the phrase are not in the file").toBeLessThan(3);
}

// A failure must not keep the phrase on disk: no trace, screenshot or video of these pages.
test.use({ trace: "off", screenshot: "off", video: "off" });

test.describe("wallet backups", { tag: "@network" }, () => {
  test.describe.configure({ retries: 2 });

  test("Ark: the phrase shows on request, and the backup file is sealed", { tag: ["@feature:wallet.ark.backup"] }, async ({ peer }) => {
    const alice = await peer("ark-backup");
    const panel = await ready(alice, "arkade");
    const words = await phraseWords(panel, "ark");
    const { file, text } = await downloadBackup(alice.page, panel, "Ark");
    expect(file).toBe("ghostly-ark-backup.json");
    expectSealed(text, words, "ghostly-ark-encrypted");
    // Showing it again gives the same wallet's phrase.
    expect((await phraseWords(panel, "ark")).join(" ") === words.join(" "), "the same phrase").toBe(true);
  });

  test("USDT: the phrase shows on request, and the backup file is sealed", { tag: ["@feature:wallet.usdt.backup"] }, async ({ peer }) => {
    const alice = await peer("usdt-backup");
    const panel = await ready(alice, "usdt");
    const words = await phraseWords(panel, "usdt");
    const { file, text } = await downloadBackup(alice.page, panel, "USDT");
    expect(file).toBe("ghostly-usdt-backup.json");
    expectSealed(text, words, "ghostly-usdt-encrypted");
    expect((await phraseWords(panel, "usdt")).join(" ") === words.join(" "), "the same phrase").toBe(true);
  });

  test("the two wallets have phrases of their own", { tag: ["@feature:wallet.usdt.backup", "@feature:wallet.ark.backup"] }, async ({ peer }) => {
    const alice = await peer("two-phrases");
    const ark = await phraseWords(await ready(alice, "arkade"), "ark");
    const usdt = await phraseWords(await ready(alice, "usdt"), "usdt");
    expect(ark.join(" ") === usdt.join(" "), "one phrase for both wallets").toBe(false);
  });

  test("Ark on-chain receive shows a Bitcoin boarding address", { tag: ["@feature:wallet.ark.boarding"] }, async ({ peer }) => {
    const alice = await peer("ark-boarding");
    // The explorer (mempool.space) is often slow to answer from CI and from here; it only reads the
    // on-chain balance. It answers "nothing there" at once, so the test is about the address.
    await alice.context.route(/^https:\/\/mempool\.space\/api\/address\/[^/]+\/(utxo|txs)/, (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" }));
    const panel = await ready(alice, "arkade");
    const via = panel.getByRole("radiogroup", { name: "Receive on" });
    await expect(via.getByRole("radio", { name: "Ark (instant)" })).toHaveAttribute("aria-checked", "true");
    await via.getByRole("radio", { name: "Bitcoin on-chain" }).click();
    await expect(via.getByRole("radio", { name: "Bitcoin on-chain" })).toHaveAttribute("aria-checked", "true");
    await expect(panel.getByTestId("ark-address")).toHaveCount(0);
    // Until the provider answers there is a notice, never a QR code of nothing; then the address.
    const address = panel.getByTestId("ark-boarding-address");
    await expect(address.or(panel.getByTestId("ark-boarding-address-pending"))).toBeVisible();
    await expect(address).toHaveText(/^\s*(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{8,87}\s*$/, { timeout: 60_000 });
    await expect(panel.getByTestId("ark-boarding-address-pending")).toHaveCount(0);
    // The QR code of that same address (PayExternally names its QR by `<testId>-qr`).
    await expect(panel.getByTestId("ark-boarding-address-qr").getByRole("img", { name: "Payment QR code" })).toBeVisible();
    await expect(panel.getByText("Send from any Bitcoin wallet.", { exact: false })).toBeVisible();
    // Mainnet by default: a real Bitcoin address, and a Taproot one.
    await expect(address).toHaveText(/^\s*bc1p/);
    // And back: the Ark address again.
    await via.getByRole("radio", { name: "Ark (instant)" }).click();
    await expect(panel.getByTestId("ark-address")).toHaveText(/^\s*ark1/);
  });

  // The boarding address is this wallet's own: it shows before the explorer answers, however slow.
  test("the boarding address does not wait for a slow explorer", { tag: ["@feature:wallet.ark.boarding"] }, async ({ peer }) => {
    const alice = await peer("ark-boarding-slow");
    // mempool.space never answers.
    await alice.context.route(/^https:\/\/mempool\.space\//, () => new Promise<void>(() => {}));
    const panel = await ready(alice, "arkade");
    await panel.getByRole("radiogroup", { name: "Receive on" }).getByRole("radio", { name: "Bitcoin on-chain" }).click();
    await expect(panel.getByTestId("ark-boarding-address")).toHaveText(/^\s*bc1p/, { timeout: 15_000 });
  });
});
