import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { createWallet, expect, type CreateWallet, type Peer, type WalletKind, type WalletNetwork } from "../support/fixtures";
import { choose } from "../support/select";
import { composerRow } from "../support/composer";

/**
 * A person in a scenario: a web or extension peer, with the language and the
 * screen size the combination gave them. The building blocks only ever go
 * through these helpers, so the same block runs for every kind of client, in
 * English and in Portuguese, on a laptop and on a phone.
 */
export interface Actor extends Peer {
  kind: "web" | "extension";
  locale: "en" | "pt";
  phone: boolean;
  /** Where this person's 1:1 chat with the other one lives (`#/chat/…`), once there is one. */
  chatHash?: string;
}

type Tree = { [key: string]: string | Tree };
const flatten = (tree: Tree, prefix = ""): [string, string][] =>
  Object.entries(tree).flatMap(([k, v]) => (typeof v === "string" ? [[`${prefix}${k}`, v] as [string, string]] : flatten(v, `${prefix}${k}.`)));
const locales = join(import.meta.dirname, "..", "..", "src", "locales");
const en = new Map(flatten(JSON.parse(readFileSync(join(locales, "en.json"), "utf8"))));
const pt = new Map(flatten(JSON.parse(readFileSync(join(locales, "pt.json"), "utf8"))));

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The English text or any Portuguese translation of it, exactly: one locator for both languages.
 * Text the app does not translate (hard-coded) is simply matched as it is.
 */
export function either(english: string): RegExp {
  const translations = new Set([english]);
  for (const [key, value] of en) if (value === english && pt.get(key)) translations.add(pt.get(key)!);
  return new RegExp(`^(?:${[...translations].map(escape).join("|")})$`);
}

/** The open conversation, not the chat list. */
export const chatPane = (actor: Peer) => actor.page.locator(".chat-wallpaper");

/** Hash navigation works the same in the web app and in the extension's app page. */
export async function go(actor: Actor, hash: string): Promise<void> {
  // A page that is reloading (a profile switched after a restore) has no context to run in for a moment.
  await expect(() => actor.page.evaluate((h) => { location.hash = h; }, hash)).toPass({ timeout: 30_000 });
}

export async function home(actor: Actor): Promise<void> {
  await go(actor, "#/");
  await expect(actor.page.getByTitle(either("New Chat"))).toBeVisible();
}

export async function openChat(actor: Actor): Promise<void> {
  if (!actor.chatHash) throw new Error(`${actor.name} has no chat yet`);
  await go(actor, actor.chatHash);
  await expect(chatPane(actor)).toBeVisible();
}

export async function setLanguage(actor: Actor, locale: "en" | "pt"): Promise<void> {
  await go(actor, "#/settings");
  await choose(actor.page.getByTestId("settings-language"), locale);
  await expect(actor.page.getByRole("heading", { name: locale === "pt" ? "Configurações" : "Settings", exact: true })).toBeVisible();
  actor.locale = locale;
  await home(actor);
}

/** A person's own state after a reload (a wallet or signer injected in the page): the app is back up. */
export async function reloaded(actor: Actor): Promise<void> {
  await actor.page.reload();
  await home(actor);
}

/** The name contacts see: it travels with each message, so it is set before the first one. */
export async function nickname(actor: Actor, name: string): Promise<void> {
  await go(actor, "#/profile");
  await actor.page.getByTestId("account-nickname").fill(name);
  await expect(actor.page.getByTestId("account-nickname")).toHaveValue(name);
  await home(actor);
}

/**
 * A row of the composer's + menu (payment, identity, document, photos), on every screen size: the + opens it (a sheet on
 * a phone). The file inputs themselves are always in the page; `setInputFiles` needs no menu.
 */
export const composerButton = (actor: Actor, testId: string): Promise<Locator> => composerRow(actor.page, testId);

export async function say(actor: Actor, text: string): Promise<void> {
  const box = actor.page.getByPlaceholder("Message…");
  await expect(box).toBeEnabled({ timeout: 60_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(chatPane(actor).getByText(text, { exact: true })).toBeVisible();
}

export const sees = (actor: Actor, text: string, timeout = 90_000) =>
  expect(chatPane(actor).getByText(text, { exact: true }).first()).toBeVisible({ timeout });

/**
 * A card by name: one wallet's (`cashu-testnet`, `lightning-mainnet`), or a kind alone for the first card of that kind
 * (a scenario has one wallet of each kind it pays with). Card ids are `<prefix>-<kind>-<network>`.
 */
const card = (actor: Actor, prefix: "payment-card" | "wallet-card", name: string): Locator =>
  name.includes("-") ? actor.page.getByTestId(`${prefix}-${name}`) : actor.page.locator(`[data-testid^="${prefix}-${name}-"]`).first();

/** The payment composer on this person's chat, with one wallet's card turned over (a track on a phone). */
export async function paymentCard(actor: Actor, name: string): Promise<void> {
  const button = await composerButton(actor, "payment-button");
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  const composer = actor.page.getByTestId("payment-composer");
  const target = card(actor, "payment-card", name);
  if ((await composer.locator(".wallet-deck").getAttribute("data-mode")) === "track") {
    for (let i = 0; i < 8 && (await target.getAttribute("aria-checked")) !== "true"; i++) await actor.page.getByTestId("payment-deck-next").click();
    await expect(target).toHaveAttribute("aria-checked", "true");
    await actor.page.getByTestId("payment-use").click();
  } else {
    await target.click();
  }
  await expect(actor.page.getByTestId("payment-amount")).toBeVisible();
}

/** The wallet page, with one wallet's card in front (see `card` for its name). */
export async function wallet(actor: Actor, name?: string): Promise<void> {
  await go(actor, "#/wallet");
  await expect(actor.page.getByTestId("wallet")).toBeVisible();
  if (!name) return;
  const target = card(actor, "wallet-card", name);
  await expect(async () => {
    await target.click();
    await expect(target).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * A wallet of one kind on one network, made with Wallets → New as a person does (support/fixtures.ts `createWallet`: a
 * source and its form where the kind needs one), checked by the app before its card appears. A new profile has none.
 * The dialog's words (Testnet, Mainnet, Source) are the same in every language.
 */
export async function newWallet(actor: Actor, kind: WalletKind, network: WalletNetwork, options: CreateWallet = {}): Promise<void> {
  await wallet(actor);
  await createWallet(actor, kind, network, options);
}

/** Wallets → New on one network, the dialog left open to read what it offers there. */
export async function newWalletDialog(actor: Actor, network: WalletNetwork): Promise<Locator> {
  await wallet(actor);
  await actor.page.getByTestId("wallet-add").click();
  const dialog = actor.page.getByTestId("new-wallet");
  await dialog.getByRole("radio", { name: network === "testnet" ? "Testnet" : "Mainnet" }).click();
  await expect(dialog.getByTestId("new-wallet-network")).toHaveAttribute("data-network", network);
  return dialog;
}

/** The chat's Options menu, then one of its entries. */
export async function chatOption(actor: Actor, testId: string): Promise<void> {
  await actor.page.getByTestId("chat-options").click();
  await actor.page.getByTestId(testId).click();
}
