// Shared by the three screenshot specs: two peers on the built web app, finding each other
// through the e2e suite's in-process Pkarr relay, dressed up as Boo and Casper. Nothing here
// needs the network.
import { expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalRelay } from "../../../e2e/support/relay";
import { copyInvite, pasteInvite } from "../../../e2e/support/clipboard";

/** The repository root; this file lives in website/scripts/capture/. */
export const REPO = fileURLToPath(new URL("../../..", import.meta.url));
/** Where the PNGs land (`SHOTS=<dir>` overrides). They are converted to .webp before being committed; see README.md. */
export const OUT = process.env.SHOTS ?? join(REPO, "website/public/screenshots/current");
/** `ONLY=chat,file` saves just the shots whose file name starts with one of these. */
const ONLY = process.env.ONLY?.split(",");
mkdirSync(OUT, { recursive: true });

export type Peer = { name: string; page: Page };
export const DESKTOP = { width: 1280, height: 820 };
export const PHONE = { width: 390, height: 844 };
/** What a peer's context may use by default: the invite flow copies and pastes. */
export const CLIPBOARD = ["clipboard-read", "clipboard-write"];

/** A peer on the app: its own context, the relay answering its Pkarr requests, the chat list on screen. */
export async function open(browser: Browser, relay: LocalRelay, baseURL: string, name: string, mobile = false, permissions: string[] = CLIPBOARD): Promise<Peer> {
  const context = await browser.newContext({
    baseURL, colorScheme: "dark", deviceScaleFactor: 2, locale: "en-US",
    permissions,
    viewport: mobile ? PHONE : DESKTOP,
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  await relay.attach(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] ${e.message}`));
  await page.goto("/");
  await expect(page.getByTitle("New Chat").first()).toBeVisible();
  return { name, page };
}

export async function shot(p: Peer, file: string) {
  if (ONLY && !ONLY.some((o) => file.startsWith(o))) return;
  const vp = p.page.viewportSize()!;
  await p.page.mouse.move(vp.width > 600 ? 1000 : 200, vp.width > 600 ? 40 : 20); // park the pointer: no hover states
  await p.page.waitForTimeout(700);
  await p.page.screenshot({ path: join(OUT, file) });
  console.log("  saved", file);
}

export async function setNickname(p: Peer, nick: string) {
  await p.page.goto("/#/settings");
  const box = p.page.getByPlaceholder("Enter your nickname...");
  await box.fill(nick);
  await box.press("Enter").catch(() => {});
  await p.page.goto("/#/");
}

/** A small avatar drawn on a canvas: an emoji ghost on a colored disc. */
export async function avatar(p: Peer, bg: string, glyph: string): Promise<Buffer> {
  const bytes = await p.page.evaluate(({ bg, glyph }) => {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const g = c.getContext("2d")!;
    g.fillStyle = bg; g.fillRect(0, 0, 256, 256);
    g.font = "170px 'Apple Color Emoji'"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(glyph, 128, 142);
    return Array.from(atob(c.toDataURL("image/png").split(",")[1]), (ch) => ch.charCodeAt(0));
  }, { bg, glyph });
  return Buffer.from(bytes);
}

/** A little night scene for the file shot. */
export async function sceneImage(p: Peer): Promise<Buffer> {
  const bytes = await p.page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 640; c.height = 420;
    const g = c.getContext("2d")!;
    const sky = g.createLinearGradient(0, 0, 0, 420); sky.addColorStop(0, "#1b1440"); sky.addColorStop(1, "#4b2a6b");
    g.fillStyle = sky; g.fillRect(0, 0, 640, 420);
    g.fillStyle = "#f7f1c8"; g.beginPath(); g.arc(500, 100, 55, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 40; i++) { g.fillStyle = "rgba(255,255,255,.7)"; g.fillRect((i * 97) % 640, (i * 53) % 220, 2, 2); }
    g.fillStyle = "#120c24";
    g.fillRect(150, 220, 220, 200); g.beginPath(); g.moveTo(130, 225); g.lineTo(260, 120); g.lineTo(390, 225); g.fill();
    g.fillRect(320, 140, 30, 70);
    g.fillStyle = "#ffcf5a"; g.fillRect(185, 260, 40, 45); g.fillRect(295, 260, 40, 45); g.fillRect(240, 340, 40, 80);
    g.fillStyle = "#0b0718"; g.fillRect(0, 395, 640, 25);
    g.font = "90px 'Apple Color Emoji'"; g.fillText("👻", 440, 330);
    return Array.from(atob(c.toDataURL("image/png").split(",")[1]), (ch) => ch.charCodeAt(0));
  });
  return Buffer.from(bytes);
}

export async function say(p: Peer, text: string) {
  const box = p.page.getByPlaceholder("Message…");
  await box.fill(text);
  await box.press("Enter");
}
export const chat = (p: Peer) => p.page.locator(".chat-wallpaper");
/** Scroll the open conversation to its newest message (a real scroll, nothing else touched). */
export async function toBottom(p: Peer) {
  await p.page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>(".chat-wallpaper, .chat-wallpaper *")) {
      if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY.match(/auto|scroll/)) el.scrollTop = el.scrollHeight;
    }
  });
  await p.page.waitForTimeout(400);
}

/** The host makes an invite, the guest pastes it; `beforeJoin` runs while the invite card is up. */
export async function pair(host: Peer, guest: Peer, beforeJoin?: () => Promise<void>) {
  await host.page.getByTitle("New Chat").click();
  await expect(host.page.getByTestId("invite-card")).toBeVisible();
  if (beforeJoin) await beforeJoin();
  const invite = await copyInvite(host.page);
  await guest.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(guest.page, invite);
  for (const p of [host, guest]) await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
}

/** One line of a conversation: who types it, and what. */
export type Line = readonly [speaker: "boo" | "casper", text: string];
/** The exchange behind the chat and file shots. */
export const SMALL_TALK: readonly Line[] = [
  ["casper", "who goes there?"],
  ["boo", "just a friendly ghost 👻"],
  ["casper", "phew. no servers listening in?"],
  ["boo", "nope, just you and me. end to end."],
  ["casper", "spooky good. haunting the old house tonight?"],
];
/** Each line is typed by its speaker and awaited on the other peer's screen. */
export async function converse(boo: Peer, casper: Peer, script: readonly Line[] = SMALL_TALK) {
  for (const [speaker, text] of script) {
    const [from, to] = speaker === "boo" ? [boo, casper] : [casper, boo];
    await say(from, text);
    await expect(chat(to).getByText(text)).toBeVisible();
  }
}

/** Profile names and pictures, set through the real profile page. */
export async function dressUp(boo: Peer, casper: Peer) {
  for (const [p, bg, glyph, pname] of [[boo, "#7c5cff", "👻", "Boo"], [casper, "#2bb6a3", "🕯️", "Casper"]] as const) {
    await p.page.goto("/#/profile").catch(() => {});
    if (!await p.page.getByTestId("profile-page").isVisible()) await p.page.getByTestId("account-profile").click();
    await expect(p.page.getByTestId("profile-page")).toBeVisible();
    await p.page.getByTestId("profile-name").fill(pname);
    await p.page.getByTestId("profile-name").press("Enter");
    await p.page.getByTestId("profile-avatar-input").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: await avatar(p, bg, glyph) });
    await expect(p.page.getByTestId("profile-avatar-remove")).toBeVisible();
    await p.page.goto("/#/");
    await expect(p.page.getByTitle("New Chat").first()).toBeVisible();
  }
}
