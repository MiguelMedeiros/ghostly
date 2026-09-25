import type { Page } from "@playwright/test";
import { copyInvite } from "../support/clipboard";
import { chat, expect, link, say, test, type Peer } from "../support/fixtures";

/** Chats kept by this browser, counted the way the app stores them. */
const storedChats = (page: Page) =>
  page.evaluate(
    () =>
      Object.keys(localStorage).filter((key) => {
        try {
          const value = JSON.parse(localStorage.getItem(key) ?? "");
          return key.startsWith("ghostly_") && value?.mySeedB64 && value?.peerPubKeyB64;
        } catch {
          return false;
        }
      }).length,
  );

/** A new chat's invite: copied as its link on ghostly.tools; the code is the fragment. */
async function newInvite(host: Peer): Promise<{ link: string; code: string; secret: string }> {
  await host.page.getByTitle("New Chat").click();
  const link = await copyInvite(host.page);
  expect(link).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1p[02-9ac-hj-np-z]{211}$/);
  const code = link.split("#")[1];
  // Any stretch of the code carries key material: none of it may stay in an address.
  return { link, code, secret: code.slice(9, 60) };
}

/** A `ghostly1` code with one character changed: its checksum fails. */
const typo = (code: string) => code.slice(0, 40) + (code[40] === "q" ? "p" : "q") + code.slice(41);

/** Every address in this tab's history, walking back to the first and forward again. */
async function historyUrls(page: Page): Promise<string[]> {
  const length = await page.evaluate(() => history.length);
  const urls = [page.url()];
  for (let i = 1; i < length; i++) {
    await page.goBack();
    urls.push(page.url());
  }
  for (let i = 1; i < length; i++) await page.goForward();
  return urls;
}

test("an invite link loaded afresh stores the chat, and its keys leave the address bar and the history", { tag: ["@feature:invite.link", "@feature:chat.paired.pair", "@feature:chat.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  const { code, secret } = await newInvite(alice);

  // Bob follows the link from somewhere else: a fresh load of the app, as app.ghostly.tools/#ghostly1… is.
  await bob.page.goto("about:blank");
  await bob.page.goto(`/#${code}`);
  await expect(bob.page).toHaveURL(/#\/chat\/[0-9a-f]+$/);
  expect(bob.page.url()).not.toContain(secret);
  await expect.poll(() => storedChats(bob.page)).toBe(1);
  await expect(bob.page.getByTitle("Delete chat")).toHaveCount(1);

  const urls = await historyUrls(bob.page);
  expect(urls.length).toBeGreaterThanOrEqual(2);
  for (const url of urls) expect(url.toLowerCase()).not.toContain(secret);
  await expect(bob.page).toHaveURL(/#\/chat\/[0-9a-f]+$/);

  // The address it was given is the chat: it opens there, and it is a working chat.
  await bob.page.reload();
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
  for (const p of [alice, bob]) await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
  await say(bob, "came in through the link");
  await expect(chat(alice).getByText("came in through the link")).toBeVisible();
  await say(alice, "welcome in");
  await expect(chat(bob).getByText("welcome in")).toBeVisible();
  expect(await storedChats(bob.page)).toBe(1);
});

// The link is taken after the router listens, so a link opened in a new tab lands in its chat.
test("an invite link loaded afresh opens its chat at once", { tag: ["@feature:invite.link"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  const { code } = await newInvite(alice);
  await bob.page.goto("about:blank");
  // In capitals, as a QR code holds it.
  await bob.page.goto(`/#${code.toUpperCase()}`);
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
  await expect(bob.page).toHaveURL(/#\/chat\/[0-9a-f]+$/);
});

test("an invite link opened inside a running app is taken the same way", { tag: ["@feature:invite.link", "@feature:chat.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  const { code, secret } = await newInvite(alice);

  // Same document: only the fragment changes.
  await bob.page.evaluate((code) => (location.hash = code), code);
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
  await expect(bob.page).toHaveURL(/#\/chat\/[^/]+$/);
  for (const url of await historyUrls(bob.page)) expect(url).not.toContain(secret);
  const chatUrl = bob.page.url();

  // The same link again goes to the same chat: no second one. The older `#/chat/…` form still reads.
  await bob.page.goto("/#/");
  await bob.page.evaluate((code) => (location.hash = `/chat/${code}`), code);
  await expect(bob.page).toHaveURL(chatUrl);
  expect(await storedChats(bob.page)).toBe(1);
  await expect(bob.page.getByTitle("Delete chat")).toHaveCount(1);

  for (const p of [alice, bob]) await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
  await say(alice, "one chat, not two");
  await expect(chat(bob).getByText("one chat, not two")).toBeVisible();
});

test("a link that is not an invite creates nothing and ends on the home screen", { tag: ["@feature:invite.invalid", "@feature:invite.link"] }, async ({ peer }) => {
  const bob = await peer("bob");
  for (const bad of ["/chat/not-an-invite", "/chat/pair1", "/chat/%E2%98%A0", "/chat/..%2F..%2Fsettings", "ghostly1qqqqqq", "GHOSTLY1"]) {
    await bob.page.goto(`/#${bad}`);
    await expect(bob.page).toHaveURL(/#\/$/);
    await expect(bob.page.getByText("It's quiet here...")).toBeVisible();
  }
  expect(await storedChats(bob.page)).toBe(0);
  await expect(bob.page.getByTitle("Delete chat")).toHaveCount(0);
});

// A broken link says so, like the join dialog does.
test("a link that is not an invite says so, and a mistyped one says it has a typo", { tag: ["@feature:invite.invalid", "@feature:invite.code"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  const { code } = await newInvite(alice);
  for (const [fragment, message] of [
    ["/chat/not-an-invite", "This is not a Ghostly invite."],
    [typo(code), "This code has a typo. Check it, or ask for the code again."],
  ]) {
    await bob.page.goto("about:blank");
    await bob.page.goto(`/#${fragment}`);
    await expect(bob.page.getByTestId("invite-link-invalid")).toHaveText(message, { timeout: 10_000 });
  }
  expect(await storedChats(bob.page)).toBe(0);
});

// A damaged link is not a chat address either: it leaves the address and the history, keys and all.
test("a damaged invite link creates nothing and does not keep its keys in the address", { tag: ["@feature:invite.invalid", "@feature:invite.link"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  const { code, secret } = await newInvite(alice);
  const damaged = code.slice(0, -5);

  await bob.page.goto("about:blank");
  await bob.page.goto(`/#${damaged}`);
  await expect(bob.page.getByTitle("New Chat")).toBeVisible();
  await expect(bob.page).not.toHaveURL(new RegExp(secret));
  for (const url of await historyUrls(bob.page)) expect(url).not.toContain(secret);
  expect(await storedChats(bob.page)).toBe(0);
});

// Keys a stored chat already has, in another invite format, are refused without taking the app down.
test("the keys of a chat already here, in another invite format, do not take the app down", { tag: ["@feature:invite.invalid", "@feature:invite.link"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await bob.page.goto("/#/");
  const stored = await bob.page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? "");
        if (key.startsWith("ghostly_") && value?.mySeedB64) return value as { mySeedB64: string; peerPubKeyB64: string; encKeyB64: string };
      } catch {
        // not a chat
      }
    }
    return null;
  });
  expect(stored).not.toBeNull();
  // The same keys, without the `pair1/` prefix: a legacy invite.
  await bob.page.goto(`/#/chat/${stored!.mySeedB64}/${stored!.peerPubKeyB64}/${stored!.encKeyB64}`);
  await expect(bob.page.getByTitle("New Chat")).toBeVisible();
  await expect(bob.page).not.toHaveURL(new RegExp(stored!.mySeedB64));
  expect(await storedChats(bob.page)).toBe(1);
});
