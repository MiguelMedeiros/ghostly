import { copyInvite } from "./clipboard";
import { pasteInvite } from "./clipboard";
import { createLink, encodeInviteCode } from "@ghostly/core";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
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
}

type Fixtures = {
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
  await relay.attach(context);
  await attachMint(context);
  await stubGifServices(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`  [${name}] ${error.message}`));
  await page.goto("/");
  await expect(page.getByTitle("New Chat")).toBeVisible();
  return { name, context, page };
}

/** A 1×1 GIF. */
export const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

/** GIFCities answers from here: one ghost, no network. */
async function stubGifServices(context: BrowserContext): Promise<void> {
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  await context.route("https://gifcities.archive.org/**", (route) =>
    route.fulfill(json([{ gif: "http://geocities.com/haunted/ghost.gif", checksum: "c1", url_text: "retro ghost" }])),
  );
  for (const host of ["https://web.archive.org/**"]) {
    await context.route(host, (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));
  }
}

export const test = base.extend<Fixtures>({
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

/** The open conversation, without the chat list (which previews the last message too). */
export const chat = (peer: Peer) => peer.page.locator(".chat-wallpaper");

/** The wallet is a page beside the chat list, like Settings: opening it puts the chat away. */
export async function openWallet(peer: Peer, card?: "cashu" | "lightning" | "arkade" | "bark" | "usdt" | "bitcoin"): Promise<void> {
  if (!await peer.page.getByTestId("wallet").isVisible()) await peer.page.getByTestId("wallet-chip").click();
  if (card) await peer.page.getByTestId(`wallet-card-${card}`).click();
}

/** Every wallet on test networks (the Testnet mode): test sats only, and the app says so everywhere. */
export async function useTestnet(peer: Peer): Promise<void> {
  await openWallet(peer);
  await peer.page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
  await expect(peer.page.getByTestId("testnet-notice")).toBeVisible();
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
