import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, type Peer } from "../support/fixtures";
import { choose } from "../support/select";

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
 * A composer button. On a phone the less used ones (file, GIF, ⚡) live behind "More",
 * which closes again after each use.
 */
export async function composerButton(actor: Actor, button: (a: Actor) => Locator): Promise<Locator> {
  if (actor.phone && !(await button(actor).isVisible())) await actor.page.getByTestId("composer-more").click();
  return button(actor);
}

export async function say(actor: Actor, text: string): Promise<void> {
  const box = actor.page.getByPlaceholder("Message…");
  await expect(box).toBeEnabled({ timeout: 60_000 });
  await box.fill(text);
  await box.press("Enter");
  await expect(chatPane(actor).getByText(text, { exact: true })).toBeVisible();
}

export const sees = (actor: Actor, text: string, timeout = 90_000) =>
  expect(chatPane(actor).getByText(text, { exact: true }).first()).toBeVisible({ timeout });

/** The payment composer on this person's chat, with the card of one rail turned over (a track on a phone). */
export async function paymentCard(actor: Actor, card: string): Promise<void> {
  const button = await composerButton(actor, (a) => a.page.getByTestId("payment-button"));
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  const composer = actor.page.getByTestId("payment-composer");
  if ((await composer.locator(".wallet-deck").getAttribute("data-mode")) === "track") {
    const target = actor.page.getByTestId(`payment-card-${card}`);
    for (let i = 0; i < 8 && (await target.getAttribute("aria-checked")) !== "true"; i++) await actor.page.getByTestId("payment-deck-next").click();
    await expect(target).toHaveAttribute("aria-checked", "true");
    await actor.page.getByTestId("payment-use").click();
  } else {
    await actor.page.getByTestId(`payment-card-${card}`).click();
  }
  await expect(actor.page.getByTestId("payment-amount")).toBeVisible();
}

/** The wallet page, with one card in front. */
export async function wallet(actor: Actor, card?: string): Promise<void> {
  await go(actor, "#/wallet");
  await expect(actor.page.getByTestId("wallet")).toBeVisible();
  if (!card) return;
  const target = actor.page.getByTestId(`wallet-card-${card}`);
  await expect(async () => {
    await target.click();
    await expect(target).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

export async function useTestnet(actor: Actor): Promise<void> {
  await wallet(actor);
  await actor.page.getByTestId("wallet-mode").getByRole("radio", { name: either("Testnet") }).click();
  await expect(actor.page.getByTestId("testnet-notice")).toBeVisible();
}

/** The chat's Options menu, then one of its entries. */
export async function chatOption(actor: Actor, testId: string): Promise<void> {
  await actor.page.getByTitle("Options").click();
  await actor.page.getByTestId(testId).click();
}
