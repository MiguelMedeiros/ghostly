import { closeSync, openSync, ftruncateSync } from "node:fs";
import type { Page } from "@playwright/test";
import { createLink, decodeInviteCode, encodeInviteCode } from "@ghostly/core";
import { copyInvite } from "../support/clipboard";
import { chat, connect, expect, GIF, link, linkLegacy, say, test, type Peer } from "../support/fixtures";

/** The platform's file limit (packages/core/src/frames.ts LIMITS.maxFileBytes). */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** The rows of the chat list. */
const rows = (page: Page) => page.locator("div.group").filter({ has: page.getByTitle("Delete chat") });
/** The unread count on a row's avatar. */
const unreadBadge = (row: ReturnType<typeof rows>) => row.locator("span").filter({ hasText: /^(\d+|99\+)$/ });

/** A bubble, by the text in it. */
const bubble = (peer: Peer, text: string) => chat(peer).locator(".group").filter({ hasText: text });

/**
 * A legacy chat with nobody on the other end yet: its data link can never open,
 * so the composer stays on the DHT limits.
 */
async function lonelyLegacyChat(peer: Peer): Promise<void> {
  const keys = createLink();
  const invite = encodeInviteCode(keys.invite);
  await peer.page.evaluate(({ mine, invite }) => {
    const id = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages: [], createdAt: Date.now() }));
    localStorage.setItem(`ghostly_invite_${id}`, invite);
    window.dispatchEvent(new Event("session-updated"));
    location.hash = `/chat/${id}`;
  }, { mine: keys.mine, invite });
  await expect(peer.page.getByPlaceholder("Message…")).toBeEnabled();
}

test("the unread count shows what came in while away, and clears once the chat is opened", { tag: ["@feature:app.attention.unread"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Alice looks at something else.
  await alice.page.goto("/#/");
  const row = rows(alice.page);
  await expect(row).toHaveCount(1);
  await expect(unreadBadge(row)).toHaveCount(0);

  await say(bob, "first while you were out");
  await say(bob, "second while you were out");
  await expect(unreadBadge(row)).toHaveText("2");
  await expect(row).toContainText("second while you were out");

  await row.click();
  await expect(chat(alice).getByText("second while you were out")).toBeVisible();
  await expect(unreadBadge(row)).toHaveCount(0);
  // Read stays read.
  await alice.page.goto("/#/");
  await expect(row).toContainText("second while you were out");
  await expect(unreadBadge(row)).toHaveCount(0);
  await alice.page.reload();
  await expect(rows(alice.page)).toHaveCount(1);
  await expect(unreadBadge(rows(alice.page))).toHaveCount(0);

  // While the chat is on screen nothing counts as unread.
  await rows(alice.page).click();
  await say(bob, "while you watch");
  await expect(chat(alice).getByText("while you watch")).toBeVisible();
  await expect(unreadBadge(rows(alice.page))).toHaveCount(0);
});

test("naming a chat: Escape cancels the edit, leaving the field saves it", { tag: ["@feature:chats.list.rename"] }, async ({ peer }) => {
  const alice = await peer("alice");
  await alice.page.getByTitle("New Chat").click();
  await expect(alice.page.getByText("Invite your contact", { exact: true })).toBeVisible();
  const name = alice.page.getByTitle("Click to set a name");
  const field = alice.page.getByPlaceholder("Set a name...");
  await expect(name).toHaveText(/^Contact · \S{6}$/);

  await name.click();
  await field.fill("Not this one");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(name).toHaveText(/^Contact · \S{6}$/);
  await expect(rows(alice.page)).not.toContainText("Not this one");

  await name.click();
  await expect(field).toBeFocused();
  // Longer than the field takes: it keeps the first 30 characters.
  await field.pressSequentially("Haunted house on the hill, Salem");
  // Somewhere else in the chat: the field loses focus.
  await chat(alice).click({ position: { x: 20, y: 20 } });
  await expect(field).toHaveCount(0);
  await expect(name).toHaveText("Haunted house on the hill, Sal");
  await expect(rows(alice.page)).toContainText("Haunted house on the hill, Sal");

  await alice.page.reload();
  await expect(name).toHaveText("Haunted house on the hill, Sal");
  // Escape after a saved name keeps that name.
  await name.click();
  await field.fill("Something else");
  await field.press("Escape");
  await expect(name).toHaveText("Haunted house on the hill, Sal");
  await alice.page.reload();
  await expect(name).toHaveText("Haunted house on the hill, Sal");
});

test("a web address in a message is a link to a new tab that gets neither the opener nor the referrer", { tag: ["@feature:chat.paired.links"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  await alice.context.route("https://ghost.example.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>outside</title><p>outside</p>" }),
  );

  const url = "https://ghost.example.org/boo?x=1&y=2";
  await say(bob, `look at ${url} tonight`);
  const anchor = chat(alice).getByRole("link", { name: url });
  await expect(anchor).toHaveAttribute("href", url);
  await expect(anchor).toHaveAttribute("target", "_blank");
  const rel = (await anchor.getAttribute("rel"))!.split(/\s+/);
  expect(rel).toContain("noopener");
  expect(rel).toContain("noreferrer");
  // The words around it stay words.
  await expect(bubble(alice, url)).toContainText("look at");
  await expect(bubble(alice, url)).toContainText("tonight");

  const [tab] = await Promise.all([alice.context.waitForEvent("page"), anchor.click()]);
  await tab.waitForLoadState();
  expect(tab.url()).toBe(url);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  expect(await tab.evaluate(() => document.referrer)).toBe("");
  // Ghostly itself stays where it was.
  await expect(chat(alice).getByText("look at")).toBeVisible();
  await tab.close();
});

test("javascript:, data: and other non-web addresses never become links or pictures", { tag: ["@feature:chat.paired.links"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const dialogs: string[] = [];
  alice.page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  const hostile = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(2)",
    " javascript:alert(3)",
    "[click me](javascript:alert(4))",
    '<a href="javascript:alert(5)">click</a>',
    "data:text/html,<script>alert(6)</script>",
    "data:image/svg+xml,<svg onload=alert(7)>",
    "vbscript:msgbox(8)",
    "file:///etc/passwd",
    '<img src=x onerror="alert(9)">',
  ];
  for (const text of hostile) await say(bob, text);
  await say(bob, "end of the list");
  await expect(chat(alice).getByText("end of the list")).toBeVisible();

  for (const text of hostile) await expect(chat(alice).getByText(text.trim(), { exact: true })).toBeVisible();
  // Every link in the chat is a web address, and nothing was turned into markup.
  const hrefs = await chat(alice).locator("a").evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
  for (const href of hrefs) expect(href).toMatch(/^https?:\/\//);
  await expect(chat(alice).locator("a[href]:not([href^='http'])")).toHaveCount(0);
  await expect(chat(alice).locator("img[src^='javascript' i], img[src^='data:image/svg' i], img[src='x']")).toHaveCount(0);
  await expect(chat(alice).locator("script, iframe, object, embed")).toHaveCount(0);

  // Clicking the text of each does nothing either.
  for (const text of hostile.slice(0, 4)) await chat(alice).getByText(text.trim(), { exact: true }).click();
  await alice.page.waitForTimeout(500);
  expect(dialogs).toEqual([]);
  expect(alice.context.pages()).toHaveLength(1);
});

// A contact's picture tells its server this device's address when it loads: it waits for a click.
test("a picture address sent over https shows once asked for, and the server hears nothing before", { tag: ["@feature:chat.paired.image-links"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const fetched: string[] = [];
  await bob.context.route("https://img.example.org/**", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));
  await alice.context.route("https://img.example.org/**", (route) => {
    fetched.push(route.request().url());
    return route.request().url().endsWith("missing.png") ? route.fulfill({ status: 404, body: "" }) : route.fulfill({ status: 200, contentType: "image/gif", body: GIF });
  });

  const picture = "https://img.example.org/haunted/ghost.gif";
  await say(bob, picture);
  const reveal = chat(alice).getByTestId("image-reveal");
  await expect(reveal).toHaveText("Show picture · img.example.org");
  expect(fetched, "nothing is fetched before the click").toEqual([]);
  await reveal.click();
  const img = chat(alice).locator(`img[src="${picture}"]`);
  await expect(img).toBeVisible();
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  // The sender sees their own picture at once.
  await expect(chat(bob).locator(`img[src="${picture}"]`)).toBeVisible();
  // Only the address alone is a picture: in a sentence it stays a link.
  await say(bob, `see ${picture} here`);
  await expect(chat(alice).getByRole("link", { name: picture })).toBeVisible();
  await expect(chat(alice).locator(`img[src="${picture}"]`)).toHaveCount(1);

  // A picture that does not load falls back to its address as a link.
  await say(bob, "https://img.example.org/missing.png");
  await chat(alice).getByTestId("image-reveal").click();
  await expect(chat(alice).getByRole("link", { name: "https://img.example.org/missing.png" })).toBeVisible();
  await expect(chat(alice).locator('img[src="https://img.example.org/missing.png"]')).toHaveCount(0);
});

// A picture address over plain http is never embedded or fetched: it is only a link.
test("a picture address over plain http is not fetched", { tag: ["@feature:chat.paired.image-links"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const fetched: string[] = [];
  await alice.context.route("http://img.example.org/**", (route) => {
    fetched.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/gif", body: GIF });
  });
  await say(bob, "http://img.example.org/ghost.gif");
  await say(bob, "after the picture");
  await expect(chat(alice).getByText("after the picture")).toBeVisible();
  await expect(chat(alice).locator('img[src^="http://"]')).toHaveCount(0);
  expect(fetched).toEqual([]);
});

test("double-clicking a received message shows how it came, again hides it", { tag: ["@feature:chat.paired.message-details"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await linkLegacy(alice, bob);
  await connect(alice, bob);
  await say(bob, "inspect me");
  const received = bubble(alice, "inspect me");
  await expect(received).toBeVisible();
  await expect(received).not.toContainText("inbound");

  await received.getByText("inspect me").dblclick();
  for (const field of ["id:", "ts:", "dir:", "ack:", "dht:", "dns:", "enc:"]) await expect(received.getByText(field, { exact: true })).toBeVisible();
  await expect(received).toContainText("inbound");
  await expect(received).toContainText("N/A");
  await expect(received).toContainText("NaCl secretbox");
  // Other messages keep theirs to themselves.
  await expect(chat(alice).getByText("dir:", { exact: true })).toHaveCount(1);

  await received.getByText("inspect me").dblclick();
  await expect(received).not.toContainText("inbound");
  await expect(chat(alice).getByText("dir:", { exact: true })).toHaveCount(0);
});

test("a legacy chat before its data link: an overlong text is refused and the draft is kept", { tag: ["@feature:chat.legacy.limits"] }, async ({ peer }) => {
  const alice = await peer("alice");
  await lonelyLegacyChat(alice);
  const box = alice.page.getByPlaceholder("Message…");

  // Over the DHT's 500 bytes: fits the box, refused on send.
  const long = `boo ${"x".repeat(600)}`;
  await box.fill(long);
  await box.press("Enter");
  await expect(alice.page.getByRole("alert")).toContainText(/too large for DHT \(604 bytes, max 500\)/);
  await expect(box).toHaveValue(long);

  // Far over anything the box takes: refused on paste, and what was there stays.
  await box.fill("my draft");
  await box.fill("y".repeat(20_000));
  await expect(alice.page.getByRole("alert")).toContainText("That is too long for the DHT");
  await expect(box).toHaveValue("my draft");
  await alice.page.reload();
  await expect(box).toHaveValue("my draft");

  // Under the limit it goes.
  await box.fill("short enough");
  await box.press("Enter");
  await expect(chat(alice).getByText("short enough")).toBeVisible();
  await expect(box).toHaveValue("");
});

// A refused text is not kept: no bubble that never left, and no duplicate when the draft is sent again.
test("a legacy chat before its data link: a refused text leaves no bubble behind", { tag: ["@feature:chat.legacy.limits"] }, async ({ peer }) => {
  const alice = await peer("alice");
  await lonelyLegacyChat(alice);
  const box = alice.page.getByPlaceholder("Message…");
  const long = `boo ${"x".repeat(600)}`;
  await box.fill(long);
  await box.press("Enter");
  await expect(alice.page.getByRole("alert")).toContainText("too large for DHT");
  await expect(chat(alice).getByText(long)).toHaveCount(0);
  await alice.page.reload();
  await expect(chat(alice).getByText(long)).toHaveCount(0);
});

test("a file over the platform's limit is refused before anything is sent", { tag: ["@feature:files.size-limit"] }, async ({ peer }, testInfo) => {
  const alice = await peer("alice");
  await lonelyLegacyChat(alice);
  // A sparse file: 100 MB + 1 byte on paper, nothing on disk.
  const path = testInfo.outputPath("too big.bin");
  const fd = openSync(path, "w");
  ftruncateSync(fd, MAX_FILE_BYTES + 1);
  closeSync(fd);

  await alice.page.getByTestId("file-input").setInputFiles(path);
  await expect(alice.page.getByRole("alert")).toContainText("That file is too large (max 100.0 MB).");
  await expect(alice.page.getByTestId("file-bubble")).toHaveCount(0);
  // The composer is still usable, and the same file can be picked again.
  await alice.page.getByTestId("file-input").setInputFiles(path);
  await expect(alice.page.getByRole("alert")).toContainText("too large");
  await expect(alice.page.getByTestId("file-bubble")).toHaveCount(0);
});

test("Tech Info copies the keys it shows, and shows only a preview of the encryption key", { tag: ["@feature:app.tech-info"] }, async ({ peer }) => {
  const alice = await peer("alice");
  await alice.page.getByTitle("New Chat").click();
  const invite = await copyInvite(alice.page);
  // The invite is a ghostly1 link (WISP 801): its payload carries the chat's encryption key.
  const encKey = decodeInviteCode(invite)!.encKeyB64;
  expect(encKey).toHaveLength(43);
  const sessionId = decodeURIComponent(alice.page.url().split("#/chat/")[1]);

  await alice.page.getByTestId("chat-options").click();
  await alice.page.getByTestId("chat-options-menu").getByText("Tech Info").click();
  const modal = alice.page.locator("div.fixed").filter({ has: alice.page.getByRole("heading", { name: "Tech Info" }) });
  await expect(modal).toBeVisible();

  const row = (label: string) => modal.locator("div.flex.justify-between").filter({ has: alice.page.getByText(label, { exact: true }) });
  await expect(row("Session ID").getByRole("button")).toHaveText(sessionId);
  for (const label of ["Session ID", "My Key", "Peer Key"]) {
    const button = row(label).getByTitle("Click to copy");
    const value = (await button.textContent())!;
    expect(value.length).toBeGreaterThan(10);
    await button.click();
    await expect(button).toHaveText("Copied!");
    expect(await alice.page.evaluate(() => navigator.clipboard.readText())).toBe(value);
    await expect(button).toHaveText(value);
  }

  // The encryption key: a preview, no copy button, never the whole key.
  await expect(row("Enc Key").getByRole("button")).toHaveCount(0);
  await expect(row("Enc Key")).toContainText(`${encKey.slice(0, 8)}...${encKey.slice(-4)}`);
  expect(await modal.textContent()).not.toContain(encKey);

  // The close button in its header.
  await modal.getByRole("button").first().click();
  await expect(modal).toHaveCount(0);
});
