import type { Page } from "@playwright/test";
import { chat, expect, openPeer, say, test, type Peer } from "../support/fixtures";
import { copyInvite, pasteInvite } from "../support/clipboard";

/**
 * The current app and a real v0.4.0 (WISP 402, "Compatibility Chat"). 0.5 never creates a legacy chat, but a
 * contact still on 0.4 can only make one: its prefix-less invite must open a compatibility chat here that works
 * both ways (legacy DHT text, then legacy WebRTC), and a ghostly1 invite, which 0.4 cannot read, must be refused
 * there without leaving anything behind.
 *
 * e2e/web/compat-chat.spec.ts covers the same chat with the 0.4 side played by a prefix-less session in the
 * current app; this one runs the old app itself, built from its tag (scripts/build-compat-web.mjs).
 */

/** v0.4.0, beside the current app (playwright.compat.config.ts serves it). */
async function oldPeer(browser: Parameters<typeof openPeer>[0], relay: Parameters<typeof openPeer>[1], name: string): Promise<Peer> {
  const url = test.info().config.metadata.compatURL as string;
  const peer = await openPeer(browser, relay, url, name);
  // The old app is the one we think it is.
  expect(await peer.page.evaluate(async () => (await (await fetch("/version.json")).json()) as { version: string })).toMatchObject({ version: "0.4.0" });
  return peer;
}

/** v0.4's chats, as its own chat list reads them from storage: every stored session with its three keys. */
const oldChats = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((key) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "") as Record<string, unknown>;
    return !!value && typeof value === "object" && !!value.id && !!value.mySeedB64 && !!value.peerPubKeyB64 && !!value.encKeyB64;
  } catch { return false; }
}).length);

/** v0.4's New Chat panel: paste a code into its field and press Enter, as its Paste button does with the clipboard. */
async function oldJoin(page: Page, code: string): Promise<void> {
  if (!await page.getByPlaceholder("Invite code...").isVisible()) await page.getByTitle("New Chat").click();
  await page.getByPlaceholder("Invite code...").fill(code);
  await page.getByPlaceholder("Invite code...").press("Enter");
}

async function oldSay(peer: Peer, text: string): Promise<void> {
  const box = peer.page.getByPlaceholder("Type a message");
  await box.fill(text);
  await box.press("Enter");
}

test("a v0.4.0 invite opens a compatibility chat that works both ways and continues in a new chat", {
  tag: ["@feature:chat.compat.v04", "@feature:chat.compat"],
}, async ({ browser, relay, peer }) => {
  const [olga, nina] = await Promise.all([oldPeer(browser, relay, "olga"), peer("nina")]);

  // v0.4 makes the chat and shows its invite: the three-part code, no prefix.
  await olga.page.getByRole("button", { name: "Create New Chat" }).click();
  const code = (await olga.page.locator(".chat-wallpaper code").innerText()).trim();
  expect(code).toMatch(/^[A-Za-z0-9_\-+=]+\/[A-Za-z0-9_\-+=]+\/[A-Za-z0-9_\-+=]+$/);

  // The current app opens it as a compatibility chat.
  await nina.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(nina.page, code);
  await expect(nina.page.getByPlaceholder("Message…")).toBeVisible();
  await expect(nina.page.getByTestId("compat-chat")).toHaveText("Compatibility chat · older Ghostly");

  // Texts both ways: the first ones over the legacy DHT text, while WebRTC comes up.
  await say(nina, "hello from the new app");
  await expect(chat(olga).getByText("hello from the new app", { exact: true })).toBeVisible({ timeout: 120_000 });
  await oldSay(olga, "hello from 0.4");
  await expect(chat(nina).getByText("hello from 0.4", { exact: true })).toBeVisible({ timeout: 120_000 });

  // The legacy WebRTC data link opens between them, and texts keep going both ways over it.
  await expect(nina.page.getByTestId("datalink-state")).toHaveText(/Peer to peer/, { timeout: 120_000 });
  await say(nina, "over the data link");
  await expect(chat(olga).getByText("over the data link", { exact: true })).toBeVisible();
  await oldSay(olga, "back over the data link");
  await expect(chat(nina).getByText("back over the data link", { exact: true })).toBeVisible();
  for (const text of ["hello from the new app", "hello from 0.4", "over the data link", "back over the data link"]) {
    for (const p of [olga, nina]) await expect(chat(p).getByText(text, { exact: true }), `${p.name} shows “${text}” once`).toHaveCount(1);
  }

  // Continue in a new chat: the current app moves on and sends the new invite inside the old chat.
  const old = nina.page.url();
  await nina.page.getByTestId("chat-options").click();
  await nina.page.getByTestId("chat-continue-new").click();
  await expect(nina.page.getByTestId("invite-card")).toBeVisible();

  // v0.4 gets it as a message that says what to do with it, and cannot open the code inside.
  const offer = chat(olga).getByText("Let's continue in a new chat", { exact: false });
  await expect(offer).toBeVisible({ timeout: 120_000 });
  await expect(offer).toContainText("Open this with an updated Ghostly");
  const next = /(ghostly1[0-9a-z]+)/i.exec(await offer.innerText())?.[1];
  expect(next, "the message carries a ghostly1 invite").toBeTruthy();
  const before = await oldChats(olga.page);
  await oldJoin(olga.page, next!);
  await expect(olga.page.getByText("Invalid invite code")).toBeVisible();
  expect(await oldChats(olga.page), "v0.4 made no chat of it").toBe(before);

  // The old chat stays readable on the current app, and points at the new one.
  await nina.page.goto(old);
  await expect(nina.page.getByTestId("compat-continued")).toBeVisible();
  await expect(chat(nina).getByText("hello from 0.4", { exact: true })).toBeVisible();
});

test("v0.4.0 refuses a ghostly1 invite and creates nothing", {
  tag: ["@feature:chat.compat.v04", "@feature:invite.code"],
}, async ({ browser, relay, peer }) => {
  const [olga, nina] = await Promise.all([oldPeer(browser, relay, "olga"), peer("nina")]);
  await nina.page.getByTitle("New Chat").click();
  const link = await copyInvite(nina.page);
  expect(link).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1p[0-9a-z]+$/);
  const code = link.slice(link.indexOf("#") + 1);

  // Neither the link nor the bare code: "Invalid invite code", no chat, still on the home screen.
  for (const attempt of [link, code, code.toUpperCase()]) {
    await oldJoin(olga.page, attempt);
    await expect(olga.page.getByText("Invalid invite code")).toBeVisible();
    expect(await oldChats(olga.page), `v0.4 made no chat of ${attempt.slice(0, 24)}…`).toBe(0);
    expect(new URL(olga.page.url()).hash).not.toMatch(/\/chat\//);
  }
});
