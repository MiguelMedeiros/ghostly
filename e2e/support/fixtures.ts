import { copyInvite } from "./clipboard";
import { IMAGE_HOSTS, IMAGE_REDIRECTS } from "../../packages/browser/src/profiles/public";
import { pasteInvite } from "./clipboard";
import { createLink, encodeInviteCode } from "@ghostly/core";
import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { attachMint } from "./mint";
import { LocalRelay } from "./relay";

export { expect };

export interface Peer {
  name: string;
  context: BrowserContext;
  page: Page;
}

export interface PeerOptions {
  viewport?: { width: number; height: number };
  /** Emulates a phone: touch, mobile user agent, narrow viewport. */
  mobile?: boolean;
  /** Trusts any certificate, as a browser trusts a node's that a person has set up properly (self-hosted nodes in tests). */
  ignoreHTTPSErrors?: boolean;
  /** Talks to the public Pkarr relays themselves instead of the test's relay (measurements only: the suite stays offline). */
  realRelays?: boolean;
  /**
   * Refuses the public Mainnet services the automatic wallets reach on their own (see `MAINNET_SERVICES`), at once:
   * a test that moves test coins only then never waits on them — a Mainnet wallet still busy with a slow server
   * holds the switch to Testnet behind it.
   */
  offlineMainnet?: boolean;
  /**
   * Runs Iroh through this relay (the e2e infra's, `endpoints.irohRelay`). Without it the page's peer has no Iroh:
   * the suite stays offline, and a browser is WebRTC only, as most specs expect.
   */
  irohRelay?: string;
}

/**
 * The public hosts identity cards read public profiles from (PUBLIC-PROFILES.md): the Pubky index, Bluesky's AppView and
 * CDN, the Nostr picture hosts and the default Nostr relays. Load public profiles is on by default and a card on screen
 * asks, so every peer refuses them unless its test answers them itself: a route or relay added later takes precedence.
 */
const PICTURE_HOSTS = new Set([...IMAGE_HOSTS, ...Object.values(IMAGE_REDIRECTS).flatMap(to => [...to])]);
export const PUBLIC_PROFILE_HOSTS: (RegExp | ((url: URL) => boolean))[] = [/^https:\/\/nexus\.pubky\.app\//, /^https:\/\/public\.api\.bsky\.app\//, /^https:\/\/cdn\.bsky\.app\//,
  url => url.protocol === "https:" && PICTURE_HOSTS.has(url.hostname)];
export const DEFAULT_NOSTR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

export async function guardPublicProfiles(context: BrowserContext): Promise<void> {
  for (const host of PUBLIC_PROFILE_HOSTS) await context.route(host, route => route.abort("blockedbyclient"));
  await context.routeWebSocket(url => DEFAULT_NOSTR_RELAYS.some(relay => url.href.startsWith(relay)), ws => { void ws.close({ code: 1008, reason: "No public relay in the test suite" }); });
}

/** Where the Mainnet Ark and USDT wallets a new profile makes by itself go: the Ark server, its explorer, the Ethereum RPC. */
export const MAINNET_SERVICES = [/^https:\/\/arkade\.computer\//, /^https:\/\/mempool\.space\/api\//, /^https:\/\/ethereum\.publicnode\.com/];

type Fixtures = {
  /** Fails the test if any request got past the stubs to the real Internet Archive (see `guardArchive`). Automatic. */
  archiveGuard: void;
  relay: LocalRelay;
  /** Opens Ghostly on the web as a new person: its own browser storage, the same relay as everyone else in the test. */
  peer: (name: string, options?: PeerOptions) => Promise<Peer>;
};

export async function openPeer(browser: Browser, relay: LocalRelay, baseURL: string, name: string, options: PeerOptions = {}): Promise<Peer> {
  const context = await browser.newContext({
    baseURL,
    permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"],
    viewport: options.viewport ?? (options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }),
    ...(options.mobile ? { isMobile: true, hasTouch: true } : {}),
    ...(options.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
  });
  await guardArchive(context);
  await guardPublicProfiles(context);
  if (!options.realRelays) await relay.attach(context);
  await attachMint(context);
  await stubGifServices(context);
  if (options.offlineMainnet) for (const service of MAINNET_SERVICES) await context.route(service, (route) => route.abort("connectionrefused"));
  if (!options.irohRelay) await context.addInitScript(() => { try { localStorage.setItem("ghostly-test-iroh", "off"); } catch { /* opaque origin */ } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`  [${name}] ${error.message}`));
  await page.goto("/");
  await expect(page.getByTitle("New Chat")).toBeVisible();
  if (options.irohRelay) await setIrohRelay(page, options.irohRelay);
  return { name, context, page };
}

/** Points this peer's Iroh at `relay` (Settings → Network), before it has a chat to start an endpoint for. */
export async function setIrohRelay(page: Page, relay: string): Promise<void> {
  await page.goto("/#/settings");
  await page.getByTestId("network-iroh-relays").fill(relay);
  await page.getByTestId("network-save").click();
  await expect(page.getByTestId("network-saved")).toBeVisible();
  await page.goto("/#/");
  await expect(page.getByTitle("New Chat")).toBeVisible();
}

/** A 1×1 GIF. */
export const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

/** GifCities' search and the Wayback Machine that serves its GIFs. */
export const GIFCITIES = "https://gifcities.archive.org/**";
export const WAYBACK = "https://web.archive.org/**";

/** Requests that got past every stub to the real Internet Archive during this test. */
const archiveReached: string[] = [];

/**
 * The Internet Archive's last word in `context`: registered before the stubs, so it answers only what gets past them
 * (a spec that unroutes a stub, a route that falls back) and refuses it; the `archiveGuard` fixture then fails the test.
 * GifCities limits requests per IP, and our runs share the IPs Ghostly's own apps use: our tests helped exhaust it.
 */
export async function guardArchive(context: BrowserContext): Promise<void> {
  for (const host of [GIFCITIES, WAYBACK]) {
    await context.route(host, (route) => {
      archiveReached.push(route.request().url());
      return route.abort("blockedbyclient");
    });
  }
}

/** GifCities answering `rows` as it does: a JSON list of GeoCities GIFs. */
export const gifCitiesAnswer = (rows: { gif: string; checksum: string; url_text: string }[]) =>
  ({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(rows) });

/**
 * The page the Internet Archive answers with once an IP has asked too much: a 200 in HTML, not a 429. The real one has no
 * CORS header (2026-09-25), so a browser page never reads it; `route.abort("failed")` is what such a page sees. This one
 * can be read, as by a client CORS does not bind (Playwright would add the header to a fulfilled response anyway).
 */
export const GIFCITIES_RATE_LIMIT = {
  status: 200,
  contentType: "text/html",
  headers: { "access-control-allow-origin": "*" },
  body: "<!DOCTYPE html><html><head><title>Rate limit reached</title></head><body><h1>Rate limit reached</h1><p>You've reached the limit "
    + "for the number of requests that can be made in a short period of time. Please wait a moment and try again.</p></body></html>",
};

/** GifCities answers from here: one ghost, no network. */
async function stubGifServices(context: BrowserContext): Promise<void> {
  await context.route(GIFCITIES, (route) =>
    route.fulfill(gifCitiesAnswer([{ gif: "http://geocities.com/haunted/ghost.gif", checksum: "c1", url_text: "retro ghost" }])),
  );
  await context.route(WAYBACK, (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));
}

export const test = base.extend<Fixtures>({
  archiveGuard: [async ({}, use) => {
    archiveReached.length = 0;
    await use();
    expect(archiveReached.splice(0), "requests that got past the stubs to the real Internet Archive (GifCities limits requests per IP)").toEqual([]);
  }, { auto: true }],
  relay: async ({}, use) => {
    const relay = new LocalRelay();
    await use(relay);
    relay.close();
  },
  peer: async ({ browser, relay, baseURL }, use) => {
    const opened: Peer[] = [];
    await use(async (name, options) => {
      const peer = await openPeer(browser, relay, baseURL!, name, options);
      opened.push(peer);
      return peer;
    });
    for (const peer of opened) await peer.context.close().catch(() => {});
  },
});

/** `host` creates a chat, `guest` joins it with the invite code. Resolves once both have the chat open. */
export async function link(host: Peer, guest: Peer): Promise<void> {
  await host.page.getByTitle("New Chat").click();
  const invite = await copyInvite(host.page);
  await guest.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(guest.page, invite);
  await expect(guest.page.getByPlaceholder("Message…")).toBeVisible();
}

/**
 * Same, but the chat a legacy client can join. Sharing a local web app lives
 * only here for now: a paired link advertises `chat` and nothing else.
 */
export async function linkLegacy(host: Peer, guest: Peer): Promise<void> {
  // Historical session fixture: legacy creation is intentionally absent from the UI.
  const keys = createLink();
  const invite = encodeInviteCode(keys.invite);
  await host.page.evaluate(({ mine, invite }) => {
    const id = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages: [], createdAt: Date.now() }));
    localStorage.setItem(`ghostly_invite_${id}`, invite);
    window.dispatchEvent(new Event("session-updated"));
    location.hash = `/chat/${id}`;
  }, { mine: keys.mine, invite });
  await guest.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(guest.page, invite);
  await expect(guest.page.getByPlaceholder("Message…")).toBeVisible();
}

/**
 * DHT only, chosen in the chat's Connection menu. There is one kind of chat and one invite (WISP 400): the
 * choice is made in a chat, at any time, never in its invite.
 */
export async function chooseDhtOnly(page: Page): Promise<void> {
  await setDhtOnly(page, true);
}

/**
 * DHT only on or off, in the panel of the chat header's connection control: it is one of the connection choices.
 * Off leaves it for Automatic, or for the one transport a browser runs (which is Automatic there too).
 */
export async function setDhtOnly(page: Page, on: boolean): Promise<void> {
  if ((await page.getByTestId("connection-menu").getAttribute("open")) === null) await page.getByTestId("connection-options").click();
  const panel = page.getByRole("dialog", { name: "Connection options" });
  const choice = panel.getByRole("radio", { name: "DHT only", exact: true });
  const back = panel.getByRole("radio", { name: "Automatic", exact: true }).or(panel.getByRole("radio", { name: "WebRTC", exact: true })).first();
  if ((await choice.isChecked()) !== on) await (on ? choice : back).click();
  await expect.poll(() => choice.isChecked()).toBe(on);
  await page.keyboard.press("Escape");
}

/** The open conversation, without the chat list (which previews the last message too). */
export const chat = (peer: Peer) => peer.page.locator(".chat-wallpaper");

export type WalletKind = "cashu" | "lightning" | "arkade" | "bark" | "spark" | "usdt" | "bitcoin" | "fedimint";
export type WalletNetwork = "mainnet" | "testnet";
/** A wallet's card: `arkade-testnet`, or a kind alone for the first card of that kind (a test that has one of it). */
export type WalletCardName = WalletKind | `${WalletKind}-${WalletNetwork}`;

/** A card of the wallet page's deck, by its name (see `WalletCardName`). */
export const walletCard = (page: Page, card: WalletCardName): Locator =>
  card.includes("-") ? page.getByTestId(`wallet-card-${card}`) : page.locator(`[data-testid^="wallet-card-${card}-"]`).first();

/**
 * The Wallets page's tab of one network (Mainnet | Testnet): only that network's deck is on the page. Nothing to do
 * when it is chosen already, or when the page has no tabs (a profile with no wallet yet).
 */
export async function showNetwork(page: Page, network: WalletNetwork): Promise<void> {
  const tab = page.getByTestId(`wallet-network-${network}`);
  if (!await tab.count() || await tab.getAttribute("aria-selected") === "true") return;
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/**
 * The wallet is a page beside the chat list, like Settings: opening it puts the chat away. A card named with its
 * network is chosen on that network's tab; a kind alone, on whichever tab has one.
 */
export async function openWallet(peer: Peer, card?: WalletCardName): Promise<void> {
  const page = peer.page;
  if (!await page.getByTestId("wallet").isVisible()) await page.getByTestId("wallet-chip").click();
  if (!card) return;
  const network = card.split("-")[1] as WalletNetwork | undefined;
  if (network) await showNetwork(page, network);
  else if (!await walletCard(page, card).count()) {
    const other = await page.getByTestId("wallet-network-panel").getAttribute("data-network") === "mainnet" ? "testnet" : "mainnet";
    await showNetwork(page, other);
  }
  await walletCard(page, card).click();
}

export interface CreateWallet {
  /** Fedimint: the federation's invite code. */
  invite?: string;
  /** Lightning or on-chain: the source to pick (its id), and how to fill its form (the dialog's form area). */
  provider?: string;
  fill?: (form: Locator) => Promise<void>;
  /** How long its server may take to answer (the dialog then says it failed). */
  timeout?: number;
}

/**
 * Wallets → New → a network → a kind, as a person does: made in one click, checked by the app before its card
 * appears. A kind that needs one thing gets it (`invite`, or a source and its form). Nothing is done when the card
 * is there already. A failure fails the test with the dialog's own message.
 */
export async function createWallet(peer: Peer, kind: WalletKind, network: WalletNetwork = "testnet", options: CreateWallet = {}): Promise<void> {
  const page = peer.page;
  await openWallet(peer);
  await showNetwork(page, network);
  const card = page.getByTestId(`wallet-card-${kind}-${network}`);
  if (await card.count() && kind !== "fedimint") return;
  await page.getByTestId("wallet-add").click();
  const dialog = page.getByTestId("new-wallet");
  await dialog.getByRole("radio", { name: network === "testnet" ? "Testnet" : "Mainnet" }).click();
  await dialog.getByTestId(`new-wallet-type-${kind}`).click();
  if (options.invite !== undefined) {
    await dialog.getByTestId("new-wallet-invite").fill(options.invite);
    await dialog.getByTestId("new-wallet-create").click();
  }
  if (options.provider || options.fill) {
    const form = dialog.getByTestId("new-wallet-provider");
    const select = form.getByRole("combobox", { name: "Source" });
    if (options.provider && await select.count()) { await select.click(); await page.getByRole("option").and(page.locator(`[data-value="${options.provider}"]`)).click(); }
    await options.fill?.(form);
  }
  const error = dialog.getByTestId("new-wallet-error");
  await expect.poll(async () => await error.isVisible() ? `failed: ${await error.innerText()}` : await dialog.isVisible() ? "open" : "made", { timeout: options.timeout ?? 90_000 }).toBe("made");
  await expect(card).toBeVisible();
}

/** Wallets on test networks, made with New: Testnet Cashu (the public test mint, answered by the suite's own) unless others are named. */
export async function useTestnet(peer: Peer, kinds: WalletKind[] = ["cashu"]): Promise<void> {
  for (const kind of kinds) await createWallet(peer, kind, "testnet");
}

/** What one "Get test coins" press brings from the test mint (packages/browser engine TEST_COINS_SATS). */
export const TEST_COINS = 10_000;

/**
 * Test sats into a Testnet Cashu wallet, the way a person gets them: "Get test coins" on its details, which asks the
 * test mint (the suite's own mint answers for the public one and pays its own invoice). Receive never fills a wallet
 * by itself any more. Leaves the Cashu card open.
 */
export async function getTestCoins(peer: Peer): Promise<void> {
  await openWallet(peer, "cashu-testnet");
  await peer.page.getByTestId("test-coins-get").click();
  await expect(peer.page.getByTestId("test-coins-result")).toHaveText(`+${TEST_COINS.toLocaleString("en-US")} test sats`, { timeout: 60_000 });
}

/** The Profile page, from the account bar: its Profile place opens the account switcher, whose first entry is the page. */
export async function openProfilePage(page: Page): Promise<void> {
  await page.getByTestId("account-profile").click();
  await page.getByTestId("profile-switcher-current").click();
}


/**
 * The fake Lightning and on-chain providers (regtest, in memory, Testnet only) join the source pickers:
 * how a test drives a source without a node. The flag is read when the engine starts, hence the reload.
 */
export async function useFakeProviders(peer: Peer): Promise<void> {
  await peer.page.evaluate(() => localStorage.setItem("ghostly-test-providers", "1"));
  await peer.page.reload();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

/** Back from the wallet to the chat it was opened from. */
export async function openChat(peer: Peer): Promise<void> {
  if (await peer.page.getByTestId("wallet").isVisible()) await peer.page.goBack();
  await expect(chat(peer)).toBeVisible();
}

export async function say(peer: Peer, text: string): Promise<void> {
  const box = peer.page.getByPlaceholder("Message…");
  await box.fill(text);
  await box.press("Enter");
}

/** Both sides have seen each other's message and the WebRTC data link is up. */
export async function connect(a: Peer, b: Peer): Promise<void> {
  await say(b, `hello from ${b.name}`);
  await expect(chat(a).getByText(`hello from ${b.name}`)).toBeVisible();
  await say(a, `hello from ${a.name}`);
  await expect(chat(b).getByText(`hello from ${a.name}`)).toBeVisible();
  // A legacy chat says it in the strip, a paired one in the pairing banner.
  for (const peer of [a, b]) await expect(
    peer.page.getByTestId("datalink-state").filter({ hasText: "Peer to peer" })
      .or(peer.page.locator("[data-testid=connection-options][aria-label*=\"Connected · WebRTC\"]")),
  ).toBeVisible();
}
