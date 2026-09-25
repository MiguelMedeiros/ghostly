// Shared by the capture specs: people on the built web app, finding each other through the e2e
// suite's in-process Pkarr relay, each with a name, a picture and something to say. Wallets reach
// the shared regtest environment (e2e/infra, `.env.e2e`) and nothing else: test coins only.
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalRelay } from "../../../e2e/support/relay";
import { copyInvite, pasteInvite } from "../../../e2e/support/clipboard";
import { attachMint } from "../../../e2e/support/mint";
import { MAINNET_SERVICES } from "../../../e2e/support/fixtures";

/** The repository root; this file lives in website/scripts/capture/. */
export const REPO = fileURLToPath(new URL("../../..", import.meta.url));
/** Where the PNGs land (`SHOTS=<dir>` overrides). run.mjs turns them into .webp; see README.md. */
export const OUT = process.env.SHOTS ?? join(REPO, "website/public/screenshots/current");
/** `ONLY=chat,file` saves just the shots whose file name starts with one of these. */
const ONLY = process.env.ONLY?.split(",").filter(Boolean);
mkdirSync(OUT, { recursive: true });

export type Peer = { name: string; page: Page; context: BrowserContext };
export const DESKTOP = { width: 1280, height: 820 };
export const PHONE = { width: 390, height: 844 };
/** What a peer's context may use by default: the invite flow copies and pastes. */
export const CLIPBOARD = ["clipboard-read", "clipboard-write"];
export const MEDIA = ["camera", "microphone", ...CLIPBOARD];

/**
 * A fixed-offset zone where it is about nine in the evening while the capture runs, so the
 * timestamps read like an evening among friends whenever the shots are taken. The clock itself is
 * never faked: every peer keeps real time.
 */
export const EVENING = (() => {
  const offset = ((21 - new Date().getUTCHours() + 36) % 24) - 12; // hours ahead of UTC, -12..11
  return offset === 0 ? "Etc/UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
})();

/** Someone in the story: the name their contacts see and the picture that goes with it. */
export type Person = { name: string; colors: readonly [string, string]; glyph: string };
export const CAST = {
  boo: { name: "Boo", colors: ["#8b5cf6", "#22d3ee"], glyph: "👻" },
  casper: { name: "Casper", colors: ["#14b8a6", "#a3e635"], glyph: "🕯️" },
  wendy: { name: "Wendy", colors: ["#f472b6", "#fb923c"], glyph: "🧙‍♀️" },
  spooky: { name: "Spooky", colors: ["#f97316", "#facc15"], glyph: "🎃" },
  mara: { name: "Mara", colors: ["#6366f1", "#38bdf8"], glyph: "🦉" },
  jules: { name: "Jules", colors: ["#22c55e", "#0ea5e9"], glyph: "🐈‍⬛" },
} as const satisfies Record<string, Person>;

/** The browser flags playwright.config.ts launches with, for the persistent profiles below. */
export const BROWSER_ARGS = [
  // Every peer is on this machine: let ICE use plain host addresses.
  "--disable-features=WebRtcHideLocalIpsWithMdns",
  // The calls ring with Chromium's fake camera and microphone, no prompt.
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  // The fake microphone plays the e2e suite's voice-like sample, so a voice message has a waveform.
  `--use-file-for-fake-audio-capture=${fileURLToPath(new URL("../../../e2e/support/voice-sample.wav", import.meta.url))}`,
  "--autoplay-policy=no-user-gesture-required",
];

/** A browser profile on disk: a person whose storage outlives one browser, reopened later on a phone with `open(..., { profile })`. */
export const newProfile = () => mkdtempSync(join(tmpdir(), "ghostly-capture-"));

/**
 * A person on the app: their own browser storage, the relay answering their Pkarr requests, the
 * test mint answered by the infra's mint, the public Mainnet wallet services refused (Testnet only
 * here, and a Mainnet wallet busy with a slow server would hold the switch to Testnet behind it).
 */
export async function open(browser: Browser, relay: LocalRelay, baseURL: string, name: string, { mobile = false, permissions = CLIPBOARD, profile }: { mobile?: boolean; permissions?: string[]; profile?: string } = {}): Promise<Peer> {
  const options = {
    baseURL, colorScheme: "dark", deviceScaleFactor: 2, locale: "en-US", timezoneId: EVENING,
    permissions,
    viewport: mobile ? PHONE : DESKTOP,
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  } as const;
  // A profile directory keeps everything the app stores (IndexedDB, OPFS, localStorage) between browsers.
  const context = profile
    ? await chromium.launchPersistentContext(profile, { ...options, headless: true, args: BROWSER_ARGS })
    : await browser.newContext(options);
  await relay.attach(context);
  await attachMint(context);
  for (const service of MAINNET_SERVICES) await context.route(service, (route) => route.abort("connectionrefused"));
  const page = context.pages()[0] ?? await context.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] ${e.message}`));
  await page.goto("/");
  await expect(page.getByTitle("New Chat").first()).toBeVisible();
  return { name, page, context };
}

export async function shot(p: Peer, file: string) {
  if (ONLY && !ONLY.some((o) => file.startsWith(o))) return;
  const vp = p.page.viewportSize()!;
  // Park the pointer where nothing reacts to it: no hover states, no tooltips.
  await p.page.mouse.move(vp.width > 600 ? vp.width - 4 : vp.width - 2, vp.height / 2);
  await p.page.waitForTimeout(800);
  await p.page.screenshot({ path: join(OUT, file) });
  console.log("  saved", file);
}

/** Go to a route of the app by its hash: works on the web and inside the extension's app.html alike. */
export const route = async (p: Peer, hash: string) => {
  await p.page.evaluate((h) => { location.hash = h; }, hash);
};

export const home = async (p: Peer) => {
  await route(p, "#/");
  await expect(p.page.getByTitle("New Chat").first()).toBeVisible();
};

/** A portrait: the person's glyph on a two-color disc, drawn on a canvas in their own page. */
export async function portrait(p: Peer, who: Person): Promise<Buffer> {
  const bytes = await p.page.evaluate(({ colors, glyph }) => {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const g = c.getContext("2d")!;
    const bg = g.createLinearGradient(0, 0, 256, 256); bg.addColorStop(0, colors[0]); bg.addColorStop(1, colors[1]);
    g.fillStyle = bg; g.fillRect(0, 0, 256, 256);
    const shine = g.createRadialGradient(80, 60, 10, 80, 60, 200); shine.addColorStop(0, "rgba(255,255,255,.35)"); shine.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = shine; g.fillRect(0, 0, 256, 256);
    g.font = "150px 'Apple Color Emoji', 'Noto Color Emoji'"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(glyph, 128, 144);
    return Array.from(atob(c.toDataURL("image/png").split(",")[1]), (ch) => ch.charCodeAt(0));
  }, { colors: who.colors, glyph: who.glyph });
  return Buffer.from(bytes);
}

/** Name and picture, set once on the Profile page: contacts get both when they pair. */
export async function dress(p: Peer, who: Person, profileName = who.name) {
  await route(p, "#/profile");
  await expect(p.page.getByTestId("profile-page")).toBeVisible();
  await p.page.getByTestId("profile-name").fill(profileName);
  await p.page.getByTestId("profile-name").press("Enter");
  await p.page.getByTestId("account-nickname").fill(who.name);
  await p.page.getByTestId("profile-avatar-input").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: await portrait(p, who) });
  await expect(p.page.getByTestId("profile-avatar-remove")).toBeVisible();
  await home(p);
}

/** A person on the app, dressed. */
export async function person(browser: Browser, relay: LocalRelay, baseURL: string, who: Person, options: Parameters<typeof open>[4] = {}) {
  const p = await open(browser, relay, baseURL, who.name, options);
  await dress(p, who);
  return p;
}

/** A little night scene for the file shot. */
export async function sceneImage(p: Peer): Promise<Buffer> {
  const bytes = await p.page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 960; c.height = 640;
    const g = c.getContext("2d")!;
    const sky = g.createLinearGradient(0, 0, 0, 640); sky.addColorStop(0, "#140f38"); sky.addColorStop(0.7, "#4b2a6b"); sky.addColorStop(1, "#6b3a5b");
    g.fillStyle = sky; g.fillRect(0, 0, 960, 640);
    for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(255,255,255,${0.3 + (i % 5) / 8})`; g.fillRect((i * 137) % 960, (i * 71) % 330, 2, 2); }
    const moon = g.createRadialGradient(740, 150, 10, 740, 150, 140); moon.addColorStop(0, "rgba(247,241,200,1)"); moon.addColorStop(0.45, "rgba(247,241,200,1)"); moon.addColorStop(0.5, "rgba(247,241,200,.25)"); moon.addColorStop(1, "rgba(247,241,200,0)");
    g.fillStyle = moon; g.beginPath(); g.arc(740, 150, 140, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#1a1030"; g.beginPath(); g.moveTo(0, 560); g.quadraticCurveTo(300, 470, 620, 540); g.quadraticCurveTo(820, 580, 960, 520); g.lineTo(960, 640); g.lineTo(0, 640); g.fill();
    g.fillStyle = "#0f0a20";
    g.fillRect(240, 330, 320, 260); g.beginPath(); g.moveTo(210, 336); g.lineTo(400, 190); g.lineTo(590, 336); g.fill();
    g.fillRect(480, 210, 40, 90);
    g.fillStyle = "#ffcf5a"; g.fillRect(290, 390, 56, 62); g.fillRect(454, 390, 56, 62); g.fillRect(372, 490, 56, 100);
    g.fillStyle = "#0b0718"; g.fillRect(0, 600, 960, 40);
    g.font = "120px 'Apple Color Emoji', 'Noto Color Emoji'"; g.fillText("👻", 640, 470);
    return Array.from(atob(c.toDataURL("image/jpeg", 0.9).split(",")[1]), (ch) => ch.charCodeAt(0));
  });
  return Buffer.from(bytes);
}

export async function say(p: Peer, text: string) {
  const box = p.page.getByPlaceholder("Message…");
  await expect(box).toBeEnabled();
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

/** The host makes an invite, the guest pastes it; `beforeJoin` runs while the invite card is up. Resolves with the host's chat route. */
export async function pair(host: Peer, guest: Peer, beforeJoin?: () => Promise<void>): Promise<string> {
  await home(host);
  await home(guest);
  await host.page.getByTitle("New Chat").first().click();
  await expect(host.page.getByTestId("invite-card")).toBeVisible();
  if (beforeJoin) await beforeJoin();
  const invite = await copyInvite(host.page);
  await guest.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(guest.page, invite);
  for (const p of [host, guest]) await expect(p.page.getByPlaceholder("Message…")).toBeEnabled({ timeout: 90_000 });
  // Live over WebRTC: receipts, names and pictures cross at once.
  for (const p of [host, guest]) {
    await expect(p.page.locator('[data-testid=connection-options][aria-label*="Connected · WebRTC"]')).toBeVisible({ timeout: 60_000 })
      .catch(() => console.log(`  [${p.name}] not live yet`));
  }
  // Each side shows the other's name by itself once the profiles have crossed.
  await expect(host.page.getByTitle("Click to set a name")).toHaveText(guest.name, { timeout: 30_000 }).catch(() => console.log(`  [${host.name}] still no name for ${guest.name}`));
  await expect(guest.page.getByTitle("Click to set a name")).toHaveText(host.name, { timeout: 30_000 }).catch(() => console.log(`  [${guest.name}] still no name for ${host.name}`));
  return host.page.evaluate(() => location.hash);
}

/** A voice message: the mic held for `ms` (the composer must be empty), then let go. */
export async function voice(p: Peer, ms = 4200) {
  const mic = p.page.getByTestId("voice-record");
  const box = (await mic.boundingBox())!;
  await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.page.mouse.down();
  await expect(p.page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
  await p.page.waitForTimeout(ms);
  await p.page.mouse.up();
  await expect(p.page.getByTestId("voice-bar")).toHaveCount(0);
}

/** One line of a conversation: who types it, and what. */
export type Line = readonly [speaker: Peer, text: string];
/** Each line is typed by its speaker and awaited on everyone else's screen. */
export async function converse(lines: readonly Line[], audience: readonly Peer[]) {
  for (const [from, text] of lines) {
    await say(from, text);
    for (const p of audience) if (p !== from) await expect(chat(p).getByText(text, { exact: true }).last()).toBeVisible({ timeout: 60_000 });
  }
}

/** Open a chat by its route (from `pair`), on either side. */
export const go = async (p: Peer, hash: string) => {
  await p.page.evaluate((h) => { location.hash = h; }, hash);
  await expect(p.page.getByPlaceholder("Message…")).toBeVisible();
};

/** Open the chat with `name` from the chat list. */
export async function openChatWith(p: Peer, name: string) {
  await home(p);
  await p.page.getByTestId("sidebar").getByText(name, { exact: true }).first().click();
  await expect(p.page.getByPlaceholder("Message…")).toBeVisible();
}

/**
 * Ghostly Browser (the built extension, extension/dist) in a Chromium profile of its own, the way
 * e2e/support/extension.ts opens it: the localhost permission granted up front (Chrome's prompt
 * cannot be clicked by automation) and the offscreen engine pointed at the test's relay.
 */
export async function openExtension(relay: LocalRelay, name: string): Promise<Peer & { dispose: () => void }> {
  const dist = join(REPO, "extension/dist");
  if (!existsSync(join(dist, "manifest.json"))) throw new Error("extension/dist is missing: run `npm run build:extension` first (npm run capture does)");
  const work = mkdtempSync(join(tmpdir(), "ghostly-capture-ext-"));
  const dir = join(work, "extension");
  cpSync(dist, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_host_permissions;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const context = await chromium.launchPersistentContext(join(work, "profile"), {
    channel: "chromium", headless: true, colorScheme: "dark", deviceScaleFactor: 2, locale: "en-US", timezoneId: EVENING,
    viewport: DESKTOP,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, ...BROWSER_ARGS],
  });
  // The update check is the one request that would leave this machine: answered with the running version.
  const version = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")).version;
  await context.route("https://ghostly.tools/latest.json", (route) => route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ version }) }));
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const page = context.pages()[0] ?? await context.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] ${e.message}`));
  await page.goto(`chrome-extension://${id}/app.html#/settings`);
  await page.getByTestId("network-relays").fill(await relay.listen());
  await page.getByTestId("network-save").click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.goto(`chrome-extension://${id}/app.html#/`);
  await expect(page.getByTitle("New Chat").first()).toBeVisible();
  return { name, page, context, dispose: () => rmSync(work, { recursive: true, force: true }) };
}
